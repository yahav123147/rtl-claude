/**
 * RTL Claude — Hebrew RTL chat panel for VS Code / Antigravity.
 *
 * Entry point: registers the chat sidebar view provider, commands,
 * and keybindings. The actual chat UI lives in ChatViewProvider.
 */

import * as vscode from 'vscode'
import { ChatViewProvider } from './chatProvider'

export function activate(context: vscode.ExtensionContext) {
  console.log('[RTL Claude] Activating extension')

  const provider = new ChatViewProvider(context)

  // Register sidebar webview view
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      provider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      }
    )
  )

  // Command: focus the chat sidebar
  context.subscriptions.push(
    vscode.commands.registerCommand('rtl-claude.focus', async () => {
      await vscode.commands.executeCommand('rtl-claude.chat.focus')
    })
  )

  // Command: start a new conversation
  context.subscriptions.push(
    vscode.commands.registerCommand('rtl-claude.newConversation', () => {
      provider.newConversation()
    })
  )

  // Command: send current selection to chat
  context.subscriptions.push(
    vscode.commands.registerCommand('rtl-claude.sendSelection', async () => {
      const editor = vscode.window.activeTextEditor
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showInformationMessage('בחר קוד קודם')
        return
      }
      const selectedText = editor.document.getText(editor.selection)
      const filePath = vscode.workspace.asRelativePath(editor.document.uri)
      const startLine = editor.selection.start.line + 1
      const endLine = editor.selection.end.line + 1
      const language = editor.document.languageId

      await vscode.commands.executeCommand('rtl-claude.chat.focus')
      provider.sendSelectionToChat({
        text: selectedText,
        filePath,
        startLine,
        endLine,
        language,
      })
    })
  )

  console.log('[RTL Claude] Extension activated')
}

export function deactivate() {
  console.log('[RTL Claude] Deactivating extension')
}
