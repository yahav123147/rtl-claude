/**
 * Wraps the Claude Agent SDK so the extension host can stream
 * responses to the webview. Strips nested-execution env markers
 * once at module load so the spawned `claude` child process
 * doesn't bail out when we're already running inside Antigravity.
 */

import * as vscode from 'vscode'

// Strip env vars that mark this process as a Claude Code child.
// Without this, the SDK's spawned `claude` binary detects nesting
// and exits with code 1.
delete process.env.CLAUDECODE
delete process.env.CLAUDE_CODE_ENTRYPOINT

export interface QueryOptions {
  prompt: string
  systemPrompt: string
  cwd: string
  resumeSessionId?: string | null
  model?: string
  maxTurns?: number
  signal?: AbortSignal
}

export type StreamEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; tool: string; input: unknown }
  | {
      type: 'tool_result'
      toolUseId: string
      content: string
      isError: boolean
    }
  | { type: 'done' }
  | { type: 'error'; message: string }

export async function* runQuery(
  options: QueryOptions
): AsyncGenerator<StreamEvent> {
  // Lazy import: avoid loading SDK at extension activation time
  const { query } = await import('@anthropic-ai/claude-agent-sdk')

  try {
    const queryIterator = query({
      prompt: options.prompt,
      options: {
        systemPrompt: options.systemPrompt,
        resume: options.resumeSessionId || undefined,
        maxTurns: options.maxTurns ?? 50,
        allowedTools: [
          'Read',
          'Write',
          'Edit',
          'Glob',
          'Grep',
          'Bash',
          'WebFetch',
          'WebSearch',
          'TodoWrite',
        ],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        cwd: options.cwd,
        model:
          options.model && options.model !== 'inherit'
            ? options.model
            : undefined,
      } as any,
    })

    for await (const event of queryIterator) {
      if (options.signal?.aborted) {
        yield { type: 'error', message: 'הופסק על ידי המשתמש' }
        return
      }

      // Capture session id
      if (
        event.type === 'system' &&
        'subtype' in event &&
        event.subtype === 'init'
      ) {
        const sid = (event as { session_id?: string }).session_id
        if (sid) yield { type: 'session', sessionId: sid }
      }

      // Stream assistant content
      if (event.type === 'assistant' && 'message' in event) {
        const content = (event as { message: { content: unknown } }).message
          .content
        if (Array.isArray(content)) {
          for (const block of content as Array<Record<string, unknown>>) {
            if (block.type === 'text' && typeof block.text === 'string') {
              yield { type: 'text', text: block.text }
            }
            if (
              block.type === 'thinking' &&
              typeof block.thinking === 'string'
            ) {
              yield { type: 'thinking', text: block.thinking }
            }
            if (block.type === 'tool_use') {
              yield {
                type: 'tool_use',
                id: String(block.id || ''),
                tool: String(block.name || ''),
                input: block.input,
              }
            }
          }
        }
      }

      // Tool results
      if ('tool_result' in event && event.tool_result) {
        const result = (event as any).tool_result as {
          tool_use_id: string
          content: unknown
          is_error?: boolean
        }
        const contentStr =
          typeof result.content === 'string'
            ? result.content
            : JSON.stringify(result.content)
        yield {
          type: 'tool_result',
          toolUseId: result.tool_use_id,
          content:
            contentStr.length > 1500
              ? contentStr.slice(0, 1500) + '\n... [truncated]'
              : contentStr,
          isError: Boolean(result.is_error),
        }
      }

      // Final result
      if (event.type === 'result') {
        // Check for is_error on result
        if ('is_error' in event && event.is_error) {
          const msg =
            'result' in event && typeof event.result === 'string'
              ? event.result
              : 'שגיאה לא ידועה'
          yield { type: 'error', message: msg }
        }
        yield { type: 'done' }
        return
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[RTL Claude] SDK error:', err)
    yield { type: 'error', message: msg }
  }
}

/**
 * Build the system prompt with workspace + date context.
 */
export function buildSystemPrompt(workspaceRoot: string): string {
  const today = new Date().toISOString().split('T')[0]
  return `אתה Claude — עוזר קוד אישי שעובד מתוך תוסף Antigravity/VS Code בשם "RTL Claude".

# שפה
- ענה תמיד בעברית, ברורה וזורמת.
- השתמש ב-Markdown לפורמט (כותרות ##, רשימות, code blocks).
- לקבצים השתמש בקישורי markdown: [filename.ts](src/filename.ts) או [file.ts:42](src/file.ts#L42) — המשתמש יוכל ללחוץ ולפתוח אותם בעורך.
- היה תמציתי. תשובות קצרות וישירות עדיפות.

# יכולות
יש לך גישה מלאה לפרויקט המקומי דרך הכלים:
- Read / Write / Edit — קריאה ועריכת קבצים
- Glob / Grep — חיפוש בקבצים
- Bash — הרצת פקודות shell
- WebFetch / WebSearch — גישה לאינטרנט
- TodoWrite — לעקוב אחרי משימות מורכבות

# סגנון עבודה
- לפני שינויי קוד: קרא את הקובץ קודם.
- אחרי שינויים: סכם בקצרה מה עשית.
- אל תוסיף קוד מיותר, הערות מיותרות, או תיעוד שלא ביקשו.
- אם המשתמש שולח קטע קוד נבחר — התייחס אליו ישירות.

הספרייה הנוכחית: ${workspaceRoot}
היום: ${today}`
}
