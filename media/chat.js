/* RTL Claude — webview client.
   Communicates with the extension host via vscode.postMessage. */

(function () {
  'use strict'
  // @ts-ignore
  const vscode = acquireVsCodeApi()

  // ─── State ──────────────────────────────────────────────────
  /** @type {Array<{id: string, role: 'user'|'assistant', text: string, tools: any[], streaming?: boolean}>} */
  let messages = []
  let isStreaming = false
  let currentAssistantId = null

  // ─── DOM refs ───────────────────────────────────────────────
  const messagesEl = document.getElementById('messages')
  const emptyStateEl = document.getElementById('emptyState')
  const inputEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('input'))
  const sendBtn = document.getElementById('sendBtn')
  const newConvBtn = document.getElementById('newConvBtn')
  const workspaceLabel = document.getElementById('workspaceLabel')
  const contextChip = document.getElementById('contextChip')
  const contextText = document.getElementById('contextText')
  const contextRemove = document.getElementById('contextRemove')

  // ─── Tool labels ────────────────────────────────────────────
  const TOOL_LABELS = {
    Read: 'קורא קובץ',
    Write: 'כותב קובץ',
    Edit: 'עורך קובץ',
    Glob: 'מחפש קבצים',
    Grep: 'מחפש בתוכן',
    Bash: 'מריץ פקודה',
    WebFetch: 'טוען דף',
    WebSearch: 'מחפש באינטרנט',
    TodoWrite: 'מעדכן משימות',
  }

  function describeToolInput(tool, input) {
    if (!input || typeof input !== 'object') return ''
    if (typeof input.file_path === 'string') return input.file_path
    if (typeof input.path === 'string') return input.path
    if (typeof input.pattern === 'string') return input.pattern
    if (typeof input.command === 'string') return input.command.slice(0, 80)
    if (typeof input.url === 'string') return input.url
    if (typeof input.query === 'string') return input.query
    return ''
  }

  // ─── Markdown renderer ──────────────────────────────────────
  // marked.js is loaded globally
  if (typeof marked !== 'undefined') {
    marked.setOptions({
      gfm: true,
      breaks: true,
      headerIds: false,
      mangle: false,
    })
  }

  function renderMarkdown(text) {
    if (typeof marked === 'undefined') {
      // Fallback: escape HTML and preserve newlines
      const escaped = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
      return escaped.replace(/\n/g, '<br>')
    }
    return marked.parse(text)
  }

  // ─── Render ─────────────────────────────────────────────────

  function render() {
    if (messages.length === 0) {
      emptyStateEl.style.display = 'block'
      // Clear all but empty state
      Array.from(messagesEl.children).forEach((child) => {
        if (child !== emptyStateEl) child.remove()
      })
      return
    }

    emptyStateEl.style.display = 'none'

    // Diff-render: only update what's needed.
    // For simplicity in v1, full re-render but preserve scroll position.
    const wasAtBottom = isScrolledToBottom()

    Array.from(messagesEl.children).forEach((child) => {
      if (child !== emptyStateEl) child.remove()
    })

    for (const msg of messages) {
      const el = renderMessage(msg)
      messagesEl.appendChild(el)
    }

    if (wasAtBottom) {
      messagesEl.scrollTop = messagesEl.scrollHeight
    }
  }

  function isScrolledToBottom() {
    const threshold = 100
    return (
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <
      threshold
    )
  }

  function renderMessage(msg) {
    const wrapper = document.createElement('div')
    wrapper.className = `message ${msg.role}`

    const avatar = document.createElement('div')
    avatar.className = 'avatar'
    avatar.textContent = msg.role === 'user' ? 'את' : 'C'
    wrapper.appendChild(avatar)

    const content = document.createElement('div')
    content.className = 'bubble-content'

    if (msg.role === 'user') {
      const userText = document.createElement('div')
      userText.className = 'user-text'
      userText.textContent = msg.text
      content.appendChild(userText)
    } else {
      // Assistant: tool calls above text
      if (msg.tools && msg.tools.length > 0) {
        const toolsList = document.createElement('div')
        toolsList.className = 'tools-list'
        msg.tools.forEach((tool) => {
          toolsList.appendChild(renderToolCall(tool))
        })
        content.appendChild(toolsList)
      }

      if (msg.text) {
        const textEl = document.createElement('div')
        textEl.className = 'assistant-text'
        textEl.innerHTML = renderMarkdown(msg.text)
        attachLinkHandlers(textEl)
        content.appendChild(textEl)
      } else if (msg.streaming) {
        // Empty streaming message — show dots
        const dots = document.createElement('div')
        dots.className = 'streaming-dots'
        dots.innerHTML = '<span></span><span></span><span></span>'
        content.appendChild(dots)
      }
    }

    wrapper.appendChild(content)
    return wrapper
  }

  function renderToolCall(tool) {
    const card = document.createElement('div')
    card.className = 'tool-call'
    if (tool.expanded) card.classList.add('expanded')

    const header = document.createElement('button')
    header.className = 'tool-header'

    const status = document.createElement('span')
    status.className = 'tool-status'
    if (tool.isError) status.classList.add('error')
    else if (tool.result !== undefined) status.classList.add('done')
    else status.classList.add('running')
    header.appendChild(status)

    const name = document.createElement('span')
    name.className = 'tool-name'
    name.textContent = TOOL_LABELS[tool.tool] || tool.tool
    header.appendChild(name)

    const desc = document.createElement('span')
    desc.className = 'tool-desc'
    desc.textContent = describeToolInput(tool.tool, tool.input)
    header.appendChild(desc)

    const chevron = document.createElement('span')
    chevron.className = 'tool-chevron'
    chevron.textContent = tool.expanded ? '▲' : '▼'
    header.appendChild(chevron)

    header.addEventListener('click', () => {
      tool.expanded = !tool.expanded
      render()
    })

    card.appendChild(header)

    if (tool.expanded) {
      const body = document.createElement('div')
      body.className = 'tool-body'

      const inputLabel = document.createElement('div')
      inputLabel.className = 'tool-section-label'
      inputLabel.textContent = 'קלט'
      body.appendChild(inputLabel)

      const inputPre = document.createElement('pre')
      inputPre.className = 'tool-pre'
      inputPre.textContent = JSON.stringify(tool.input, null, 2)
      body.appendChild(inputPre)

      if (tool.result !== undefined) {
        const resLabel = document.createElement('div')
        resLabel.className = 'tool-section-label'
        resLabel.textContent = 'תוצאה'
        body.appendChild(resLabel)

        const resPre = document.createElement('pre')
        resPre.className = 'tool-pre'
        if (tool.isError) resPre.classList.add('error')
        resPre.textContent = tool.result
        body.appendChild(resPre)
      }

      card.appendChild(body)
    }

    return card
  }

  function attachLinkHandlers(container) {
    const links = container.querySelectorAll('a[href]')
    links.forEach((link) => {
      const href = link.getAttribute('href')
      if (!href) return
      // External links: leave default
      if (/^https?:\/\//.test(href)) {
        link.setAttribute('target', '_blank')
        link.setAttribute('rel', 'noopener noreferrer')
        return
      }
      // Internal: file references like src/foo.ts or src/foo.ts#L42
      link.addEventListener('click', (e) => {
        e.preventDefault()
        const [path, hash] = href.split('#')
        let line
        if (hash) {
          const m = hash.match(/L(\d+)/)
          if (m) line = parseInt(m[1], 10)
        }
        vscode.postMessage({
          type: 'openFile',
          payload: { path, line },
        })
      })
    })
  }

  // ─── Input handling ─────────────────────────────────────────

  function autosizeInput() {
    inputEl.style.height = 'auto'
    inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px'
  }

  function updateSendButton() {
    if (isStreaming) {
      sendBtn.classList.add('streaming')
      sendBtn.disabled = false
    } else {
      sendBtn.classList.remove('streaming')
      sendBtn.disabled = inputEl.value.trim().length === 0
    }
  }

  function sendMessage() {
    const text = inputEl.value.trim()
    if (!text || isStreaming) return

    // If there's a context chip, prepend it as a code block
    let fullText = text
    if (currentSelection) {
      fullText = `קטע נבחר מ-\`${currentSelection.filePath}\` (שורות ${currentSelection.startLine}-${currentSelection.endLine}):\n\n\`\`\`${currentSelection.language || ''}\n${currentSelection.text}\n\`\`\`\n\n${text}`
      clearContextChip()
    }

    const userMsg = {
      id: 'u-' + Date.now(),
      role: 'user',
      text: fullText,
      tools: [],
    }
    const assistantMsg = {
      id: 'a-' + Date.now(),
      role: 'assistant',
      text: '',
      tools: [],
      streaming: true,
    }
    currentAssistantId = assistantMsg.id

    messages.push(userMsg, assistantMsg)
    render()
    messagesEl.scrollTop = messagesEl.scrollHeight

    inputEl.value = ''
    autosizeInput()

    vscode.postMessage({
      type: 'sendMessage',
      payload: { text: fullText },
    })
  }

  function cancelStream() {
    vscode.postMessage({ type: 'cancel' })
  }

  // Persist messages to workspaceState so they survive window reloads.
  // Called after each turn completes (streamEnd).
  function persistMessages() {
    // Strip transient fields (streaming, expanded) to keep state clean
    const cleaned = messages.map((m) => ({
      id: m.id,
      role: m.role,
      text: m.text,
      tools: (m.tools || []).map((t) => ({
        id: t.id,
        tool: t.tool,
        input: t.input,
        result: t.result,
        isError: t.isError,
      })),
    }))
    vscode.postMessage({
      type: 'persistMessages',
      payload: { messages: cleaned },
    })
  }

  // ─── Selection / context chip ───────────────────────────────
  let currentSelection = null

  function showSelectionChip(selection) {
    currentSelection = selection
    contextText.textContent = `${selection.filePath}:${selection.startLine}-${selection.endLine}`
    contextChip.classList.remove('hidden')
    inputEl.focus()
  }

  function clearContextChip() {
    currentSelection = null
    contextChip.classList.add('hidden')
  }

  // ─── Event listeners ────────────────────────────────────────

  inputEl.addEventListener('input', () => {
    autosizeInput()
    updateSendButton()
  })

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  })

  sendBtn.addEventListener('click', () => {
    if (isStreaming) cancelStream()
    else sendMessage()
  })

  newConvBtn.addEventListener('click', () => {
    if (isStreaming) return
    vscode.postMessage({ type: 'newConversation' })
  })

  contextRemove.addEventListener('click', clearContextChip)

  // ─── Receive messages from extension host ───────────────────

  window.addEventListener('message', (event) => {
    const msg = event.data
    switch (msg.type) {
      case 'init':
        if (msg.payload?.workspaceName) {
          workspaceLabel.textContent = `📁 ${msg.payload.workspaceName}`
        }
        // Restore saved messages from workspace state
        if (Array.isArray(msg.payload?.messages) && msg.payload.messages.length > 0) {
          messages = msg.payload.messages.map((m) => ({
            ...m,
            streaming: false, // Any in-flight message from before reload is done
          }))
          render()
          messagesEl.scrollTop = messagesEl.scrollHeight
        }
        break

      case 'clear':
        messages = []
        currentAssistantId = null
        render()
        persistMessages() // Save the empty state so reload doesn't restore old messages
        break

      case 'streamStart':
        isStreaming = true
        updateSendButton()
        break

      case 'streamEnd':
        isStreaming = false
        const lastMsg = messages.find((m) => m.id === currentAssistantId)
        if (lastMsg) lastMsg.streaming = false
        currentAssistantId = null
        updateSendButton()
        render()
        persistMessages()
        break

      case 'streamEvent':
        handleStreamEvent(msg.payload)
        break

      case 'injectSelection':
        showSelectionChip(msg.payload)
        break
    }
  })

  function handleStreamEvent(event) {
    const msg = messages.find((m) => m.id === currentAssistantId)
    if (!msg) return

    switch (event.type) {
      case 'text':
        msg.text += event.text
        render()
        break

      case 'tool_use':
        msg.tools.push({
          id: event.id,
          tool: event.tool,
          input: event.input,
          expanded: false,
        })
        render()
        break

      case 'tool_result': {
        const tool = msg.tools.find((t) => t.id === event.toolUseId)
        if (tool) {
          tool.result = event.content
          tool.isError = event.isError
        }
        render()
        break
      }

      case 'error':
        msg.text += `\n\n**שגיאה:** ${event.message}`
        render()
        break

      case 'done':
        msg.streaming = false
        render()
        break
    }
  }

  // ─── Init ───────────────────────────────────────────────────
  vscode.postMessage({ type: 'ready' })
  updateSendButton()
})()
