/**
 * ChatViewProvider — owns the sidebar webview, routes messages
 * between the webview UI and the Claude SDK, captures editor context.
 */

import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import { runQuery, buildSystemPrompt, type StreamEvent } from './claudeClient'

interface SelectionPayload {
  text: string
  filePath: string
  startLine: number
  endLine: number
  language: string
}

interface WebviewMessage {
  type: string
  payload?: any
}

const SESSION_STATE_KEY = 'rtlClaude.sdkSessionId'
const MESSAGES_STATE_KEY = 'rtlClaude.messages'
const MAX_PERSISTED_MESSAGES = 200

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'rtl-claude.chat'

  private view: vscode.WebviewView | null = null
  private currentAbortController: AbortController | null = null
  private pendingSelection: SelectionPayload | null = null

  constructor(private readonly context: vscode.ExtensionContext) {}

  public resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(this.context.extensionPath, 'media')),
      ],
    }

    webviewView.webview.html = this.getHtml(webviewView.webview)

    webviewView.webview.onDidReceiveMessage((msg: WebviewMessage) =>
      this.handleMessage(msg)
    )

    // When the view becomes visible, push any pending selection
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible && this.pendingSelection) {
        this.postToWebview({
          type: 'injectSelection',
          payload: this.pendingSelection,
        })
        this.pendingSelection = null
      }
    })
  }

  /**
   * Public API: start a new conversation (clears session id).
   */
  public newConversation() {
    this.context.workspaceState.update(SESSION_STATE_KEY, undefined)
    this.context.workspaceState.update(MESSAGES_STATE_KEY, undefined)
    this.postToWebview({ type: 'clear' })
  }

  /**
   * Public API: inject a selection from the editor into the chat input.
   */
  public sendSelectionToChat(selection: SelectionPayload) {
    if (this.view?.visible) {
      this.postToWebview({ type: 'injectSelection', payload: selection })
    } else {
      this.pendingSelection = selection
      // The view will pick it up via onDidChangeVisibility
    }
  }

  // ─── Message handling ─────────────────────────────────────────────

  private async handleMessage(msg: WebviewMessage) {
    switch (msg.type) {
      case 'sendMessage':
        await this.handleSendMessage(msg.payload?.text || '')
        break

      case 'cancel':
        this.currentAbortController?.abort()
        break

      case 'newConversation':
        this.newConversation()
        break

      case 'openFile':
        await this.openFile(msg.payload?.path, msg.payload?.line)
        break

      case 'getActiveContext':
        this.sendActiveContextToWebview()
        break

      case 'ready': {
        // Webview is loaded — push initial state + saved messages
        const savedMessages =
          this.context.workspaceState.get<any[]>(MESSAGES_STATE_KEY) || []
        this.postToWebview({
          type: 'init',
          payload: {
            workspaceName:
              vscode.workspace.workspaceFolders?.[0]?.name || 'No workspace',
            hasSession: Boolean(
              this.context.workspaceState.get(SESSION_STATE_KEY)
            ),
            messages: savedMessages,
          },
        })
        // If a selection was queued before the webview was ready
        if (this.pendingSelection) {
          this.postToWebview({
            type: 'injectSelection',
            payload: this.pendingSelection,
          })
          this.pendingSelection = null
        }
        break
      }

      case 'persistMessages': {
        // Webview sends full messages array after each turn completes
        const msgs = Array.isArray(msg.payload?.messages)
          ? msg.payload.messages
          : []
        // Cap history to prevent state bloat
        const capped = msgs.slice(-MAX_PERSISTED_MESSAGES)
        await this.context.workspaceState.update(MESSAGES_STATE_KEY, capped)
        break
      }
    }
  }

  private async handleSendMessage(text: string) {
    if (!text.trim()) return

    const workspaceRoot =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd()

    const config = vscode.workspace.getConfiguration('rtlClaude')
    const model = config.get<string>('model', 'claude-opus-4-6')
    const maxTurns = config.get<number>('maxTurns', 50)
    const includeActiveFile = config.get<boolean>('includeActiveFile', true)

    // Build the prompt with optional active file context
    let prompt = text
    if (includeActiveFile) {
      const editor = vscode.window.activeTextEditor
      if (editor && !editor.document.isUntitled) {
        const relPath = vscode.workspace.asRelativePath(editor.document.uri)
        prompt = `[הקובץ הפתוח כרגע: ${relPath}]\n\n${text}`
      }
    }

    const resumeSessionId =
      this.context.workspaceState.get<string>(SESSION_STATE_KEY) || null

    this.currentAbortController = new AbortController()

    this.postToWebview({ type: 'streamStart' })

    try {
      const generator = runQuery({
        prompt,
        systemPrompt: buildSystemPrompt(workspaceRoot),
        cwd: workspaceRoot,
        resumeSessionId,
        model,
        maxTurns,
        signal: this.currentAbortController.signal,
      })

      for await (const event of generator) {
        // Persist session id for conversation continuity
        if (event.type === 'session') {
          await this.context.workspaceState.update(
            SESSION_STATE_KEY,
            event.sessionId
          )
        }

        this.postToWebview({ type: 'streamEvent', payload: event })

        if (event.type === 'done' || event.type === 'error') {
          break
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.postToWebview({
        type: 'streamEvent',
        payload: { type: 'error', message: msg } satisfies StreamEvent,
      })
    } finally {
      this.postToWebview({ type: 'streamEnd' })
      this.currentAbortController = null
    }
  }

  private async openFile(filePath: string, line?: number) {
    if (!filePath) return

    const workspaceRoot =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ''

    // Resolve relative paths against workspace root
    const absPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(workspaceRoot, filePath)

    try {
      const uri = vscode.Uri.file(absPath)
      const doc = await vscode.workspace.openTextDocument(uri)
      const editor = await vscode.window.showTextDocument(doc, {
        preview: false,
        viewColumn: vscode.ViewColumn.One,
      })

      if (typeof line === 'number' && line > 0) {
        const pos = new vscode.Position(line - 1, 0)
        editor.selection = new vscode.Selection(pos, pos)
        editor.revealRange(
          new vscode.Range(pos, pos),
          vscode.TextEditorRevealType.InCenter
        )
      }
    } catch (err) {
      vscode.window.showWarningMessage(`לא הצלחתי לפתוח: ${filePath}`)
    }
  }

  private sendActiveContextToWebview() {
    const editor = vscode.window.activeTextEditor
    if (!editor) {
      this.postToWebview({ type: 'activeContext', payload: null })
      return
    }

    const filePath = vscode.workspace.asRelativePath(editor.document.uri)
    const hasSelection = !editor.selection.isEmpty
    let selectionInfo = null
    if (hasSelection) {
      selectionInfo = {
        text: editor.document.getText(editor.selection),
        startLine: editor.selection.start.line + 1,
        endLine: editor.selection.end.line + 1,
        language: editor.document.languageId,
      }
    }

    this.postToWebview({
      type: 'activeContext',
      payload: {
        filePath,
        language: editor.document.languageId,
        selection: selectionInfo,
      },
    })
  }

  private postToWebview(msg: any) {
    this.view?.webview.postMessage(msg)
  }

  // ─── HTML ────────────────────────────────────────────────────────

  private getHtml(webview: vscode.Webview): string {
    const mediaPath = path.join(this.context.extensionPath, 'media')
    const htmlPath = path.join(mediaPath, 'chat.html')

    let html = fs.readFileSync(htmlPath, 'utf8')

    // Build URIs for static assets
    const cssUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(mediaPath, 'chat.css'))
    )
    const jsUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(mediaPath, 'chat.js'))
    )
    const markedUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(mediaPath, 'marked.min.js'))
    )

    const nonce = this.getNonce()
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource} 'nonce-${nonce}'`,
      `font-src ${webview.cspSource} data:`,
      `img-src ${webview.cspSource} https: data:`,
    ].join('; ')

    html = html
      .replace(/\{\{cspSource\}\}/g, webview.cspSource)
      .replace(/\{\{csp\}\}/g, csp)
      .replace(/\{\{nonce\}\}/g, nonce)
      .replace(/\{\{cssUri\}\}/g, cssUri.toString())
      .replace(/\{\{jsUri\}\}/g, jsUri.toString())
      .replace(/\{\{markedUri\}\}/g, markedUri.toString())

    return html
  }

  private getNonce(): string {
    let text = ''
    const chars =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    for (let i = 0; i < 32; i++) {
      text += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    return text
  }
}
