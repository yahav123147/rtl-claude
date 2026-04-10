/**
 * ChatViewProvider — owns the sidebar webview, manages multiple conversations,
 * routes messages between the webview UI and the Claude SDK.
 */

import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import {
  runQuery,
  buildSystemPrompt,
  loadProjectContext,
  loadMcpServers,
  type StreamEvent,
} from './claudeClient'

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

interface PersistedMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  tools: Array<{
    id: string
    tool: string
    input: unknown
    result?: string
    isError?: boolean
  }>
}

interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
}

interface Conversation {
  id: string
  title: string
  sdkSessionId: string | null
  messages: PersistedMessage[]
  createdAt: number
  updatedAt: number
  usage?: TokenUsage
}

// Storage keys
const CONVERSATIONS_KEY = 'rtlClaude.conversations'
const ACTIVE_CONVERSATION_KEY = 'rtlClaude.activeConversationId'

// Legacy keys (single-conversation era) — migrated on first load
const LEGACY_SESSION_KEY = 'rtlClaude.sdkSessionId'
const LEGACY_MESSAGES_KEY = 'rtlClaude.messages'

const MAX_PERSISTED_MESSAGES = 200
const MAX_CONVERSATIONS = 50
const DEFAULT_TITLE = 'שיחה חדשה'

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'rtl-claude.chat'

  private view: vscode.WebviewView | null = null
  private currentAbortController: AbortController | null = null
  private pendingSelection: SelectionPayload | null = null

  constructor(private readonly context: vscode.ExtensionContext) {
    this.migrateLegacyState()
  }

  // ─── Public API ────────────────────────────────────────────────

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
   * Public API: create a new conversation and switch to it.
   * Called by the rtl-claude.newConversation command.
   */
  public newConversation() {
    const newConv = this.createConversation()
    this.setActiveConversation(newConv.id)
    this.broadcastConversationsUpdated()
    this.postToWebview({
      type: 'loadConversation',
      payload: { activeId: newConv.id, messages: [], usage: null },
    })
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

  // ─── Conversation storage ──────────────────────────────────────

  private getConversations(): Conversation[] {
    return (
      this.context.workspaceState.get<Conversation[]>(CONVERSATIONS_KEY) || []
    )
  }

  private async saveConversations(convs: Conversation[]): Promise<void> {
    // Keep only the most recent MAX_CONVERSATIONS, sorted by updatedAt desc
    const sorted = [...convs].sort((a, b) => b.updatedAt - a.updatedAt)
    const capped = sorted.slice(0, MAX_CONVERSATIONS)
    await this.context.workspaceState.update(CONVERSATIONS_KEY, capped)
  }

  private getActiveConversationId(): string | null {
    return (
      this.context.workspaceState.get<string>(ACTIVE_CONVERSATION_KEY) || null
    )
  }

  private async setActiveConversation(id: string | null): Promise<void> {
    await this.context.workspaceState.update(ACTIVE_CONVERSATION_KEY, id)
  }

  private getActiveConversation(): Conversation | null {
    const id = this.getActiveConversationId()
    if (!id) return null
    return this.getConversations().find((c) => c.id === id) || null
  }

  /**
   * Ensures there's always at least one conversation; creates one if not.
   * Returns the conversation that should be active.
   */
  private ensureActiveConversation(): Conversation {
    let active = this.getActiveConversation()
    if (active) return active

    // Pick the most recently updated, or create a new one
    const all = this.getConversations()
    if (all.length > 0) {
      active = [...all].sort((a, b) => b.updatedAt - a.updatedAt)[0]
      this.setActiveConversation(active.id)
      return active
    }

    return this.createConversation()
  }

  private createConversation(): Conversation {
    const now = Date.now()
    const conv: Conversation = {
      id: this.generateId(),
      title: DEFAULT_TITLE,
      sdkSessionId: null,
      messages: [],
      createdAt: now,
      updatedAt: now,
    }
    const all = this.getConversations()
    all.unshift(conv)
    this.saveConversations(all)
    this.setActiveConversation(conv.id)
    return conv
  }

  private async deleteConversation(id: string): Promise<void> {
    const all = this.getConversations().filter((c) => c.id !== id)
    await this.saveConversations(all)

    // If we deleted the active one, switch to another (or create new)
    if (this.getActiveConversationId() === id) {
      if (all.length > 0) {
        await this.setActiveConversation(all[0].id)
      } else {
        const fresh = this.createConversation()
        await this.setActiveConversation(fresh.id)
      }
    }
  }

  private async updateConversation(
    id: string,
    patch: Partial<Conversation>
  ): Promise<void> {
    const all = this.getConversations()
    const idx = all.findIndex((c) => c.id === id)
    if (idx === -1) return
    all[idx] = { ...all[idx], ...patch, updatedAt: Date.now() }
    await this.saveConversations(all)
  }

  // ─── Migration ─────────────────────────────────────────────────

  private migrateLegacyState() {
    const existing = this.context.workspaceState.get<Conversation[]>(
      CONVERSATIONS_KEY
    )
    if (existing && existing.length > 0) return // Already migrated

    const legacyMessages =
      this.context.workspaceState.get<PersistedMessage[]>(LEGACY_MESSAGES_KEY) ||
      []
    const legacySessionId =
      this.context.workspaceState.get<string>(LEGACY_SESSION_KEY) || null

    if (legacyMessages.length === 0 && !legacySessionId) {
      // Nothing to migrate
      return
    }

    const now = Date.now()
    const conv: Conversation = {
      id: this.generateId(),
      title: this.generateTitle(legacyMessages) || DEFAULT_TITLE,
      sdkSessionId: legacySessionId,
      messages: legacyMessages,
      createdAt: now,
      updatedAt: now,
    }

    this.context.workspaceState.update(CONVERSATIONS_KEY, [conv])
    this.context.workspaceState.update(ACTIVE_CONVERSATION_KEY, conv.id)

    // Clean up legacy keys
    this.context.workspaceState.update(LEGACY_SESSION_KEY, undefined)
    this.context.workspaceState.update(LEGACY_MESSAGES_KEY, undefined)

    console.log('[RTL Claude] Migrated legacy state to multi-conversation')
  }

  private generateTitle(messages: PersistedMessage[]): string {
    const firstUser = messages.find((m) => m.role === 'user')
    if (!firstUser) return DEFAULT_TITLE
    // Strip the leading "[הקובץ הפתוח כרגע: ...]" context line if present
    let text = firstUser.text.replace(/^\[הקובץ הפתוח כרגע:[^\]]+\]\n+/, '')
    // Strip code blocks (selection chips)
    text = text.replace(/```[\s\S]*?```/g, '').trim()
    // Take first line, cap to 40 chars
    const firstLine = text.split('\n')[0].trim()
    if (!firstLine) return DEFAULT_TITLE
    return firstLine.length > 40 ? firstLine.slice(0, 40) + '…' : firstLine
  }

  private generateId(): string {
    return (
      Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
    )
  }

  // ─── Webview message routing ───────────────────────────────────

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

      case 'switchConversation':
        await this.handleSwitchConversation(msg.payload?.id)
        break

      case 'deleteConversation':
        await this.handleDeleteConversation(msg.payload?.id)
        break

      case 'openFile':
        await this.openFile(msg.payload?.path, msg.payload?.line)
        break

      case 'uploadImage': {
        const dataUrl = msg.payload?.dataUrl
        if (typeof dataUrl !== 'string') return
        try {
          const tempPath = await this.saveTempImage(dataUrl)
          this.postToWebview({
            type: 'imageSaved',
            payload: { path: tempPath, id: msg.payload?.id || null },
          })
        } catch (e) {
          console.error('[RTL Claude] Failed to save image:', e)
          this.postToWebview({
            type: 'streamEvent',
            payload: {
              type: 'error',
              message: `שגיאה בשמירת תמונה: ${e instanceof Error ? e.message : String(e)}`,
            },
          })
        }
        break
      }

      case 'openSettings': {
        // Open VS Code settings filtered to our extension
        await vscode.commands.executeCommand(
          'workbench.action.openSettings',
          '@ext:yhbrwbyn.rtl-claude'
        )
        break
      }

      case 'updateSetting': {
        // Update a single VS Code setting from the in-extension panel
        const key = msg.payload?.key
        const value = msg.payload?.value
        if (typeof key !== 'string') return
        const config = vscode.workspace.getConfiguration('rtlClaude')
        try {
          await config.update(
            key,
            value,
            vscode.ConfigurationTarget.Global
          )
        } catch (e) {
          console.error('[RTL Claude] updateSetting failed:', e)
        }
        // Push fresh settings back so UI stays in sync
        this.pushSettingsState()
        break
      }

      case 'fuzzySearchFiles': {
        const query = String(msg.payload?.query || '')
        const results = await this.fuzzySearchFiles(query)
        this.postToWebview({
          type: 'fileSearchResults',
          payload: { query, results },
        })
        break
      }

      case 'searchConversations': {
        const query = String(msg.payload?.query || '')
        const results = this.searchConversations(query)
        this.postToWebview({
          type: 'conversationSearchResults',
          payload: { query, results },
        })
        break
      }

      case 'applyCodeToFile': {
        const filePath = msg.payload?.filePath
        const code = msg.payload?.code
        if (typeof filePath !== 'string' || typeof code !== 'string') return
        await this.applyCodeToFile(filePath, code)
        break
      }

      case 'insertCodeAtCursor': {
        const code = msg.payload?.code
        if (typeof code !== 'string') return
        await this.insertCodeAtCursor(code)
        break
      }

      case 'ready': {
        // Webview is loaded — push initial state
        const active = this.ensureActiveConversation()
        const workspaceRoot =
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd()
        const projectContext = loadProjectContext(workspaceRoot)
        const mcpServers = loadMcpServers(workspaceRoot)

        this.postToWebview({
          type: 'init',
          payload: {
            workspaceName:
              vscode.workspace.workspaceFolders?.[0]?.name || 'No workspace',
            activeId: active.id,
            messages: active.messages,
            conversations: this.summarizeConversations(),
            usage: active.usage || null,
            settings: this.getSettingsSnapshot(),
            context: {
              hasClaudeMd: Boolean(projectContext.claudeMd),
              hasMemory: Boolean(projectContext.memoryIndex),
              memoryFileCount: projectContext.memoryFileCount,
              mcpServerCount: Object.keys(mcpServers).length,
              mcpServerNames: Object.keys(mcpServers),
            },
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
        const msgs: PersistedMessage[] = Array.isArray(msg.payload?.messages)
          ? msg.payload.messages
          : []
        // Cap history to prevent state bloat
        const capped = msgs.slice(-MAX_PERSISTED_MESSAGES)

        const active = this.getActiveConversation()
        if (!active) return

        // Generate title from first user message if still default
        let title = active.title
        if (title === DEFAULT_TITLE && capped.length > 0) {
          title = this.generateTitle(capped)
        }

        await this.updateConversation(active.id, {
          messages: capped,
          title,
        })
        // Notify webview so the conversations list reflects the new title
        this.broadcastConversationsUpdated()
        break
      }
    }
  }

  private async handleSwitchConversation(id: string | undefined) {
    if (!id) return
    const all = this.getConversations()
    const target = all.find((c) => c.id === id)
    if (!target) return

    await this.setActiveConversation(id)
    this.postToWebview({
      type: 'loadConversation',
      payload: {
        activeId: id,
        messages: target.messages,
        usage: target.usage || null,
      },
    })
    this.broadcastConversationsUpdated()
  }

  private async handleDeleteConversation(id: string | undefined) {
    if (!id) return
    await this.deleteConversation(id)

    // After delete, push the new active conversation
    const active = this.ensureActiveConversation()
    this.postToWebview({
      type: 'loadConversation',
      payload: {
        activeId: active.id,
        messages: active.messages,
        usage: active.usage || null,
      },
    })
    this.broadcastConversationsUpdated()
  }

  private summarizeConversations() {
    return this.getConversations()
      .map((c) => ({
        id: c.id,
        title: c.title,
        updatedAt: c.updatedAt,
        messageCount: c.messages.length,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  private broadcastConversationsUpdated() {
    this.postToWebview({
      type: 'conversationsUpdated',
      payload: {
        activeId: this.getActiveConversationId(),
        conversations: this.summarizeConversations(),
      },
    })
  }

  // ─── Image temp file handling ──────────────────────────────────

  private async saveTempImage(dataUrl: string): Promise<string> {
    // Parse data URL: data:image/png;base64,XXXX
    const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/)
    if (!match) {
      throw new Error('Invalid image data URL')
    }
    const mime = match[1]
    const base64 = match[2]
    const ext = mime.split('/')[1] || 'png'

    const tmpDir = path.join(os.tmpdir(), 'rtl-claude-images')
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true })
    }

    const filename = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    const filePath = path.join(tmpDir, filename)
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'))
    return filePath
  }

  // ─── Sending a message to Claude ───────────────────────────────

  private async handleSendMessage(text: string) {
    if (!text.trim()) return

    const workspaceRoot =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd()

    const config = vscode.workspace.getConfiguration('rtlClaude')
    const model = config.get<string>('model', 'claude-opus-4-6')
    const effort = config.get<'low' | 'medium' | 'max'>('effort', 'max')
    const maxTurns = config.get<number>('maxTurns', 50)
    const includeActiveFile = config.get<boolean>('includeActiveFile', true)
    const enableMemory = config.get<boolean>('enableMemory', true)
    const includeClaudeMd = config.get<boolean>('includeClaudeMd', true)
    const enableMcpServers = config.get<boolean>('enableMcpServers', true)

    // Build the prompt with optional active file context
    let prompt = text
    if (includeActiveFile) {
      const editor = vscode.window.activeTextEditor
      if (editor && !editor.document.isUntitled) {
        const relPath = vscode.workspace.asRelativePath(editor.document.uri)
        prompt = `[הקובץ הפתוח כרגע: ${relPath}]\n\n${text}`
      }
    }

    // Load project context (CLAUDE.md + memory)
    const projectContext = loadProjectContext(workspaceRoot)
    if (!includeClaudeMd) projectContext.claudeMd = null
    if (!enableMemory) projectContext.memoryIndex = null

    // Load MCP servers
    const mcpServers = enableMcpServers ? loadMcpServers(workspaceRoot) : {}

    const active = this.ensureActiveConversation()
    const resumeSessionId = active.sdkSessionId

    this.currentAbortController = new AbortController()

    this.postToWebview({ type: 'streamStart' })

    // Track usage across all assistant messages in this turn
    let turnUsage: TokenUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreate: 0,
    }

    try {
      const generator = runQuery({
        prompt,
        systemPrompt: buildSystemPrompt(workspaceRoot, projectContext),
        cwd: workspaceRoot,
        resumeSessionId,
        model,
        maxTurns,
        signal: this.currentAbortController.signal,
        mcpServers,
        effort,
      })

      for await (const event of generator) {
        // Persist session id for conversation continuity
        if (event.type === 'session') {
          await this.updateConversation(active.id, {
            sdkSessionId: event.sessionId,
          })
        }

        // Accumulate token usage for this turn
        if (event.type === 'usage') {
          turnUsage.input += event.inputTokens
          turnUsage.output += event.outputTokens
          turnUsage.cacheRead += event.cacheReadTokens || 0
          turnUsage.cacheCreate += event.cacheCreateTokens || 0
        }

        this.postToWebview({ type: 'streamEvent', payload: event })

        if (event.type === 'done' || event.type === 'error') {
          break
        }
      }

      // Re-fetch conversation to get current usage (active was captured before streaming)
      const freshConv = this.getActiveConversation()
      const prevUsage = freshConv?.usage || active.usage
      const updatedUsage: TokenUsage = {
        input: (prevUsage?.input || 0) + turnUsage.input,
        output: (prevUsage?.output || 0) + turnUsage.output,
        cacheRead: (prevUsage?.cacheRead || 0) + turnUsage.cacheRead,
        cacheCreate: (prevUsage?.cacheCreate || 0) + turnUsage.cacheCreate,
      }
      await this.updateConversation(active.id, { usage: updatedUsage })

      // Push final cumulative usage so the UI can show it
      this.postToWebview({
        type: 'cumulativeUsage',
        payload: updatedUsage,
      })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      this.postToWebview({
        type: 'streamEvent',
        payload: { type: 'error', message: errMsg } satisfies StreamEvent,
      })
    } finally {
      this.postToWebview({ type: 'streamEnd' })
      this.currentAbortController = null
    }
  }

  // ─── File opening from chat links ──────────────────────────────

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

  // ─── Fuzzy file search (@ mentions) ─────────────────────────

  private async fuzzySearchFiles(query: string): Promise<string[]> {
    if (!query || query.length < 1) return []
    const workspaceRoot =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ''
    if (!workspaceRoot) return []

    try {
      // Use VS Code's findFiles with a glob pattern
      const pattern = `**/*${query.replace(/\s+/g, '*')}*`
      const uris = await vscode.workspace.findFiles(
        pattern,
        '**/node_modules/**',
        20 // limit
      )
      return uris
        .map((uri) => vscode.workspace.asRelativePath(uri))
        .sort((a, b) => a.length - b.length) // shorter paths first
    } catch {
      return []
    }
  }

  // ─── Conversation search ───────────────────────────────────

  private searchConversations(
    query: string
  ): Array<{ id: string; title: string; matchLine: string }> {
    if (!query || query.length < 2) return []

    const q = query.toLowerCase()
    const results: Array<{ id: string; title: string; matchLine: string }> = []
    const all = this.getConversations()

    for (const conv of all) {
      // Search in title
      if (conv.title.toLowerCase().includes(q)) {
        results.push({
          id: conv.id,
          title: conv.title,
          matchLine: conv.title,
        })
        continue
      }
      // Search in message text
      for (const msg of conv.messages) {
        if (msg.text.toLowerCase().includes(q)) {
          // Extract a snippet around the match
          const idx = msg.text.toLowerCase().indexOf(q)
          const start = Math.max(0, idx - 30)
          const end = Math.min(msg.text.length, idx + query.length + 30)
          const snippet =
            (start > 0 ? '...' : '') +
            msg.text.slice(start, end).replace(/\n/g, ' ') +
            (end < msg.text.length ? '...' : '')
          results.push({
            id: conv.id,
            title: conv.title,
            matchLine: snippet,
          })
          break // one match per conversation is enough
        }
      }
      if (results.length >= 15) break
    }

    return results
  }

  // ─── Code block actions ────────────────────────────────────

  private async applyCodeToFile(
    filePath: string,
    code: string
  ): Promise<void> {
    const workspaceRoot =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ''
    const absPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(workspaceRoot, filePath)

    try {
      const uri = vscode.Uri.file(absPath)
      const encoder = new TextEncoder()
      await vscode.workspace.fs.writeFile(uri, encoder.encode(code))
      const doc = await vscode.workspace.openTextDocument(uri)
      await vscode.window.showTextDocument(doc, {
        preview: false,
        viewColumn: vscode.ViewColumn.One,
      })
      vscode.window.showInformationMessage(`נכתב ל-${filePath}`)
    } catch (err) {
      vscode.window.showWarningMessage(
        `לא הצלחתי לכתוב ל-${filePath}: ${err}`
      )
    }
  }

  private async insertCodeAtCursor(code: string): Promise<void> {
    const editor = vscode.window.activeTextEditor
    if (!editor) {
      vscode.window.showWarningMessage('אין עורך פתוח להכנסת קוד')
      return
    }
    await editor.edit((editBuilder) => {
      editBuilder.insert(editor.selection.active, code)
    })
  }

  private postToWebview(msg: any) {
    this.view?.webview.postMessage(msg)
  }

  private getSettingsSnapshot() {
    const config = vscode.workspace.getConfiguration('rtlClaude')
    return {
      model: config.get<string>('model', 'claude-opus-4-6'),
      effort: config.get<string>('effort', 'max'),
      maxTurns: config.get<number>('maxTurns', 50),
      includeActiveFile: config.get<boolean>('includeActiveFile', true),
      includeClaudeMd: config.get<boolean>('includeClaudeMd', true),
      enableMemory: config.get<boolean>('enableMemory', true),
      enableMcpServers: config.get<boolean>('enableMcpServers', true),
    }
  }

  private pushSettingsState() {
    this.postToWebview({
      type: 'settingsState',
      payload: this.getSettingsSnapshot(),
    })
  }

  // ─── HTML ──────────────────────────────────────────────────────

  private getHtml(webview: vscode.Webview): string {
    const mediaPath = path.join(this.context.extensionPath, 'media')
    const htmlPath = path.join(mediaPath, 'chat.html')

    let html = fs.readFileSync(htmlPath, 'utf8')

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
