/**
 * Wraps the Claude Agent SDK so the extension host can stream
 * responses to the webview. Strips nested-execution env markers
 * once at module load so the spawned `claude` child process
 * doesn't bail out when we're already running inside Antigravity.
 */

import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'

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
  mcpServers?: Record<string, unknown>
  effort?: 'low' | 'medium' | 'max'
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
  | {
      type: 'usage'
      inputTokens: number
      outputTokens: number
      cacheReadTokens?: number
      cacheCreateTokens?: number
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
        ...(options.mcpServers && Object.keys(options.mcpServers).length > 0
          ? { mcpServers: options.mcpServers }
          : {}),
        ...(options.effort ? { effort: options.effort } : {}),
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

      // Stream assistant content + token usage
      if (event.type === 'assistant' && 'message' in event) {
        const message = (event as { message: any }).message

        // Capture usage from each assistant message
        if (message.usage) {
          yield {
            type: 'usage',
            inputTokens: message.usage.input_tokens || 0,
            outputTokens: message.usage.output_tokens || 0,
            cacheReadTokens: message.usage.cache_read_input_tokens,
            cacheCreateTokens: message.usage.cache_creation_input_tokens,
          }
        }

        const content = message.content
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

// ─── Project context loading ──────────────────────────────────────

export interface ProjectContext {
  claudeMd: string | null
  memoryIndex: string | null
  memoryDir: string
  memoryFileCount: number
}

/**
 * Loads CLAUDE.md from workspace root and MEMORY.md from the
 * auto-memory dir corresponding to the current workspace.
 * The memory dir mirrors what Claude Code uses internally.
 */
export function loadProjectContext(workspaceRoot: string): ProjectContext {
  const result: ProjectContext = {
    claudeMd: null,
    memoryIndex: null,
    memoryDir: getMemoryDir(workspaceRoot),
    memoryFileCount: 0,
  }

  // CLAUDE.md from workspace root
  const claudeMdPath = path.join(workspaceRoot, 'CLAUDE.md')
  if (fileExists(claudeMdPath)) {
    try {
      result.claudeMd = fs.readFileSync(claudeMdPath, 'utf8')
    } catch (e) {
      console.error('[RTL Claude] Failed to read CLAUDE.md:', e)
    }
  }

  // MEMORY.md from auto-memory dir
  const memoryIndexPath = path.join(result.memoryDir, 'MEMORY.md')
  if (fileExists(memoryIndexPath)) {
    try {
      result.memoryIndex = fs.readFileSync(memoryIndexPath, 'utf8')
    } catch (e) {
      console.error('[RTL Claude] Failed to read MEMORY.md:', e)
    }
  }

  // Count memory files (excluding MEMORY.md itself)
  if (fs.existsSync(result.memoryDir)) {
    try {
      const files = fs
        .readdirSync(result.memoryDir)
        .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
      result.memoryFileCount = files.length
    } catch (e) {
      // ignore
    }
  }

  return result
}

/**
 * Returns the auto-memory directory for the given workspace.
 * Mirrors Claude Code's internal path encoding: replace / with -.
 */
export function getMemoryDir(workspaceRoot: string): string {
  // Encode the path the way Claude Code does: /Users/foo/bar → -Users-foo-bar
  const encoded = workspaceRoot.replace(/\//g, '-')
  return path.join(os.homedir(), '.claude', 'projects', encoded, 'memory')
}

/**
 * Reads MCP servers configured for this workspace from ~/.claude.json
 * (project-scoped) and from the global config. Returns the merged set.
 */
export function loadMcpServers(workspaceRoot: string): Record<string, unknown> {
  try {
    const claudeJsonPath = path.join(os.homedir(), '.claude.json')
    if (!fileExists(claudeJsonPath)) return {}

    const raw = fs.readFileSync(claudeJsonPath, 'utf8')
    const data = JSON.parse(raw)

    const merged: Record<string, unknown> = {}

    // Global mcpServers
    if (data.mcpServers && typeof data.mcpServers === 'object') {
      Object.assign(merged, data.mcpServers)
    }

    // Project-scoped mcpServers
    const project = data.projects?.[workspaceRoot]
    if (project?.mcpServers && typeof project.mcpServers === 'object') {
      Object.assign(merged, project.mcpServers)
    }

    return merged
  } catch (e) {
    console.error('[RTL Claude] Failed to load MCP servers:', e)
    return {}
  }
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * Build the system prompt with workspace + date context + memory + CLAUDE.md.
 */
export function buildSystemPrompt(
  workspaceRoot: string,
  ctx?: ProjectContext
): string {
  const today = new Date().toISOString().split('T')[0]

  let prompt = `אתה Claude — עוזר קוד אישי שעובד מתוך תוסף Antigravity/VS Code בשם "RTL Claude".

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

הספרייה הנוכחית: ${workspaceRoot}
היום: ${today}`

  // Append CLAUDE.md if present
  if (ctx?.claudeMd) {
    prompt += `\n\n# CLAUDE.md (project rules)\n\nהקובץ הזה נמצא בשורש הפרויקט והוא מכיל את חוקי הפרויקט. עקוב אחריו תמיד:\n\n${ctx.claudeMd}`
  }

  // Append MEMORY.md if present + memory instructions
  if (ctx?.memoryIndex) {
    prompt += `\n\n# Auto-memory system

יש לך מערכת זיכרון מתמשכת ב-${ctx.memoryDir}. זה אותו הזיכרון שהראשי Claude Code משתמש בו עבור הפרויקט הזה — אתם חולקים את אותם הקבצים.

האינדקס (MEMORY.md) המעודכן:

${ctx.memoryIndex}

## שימוש בזיכרון

- כשהמשתמש אומר "תזכור" או "תשמור" משהו — שמור אותו מיד כקובץ memory חדש.
- כשהמשתמש אומר "שכח" משהו — מצא את הקובץ הרלוונטי ומחק את הערך.
- כשאתה לומד דבר חדש על המשתמש (תפקיד, העדפות, רקע), שמור כ-user memory.
- כשהמשתמש נותן feedback על איך לעבוד ("אל תעשה X", "תמיד תעשה Y"), שמור כ-feedback memory.
- כשאתה לומד על פרויקט, deadline, או החלטה אדריכלית, שמור כ-project memory.

## איך לשמור זיכרון

צור קובץ markdown חדש ב-${ctx.memoryDir} עם frontmatter:

\`\`\`markdown
---
name: {{שם תיאורי}}
description: {{תיאור של שורה אחת}}
type: {{user | feedback | project | reference}}
---

{{תוכן הזיכרון}}
\`\`\`

ואז הוסף שורה ב-MEMORY.md (שגם נמצא ב-${ctx.memoryDir}/MEMORY.md):
\`- [כותרת](filename.md) — סיכום קצר\`

## חשוב
- אל תיצור duplicates — קודם תבדוק אם יש memory קיים בנושא.
- אל תשמור מידע שאפשר לגזור מהקוד עצמו (זה מתעדכן ממילא).
- אל תשמור מידע שזמני — רק דברים שיהיו רלוונטיים בשיחות עתידיות.`
  } else if (ctx?.memoryDir) {
    // No MEMORY.md yet, but tell Claude where to start one
    prompt += `\n\n# Auto-memory system

יש לך מערכת זיכרון מתמשכת. הספרייה ${ctx.memoryDir} עדיין לא קיימת — אם המשתמש יבקש לזכור משהו, צור אותה ושמור שם MEMORY.md + קובץ memory ראשון.`
  }

  return prompt
}
