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
  /** @type {Array<{id: string, title: string, updatedAt: number, messageCount: number}>} */
  let conversations = []
  let activeConversationId = null
  /** Pending images attached to the next message */
  /** @type {Array<{localId: string, dataUrl: string, name: string, savedPath?: string}>} */
  let pendingImages = []
  /** Cumulative token usage for current conversation */
  let conversationUsage = null
  /** Project context info from extension host */
  let contextInfo = null
  /** Whether welcome banner has been shown this session */
  let welcomeShown = false

  // ─── DOM refs ───────────────────────────────────────────────
  const messagesEl = document.getElementById('messages')
  const emptyStateEl = document.getElementById('emptyState')
  const welcomeBanner = document.getElementById('welcomeBanner')
  const inputEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('input'))
  const sendBtn = document.getElementById('sendBtn')
  const newConvBtn = document.getElementById('newConvBtn')
  const historyBtn = document.getElementById('historyBtn')
  const historyPanel = document.getElementById('historyPanel')
  const historyCloseBtn = document.getElementById('historyCloseBtn')
  const historyList = document.getElementById('historyList')
  const settingsBtn = document.getElementById('settingsBtn')
  const settingsPanel = document.getElementById('settingsPanel')
  const settingsCloseBtn = document.getElementById('settingsCloseBtn')
  const conversationTitleEl = document.getElementById('conversationTitle')
  const workspaceLabel = document.getElementById('workspaceLabel')
  const contextChip = document.getElementById('contextChip')
  const contextText = document.getElementById('contextText')
  const contextRemove = document.getElementById('contextRemove')
  const attachBtn = document.getElementById('attachBtn')
  const imageFileInput = /** @type {HTMLInputElement} */ (document.getElementById('imageFileInput'))
  const imageChipsContainer = document.getElementById('imageChips')
  const usageDisplay = document.getElementById('usageDisplay')
  const inputRow = document.querySelector('.input-row')
  // Settings inputs
  const modelSelect = /** @type {HTMLSelectElement} */ (document.getElementById('modelSelect'))
  const includeActiveFileEl = /** @type {HTMLInputElement} */ (document.getElementById('includeActiveFile'))
  const includeClaudeMdEl = /** @type {HTMLInputElement} */ (document.getElementById('includeClaudeMd'))
  const enableMemoryEl = /** @type {HTMLInputElement} */ (document.getElementById('enableMemory'))
  const enableMcpServersEl = /** @type {HTMLInputElement} */ (document.getElementById('enableMcpServers'))
  const contextStatusEl = document.getElementById('contextStatus')
  const openVsSettingsBtn = document.getElementById('openVsSettingsBtn')
  const effortBtns = document.querySelectorAll('.effort-btn')

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
      Array.from(messagesEl.children).forEach((child) => {
        if (child !== emptyStateEl && child !== welcomeBanner) child.remove()
      })
      return
    }

    emptyStateEl.style.display = 'none'

    const wasAtBottom = isScrolledToBottom()

    Array.from(messagesEl.children).forEach((child) => {
      if (child !== emptyStateEl && child !== welcomeBanner) child.remove()
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
        // Wrap so we can position the copy button
        const textWrapper = document.createElement('div')
        textWrapper.className = 'message-text-wrapper'

        const textEl = document.createElement('div')
        textEl.className = 'assistant-text'
        textEl.innerHTML = renderMarkdown(msg.text)
        attachLinkHandlers(textEl)
        textWrapper.appendChild(textEl)

        // Copy button (only for non-streaming completed messages)
        if (!msg.streaming) {
          const copyBtn = document.createElement('button')
          copyBtn.className = 'copy-btn'
          copyBtn.title = 'העתק'
          copyBtn.innerHTML =
            '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
          copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(msg.text).then(() => {
              copyBtn.classList.add('copied')
              copyBtn.innerHTML =
                '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
              setTimeout(() => {
                copyBtn.classList.remove('copied')
                copyBtn.innerHTML =
                  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
              }, 1500)
            })
          })
          textWrapper.appendChild(copyBtn)
        }

        content.appendChild(textWrapper)
      } else if (msg.streaming) {
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
      if (/^https?:\/\//.test(href)) {
        link.setAttribute('target', '_blank')
        link.setAttribute('rel', 'noopener noreferrer')
        return
      }
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
      const hasInput = inputEl.value.trim().length > 0
      const hasImages = pendingImages.length > 0
      sendBtn.disabled = !hasInput && !hasImages
    }
  }

  function sendMessage() {
    const text = inputEl.value.trim()
    if (!text && pendingImages.length === 0) return
    if (isStreaming) return

    // Wait for any pending images to be saved
    const unsavedImages = pendingImages.filter((img) => !img.savedPath)
    if (unsavedImages.length > 0) {
      // Defer until images are saved (handled by imageSaved message)
      setTimeout(sendMessage, 100)
      return
    }

    // Build the full text with images and selection
    let fullText = text || ''

    if (currentSelection) {
      const selectionBlock = `קטע נבחר מ-\`${currentSelection.filePath}\` (שורות ${currentSelection.startLine}-${currentSelection.endLine}):\n\n\`\`\`${currentSelection.language || ''}\n${currentSelection.text}\n\`\`\`\n\n`
      fullText = selectionBlock + fullText
      clearContextChip()
    }

    if (pendingImages.length > 0) {
      const imageRefs = pendingImages
        .map(
          (img, i) =>
            `[תמונה ${i + 1}: ${img.savedPath} — אנא קרא אותה עם הכלי Read]`
        )
        .join('\n')
      fullText = imageRefs + '\n\n' + fullText
      pendingImages = []
      renderImageChips()
    }

    if (!fullText.trim()) return

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
    hideWelcomeBanner()
    render()
    messagesEl.scrollTop = messagesEl.scrollHeight

    inputEl.value = ''
    autosizeInput()
    updateSendButton()

    vscode.postMessage({
      type: 'sendMessage',
      payload: { text: fullText },
    })
  }

  function cancelStream() {
    vscode.postMessage({ type: 'cancel' })
  }

  // ─── Image handling ─────────────────────────────────────────

  function attachImageFromFile(file) {
    if (!file || !file.type.startsWith('image/')) return
    const reader = new FileReader()
    reader.onload = (e) => {
      const dataUrl = String(e.target?.result || '')
      if (!dataUrl) return
      const localId = 'img-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
      pendingImages.push({
        localId,
        dataUrl,
        name: file.name || 'image.png',
      })
      renderImageChips()
      updateSendButton()
      // Save to temp file via host
      vscode.postMessage({
        type: 'uploadImage',
        payload: { dataUrl, id: localId },
      })
    }
    reader.readAsDataURL(file)
  }

  function renderImageChips() {
    imageChipsContainer.innerHTML = ''
    for (const img of pendingImages) {
      const chip = document.createElement('div')
      chip.className = 'image-chip'

      const thumb = document.createElement('img')
      thumb.className = 'image-chip-thumb'
      thumb.src = img.dataUrl
      thumb.alt = img.name
      chip.appendChild(thumb)

      const name = document.createElement('span')
      name.className = 'image-chip-name'
      name.textContent = img.name
      chip.appendChild(name)

      const removeBtn = document.createElement('button')
      removeBtn.className = 'image-chip-remove'
      removeBtn.setAttribute('aria-label', 'הסר תמונה')
      removeBtn.textContent = '✕'
      removeBtn.addEventListener('click', () => {
        pendingImages = pendingImages.filter((p) => p.localId !== img.localId)
        renderImageChips()
        updateSendButton()
      })
      chip.appendChild(removeBtn)

      imageChipsContainer.appendChild(chip)
    }
  }

  // ─── History panel ──────────────────────────────────────────

  function renderHistoryPanel() {
    historyList.innerHTML = ''

    if (conversations.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'history-empty'
      empty.textContent = 'אין שיחות עדיין'
      historyList.appendChild(empty)
      return
    }

    for (const conv of conversations) {
      const item = document.createElement('div')
      item.className = 'history-item'
      if (conv.id === activeConversationId) item.classList.add('active')

      const content = document.createElement('div')
      content.className = 'history-item-content'

      const title = document.createElement('div')
      title.className = 'history-item-title'
      title.textContent = conv.title || 'שיחה חדשה'
      content.appendChild(title)

      const meta = document.createElement('div')
      meta.className = 'history-item-meta'
      const time = document.createElement('span')
      time.textContent = formatRelativeTime(conv.updatedAt)
      meta.appendChild(time)
      if (conv.messageCount > 0) {
        const count = document.createElement('span')
        count.textContent = `· ${conv.messageCount} הודעות`
        meta.appendChild(count)
      }
      content.appendChild(meta)

      item.appendChild(content)

      const deleteBtn = document.createElement('button')
      deleteBtn.className = 'history-item-delete'
      deleteBtn.setAttribute('aria-label', 'מחק שיחה')
      deleteBtn.title = 'מחק שיחה'
      deleteBtn.innerHTML =
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        const confirmed = confirm(`למחוק את "${conv.title}"?`)
        if (!confirmed) return
        vscode.postMessage({
          type: 'deleteConversation',
          payload: { id: conv.id },
        })
      })
      item.appendChild(deleteBtn)

      item.addEventListener('click', () => {
        if (conv.id === activeConversationId) {
          closeHistoryPanel()
          return
        }
        if (isStreaming) {
          alert('המתן לסיום השיחה הנוכחית לפני מעבר')
          return
        }
        vscode.postMessage({
          type: 'switchConversation',
          payload: { id: conv.id },
        })
        closeHistoryPanel()
      })

      historyList.appendChild(item)
    }
  }

  function formatRelativeTime(ts) {
    const diff = Date.now() - ts
    const min = 60 * 1000
    const hour = 60 * min
    const day = 24 * hour
    if (diff < min) return 'עכשיו'
    if (diff < hour) return `לפני ${Math.floor(diff / min)} דק׳`
    if (diff < day) return `לפני ${Math.floor(diff / hour)} שעות`
    if (diff < 7 * day) return `לפני ${Math.floor(diff / day)} ימים`
    const date = new Date(ts)
    return `${date.getDate()}/${date.getMonth() + 1}`
  }

  function openHistoryPanel() {
    closeSettingsPanel()
    renderHistoryPanel()
    historyPanel.classList.remove('hidden')
  }

  function closeHistoryPanel() {
    historyPanel.classList.add('hidden')
  }

  function toggleHistoryPanel() {
    if (historyPanel.classList.contains('hidden')) openHistoryPanel()
    else closeHistoryPanel()
  }

  function updateConversationTitle() {
    const active = conversations.find((c) => c.id === activeConversationId)
    if (active && active.title) {
      conversationTitleEl.textContent = active.title
    } else {
      conversationTitleEl.textContent = 'Claude — צ׳אט עברי'
    }
  }

  // ─── Settings panel ─────────────────────────────────────────

  function openSettingsPanel() {
    closeHistoryPanel()
    syncSettingsFromState()
    renderContextStatus()
    settingsPanel.classList.remove('hidden')
  }

  function closeSettingsPanel() {
    settingsPanel.classList.add('hidden')
  }

  function toggleSettingsPanel() {
    if (settingsPanel.classList.contains('hidden')) openSettingsPanel()
    else closeSettingsPanel()
  }

  function syncSettingsFromState() {
    // The host pushes settings via 'settingsState' message; until then, defaults are shown
  }

  function renderContextStatus() {
    if (!contextStatusEl) return
    if (!contextInfo) {
      contextStatusEl.innerHTML = '<div class="status-row"><span>טוען...</span></div>'
      return
    }
    const rows = []
    rows.push(
      `<div class="status-row"><span class="status-icon ${contextInfo.hasClaudeMd ? 'status-on' : 'status-off'}">${contextInfo.hasClaudeMd ? '✓' : '○'}</span> CLAUDE.md ${contextInfo.hasClaudeMd ? 'נטען' : 'לא נמצא'}</div>`
    )
    rows.push(
      `<div class="status-row"><span class="status-icon ${contextInfo.hasMemory ? 'status-on' : 'status-off'}">${contextInfo.hasMemory ? '✓' : '○'}</span> זיכרון: ${contextInfo.hasMemory ? `${contextInfo.memoryFileCount} קבצים` : 'לא נמצא'}</div>`
    )
    rows.push(
      `<div class="status-row"><span class="status-icon ${contextInfo.mcpServerCount > 0 ? 'status-on' : 'status-off'}">${contextInfo.mcpServerCount > 0 ? '✓' : '○'}</span> MCP servers: ${contextInfo.mcpServerCount > 0 ? contextInfo.mcpServerNames.join(', ') : 'אין'}</div>`
    )
    contextStatusEl.innerHTML = rows.join('')
  }

  // Settings input handlers — push to host via 'updateSetting'
  function bindSetting(el, key) {
    if (!el) return
    el.addEventListener('change', () => {
      const value = el.type === 'checkbox' ? el.checked : el.value
      vscode.postMessage({
        type: 'updateSetting',
        payload: { key, value },
      })
    })
  }

  // ─── Welcome banner ─────────────────────────────────────────

  function showWelcomeBanner(text) {
    welcomeBanner.innerHTML = ''
    const icon = document.createElement('span')
    icon.className = 'welcome-banner-icon'
    icon.textContent = '👋'
    welcomeBanner.appendChild(icon)

    const txt = document.createElement('span')
    txt.className = 'welcome-banner-text'
    txt.textContent = text
    welcomeBanner.appendChild(txt)

    const close = document.createElement('button')
    close.className = 'welcome-banner-close'
    close.setAttribute('aria-label', 'סגור')
    close.textContent = '✕'
    close.addEventListener('click', hideWelcomeBanner)
    welcomeBanner.appendChild(close)

    welcomeBanner.classList.remove('hidden')
    welcomeShown = true
  }

  function hideWelcomeBanner() {
    welcomeBanner.classList.add('hidden')
  }

  // ─── Token usage display ────────────────────────────────────

  function renderUsage() {
    if (!conversationUsage || conversationUsage.input + conversationUsage.output === 0) {
      usageDisplay.classList.add('hidden')
      return
    }
    const inputK = (conversationUsage.input / 1000).toFixed(1)
    const outputK = (conversationUsage.output / 1000).toFixed(1)
    // Rough Opus pricing (Apr 2026): $15/M input, $75/M output
    const cost =
      (conversationUsage.input * 15) / 1_000_000 +
      (conversationUsage.output * 75) / 1_000_000
    const cacheNote =
      conversationUsage.cacheRead > 0
        ? ` · ${(conversationUsage.cacheRead / 1000).toFixed(1)}K cached`
        : ''
    usageDisplay.innerHTML = `<span class="usage-item">${inputK}K → ${outputK}K tokens${cacheNote}</span><span class="usage-cost">~$${cost.toFixed(3)}</span>`
    usageDisplay.classList.remove('hidden')
  }

  // Persist messages to workspaceState so they survive window reloads.
  function persistMessages() {
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

  // Image paste from clipboard
  inputEl.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (file) attachImageFromFile(file)
      }
    }
  })

  // Drag and drop images
  inputRow.addEventListener('dragover', (e) => {
    e.preventDefault()
    inputRow.classList.add('drag-over')
  })
  inputRow.addEventListener('dragleave', () => {
    inputRow.classList.remove('drag-over')
  })
  inputRow.addEventListener('drop', (e) => {
    e.preventDefault()
    inputRow.classList.remove('drag-over')
    const files = e.dataTransfer?.files
    if (!files) return
    Array.from(files).forEach((f) => {
      if (f.type.startsWith('image/')) attachImageFromFile(f)
    })
  })

  attachBtn.addEventListener('click', () => {
    imageFileInput.click()
  })

  imageFileInput.addEventListener('change', () => {
    const files = imageFileInput.files
    if (!files) return
    Array.from(files).forEach(attachImageFromFile)
    imageFileInput.value = ''
  })

  sendBtn.addEventListener('click', () => {
    if (isStreaming) cancelStream()
    else sendMessage()
  })

  newConvBtn.addEventListener('click', () => {
    if (isStreaming) return
    closeHistoryPanel()
    closeSettingsPanel()
    vscode.postMessage({ type: 'newConversation' })
  })

  historyBtn.addEventListener('click', toggleHistoryPanel)
  historyCloseBtn.addEventListener('click', closeHistoryPanel)

  settingsBtn.addEventListener('click', toggleSettingsPanel)
  settingsCloseBtn.addEventListener('click', closeSettingsPanel)

  // Effort buttons
  effortBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const effort = btn.getAttribute('data-effort')
      if (!effort) return
      effortBtns.forEach((b) => b.classList.remove('active'))
      btn.classList.add('active')
      vscode.postMessage({
        type: 'updateSetting',
        payload: { key: 'effort', value: effort },
      })
    })
  })

  // Settings checkboxes + select
  bindSetting(modelSelect, 'model')
  bindSetting(includeActiveFileEl, 'includeActiveFile')
  bindSetting(includeClaudeMdEl, 'includeClaudeMd')
  bindSetting(enableMemoryEl, 'enableMemory')
  bindSetting(enableMcpServersEl, 'enableMcpServers')

  openVsSettingsBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'openSettings' })
  })

  // Close panels when clicking outside
  document.addEventListener('click', (e) => {
    const target = /** @type {Node} */ (e.target)
    // History
    if (
      !historyPanel.classList.contains('hidden') &&
      !historyPanel.contains(target) &&
      !historyBtn.contains(target)
    ) {
      closeHistoryPanel()
    }
    // Settings
    if (
      !settingsPanel.classList.contains('hidden') &&
      !settingsPanel.contains(target) &&
      !settingsBtn.contains(target)
    ) {
      closeSettingsPanel()
    }
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
        if (typeof msg.payload?.activeId === 'string') {
          activeConversationId = msg.payload.activeId
        }
        if (Array.isArray(msg.payload?.conversations)) {
          conversations = msg.payload.conversations
        }
        if (msg.payload?.context) {
          contextInfo = msg.payload.context
          renderContextStatus()
        }
        if (msg.payload?.usage) {
          conversationUsage = msg.payload.usage
        } else {
          conversationUsage = null
        }
        if (Array.isArray(msg.payload?.messages)) {
          messages = msg.payload.messages.map((m) => ({
            ...m,
            streaming: false,
          }))
        } else {
          messages = []
        }
        // Welcome banner: shown once per session if there are existing conversations
        if (!welcomeShown && conversations.length > 0) {
          const totalMsgs = conversations.reduce(
            (sum, c) => sum + (c.messageCount || 0),
            0
          )
          if (totalMsgs > 0) {
            const text = `ברוך שובך! יש לך ${conversations.length} שיחות שמורות (${totalMsgs} הודעות סך הכל). השיחה האחרונה שלך נטענה אוטומטית.`
            showWelcomeBanner(text)
          }
        }
        if (msg.payload?.settings) {
          applySettingsToUI(msg.payload.settings)
        }
        updateConversationTitle()
        renderUsage()
        render()
        messagesEl.scrollTop = messagesEl.scrollHeight
        break

      case 'loadConversation':
        if (typeof msg.payload?.activeId === 'string') {
          activeConversationId = msg.payload.activeId
        }
        if (Array.isArray(msg.payload?.messages)) {
          messages = msg.payload.messages.map((m) => ({
            ...m,
            streaming: false,
          }))
        } else {
          messages = []
        }
        if (msg.payload?.usage !== undefined) {
          conversationUsage = msg.payload.usage
        }
        currentAssistantId = null
        clearContextChip()
        hideWelcomeBanner()
        updateConversationTitle()
        renderUsage()
        render()
        messagesEl.scrollTop = messagesEl.scrollHeight
        break

      case 'conversationsUpdated':
        if (Array.isArray(msg.payload?.conversations)) {
          conversations = msg.payload.conversations
        }
        if (typeof msg.payload?.activeId === 'string') {
          activeConversationId = msg.payload.activeId
        }
        updateConversationTitle()
        if (!historyPanel.classList.contains('hidden')) {
          renderHistoryPanel()
        }
        break

      case 'cumulativeUsage':
        conversationUsage = msg.payload
        renderUsage()
        break

      case 'imageSaved': {
        const id = msg.payload?.id
        const path = msg.payload?.path
        if (!id || !path) return
        const img = pendingImages.find((p) => p.localId === id)
        if (img) img.savedPath = path
        break
      }

      case 'settingsState':
        if (msg.payload) applySettingsToUI(msg.payload)
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

  function applySettingsToUI(s) {
    if (typeof s.model === 'string' && modelSelect) {
      modelSelect.value = s.model
    }
    if (typeof s.effort === 'string') {
      effortBtns.forEach((b) =>
        b.classList.toggle('active', b.getAttribute('data-effort') === s.effort)
      )
    }
    if (typeof s.includeActiveFile === 'boolean' && includeActiveFileEl) {
      includeActiveFileEl.checked = s.includeActiveFile
    }
    if (typeof s.includeClaudeMd === 'boolean' && includeClaudeMdEl) {
      includeClaudeMdEl.checked = s.includeClaudeMd
    }
    if (typeof s.enableMemory === 'boolean' && enableMemoryEl) {
      enableMemoryEl.checked = s.enableMemory
    }
    if (typeof s.enableMcpServers === 'boolean' && enableMcpServersEl) {
      enableMcpServersEl.checked = s.enableMcpServers
    }
  }

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

      case 'usage':
        // Live update of usage during streaming
        if (!conversationUsage) {
          conversationUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }
        }
        // Each event reports the current message's tokens. We add to a running total.
        // Note: cumulative is finalized via 'cumulativeUsage' event after streamEnd.
        break

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
