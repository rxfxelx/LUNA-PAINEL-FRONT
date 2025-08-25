/* ========= CONFIG/HELPERS ========= */
const BACKEND = () => (window.__BACKEND_URL__ || "").replace(/\/+$/, "")
const $ = (s) => document.querySelector(s)
const show = (sel) => $(sel).classList.remove("hidden")
const hide = (sel) => $(sel).classList.add("hidden")

function isMobile() {
  return window.matchMedia("(max-width:1023px)").matches
}
function setMobileMode(mode) {
  // "list" | "chat" | ""
  document.body.classList.remove("is-mobile-list", "is-mobile-chat")
  if (!isMobile()) return
  if (mode === "list") document.body.classList.add("is-mobile-list")
  if (mode === "chat") document.body.classList.add("is-mobile-chat")
}

function jwt() {
  return localStorage.getItem("luna_jwt") || ""
}
function authHeaders() {
  return { Authorization: "Bearer " + jwt() }
}

async function api(path, opts = {}) {
  const res = await fetch(BACKEND() + path, {
    headers: { "Content-Type": "application/json", ...authHeaders(), ...(opts.headers || {}) },
    ...opts,
  })
  if (!res.ok) {
    const t = await res.text().catch(() => "")
    throw new Error(`HTTP ${res.status}: ${t}`)
  }
  return res.json()
}

function escapeHtml(s) {
  return String(s || "").replace(
    /[&<>"']/g,
    (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m],
  )
}

/* ========= STATE ========= */
const state = {
  chats: [],
  current: null, // objeto do chat aberto
  lastMsg: new Map(), // chatid => preview da última mensagem
  nameCache: new Map(), // chatid => {name,image,imagePreview}
  unread: new Map(), // chatid => count
  loadingChats: false,
}

/* ========= LOGIN ========= */
async function doLogin() {
  const token = $("#token").value.trim()
  const msgEl = $("#msg")
  const btnEl = $("#btn-login")

  if (!token) {
    msgEl.textContent = "Por favor, cole o token da instância"
    return
  }

  msgEl.textContent = ""
  btnEl.disabled = true
  btnEl.innerHTML = "<span>Conectando...</span>"

  try {
    const r = await fetch(BACKEND() + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
    if (!r.ok) throw new Error(await r.text())
    const data = await r.json()
    localStorage.setItem("luna_jwt", data.jwt)
    switchToApp()
  } catch (e) {
    console.error(e)
    msgEl.textContent = "Token inválido. Verifique e tente novamente."
  } finally {
    btnEl.disabled = false
    btnEl.innerHTML =
      '<span>Entrar no Sistema</span><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>'
  }
}

function switchToApp() {
  hide("#login-view")
  show("#app-view")
  setMobileMode("list")
  loadChats()
}

function ensureRoute() {
  if (jwt()) switchToApp()
  else {
    show("#login-view")
    hide("#app-view")
  }
}

/* ========= AVATAR/NAME-IMAGE ========= */
async function fetchNameImage(chatid, preview = true) {
  try {
    const resp = await api("/api/name-image", {
      method: "POST",
      body: JSON.stringify({ number: chatid, preview }),
    })
    return resp // {name,image,imagePreview}
  } catch (e) {
    return { name: null, image: null, imagePreview: null }
  }
}

function initialsOf(str) {
  const s = (str || "").trim()
  if (!s) return "??"
  const parts = s.split(/\s+/).slice(0, 2)
  return parts.map((p) => p[0]?.toUpperCase() || "").join("") || "??"
}

/* ========= CHATS ========= */
async function loadChats() {
  if (state.loadingChats) return
  state.loadingChats = true

  const list = $("#chat-list")
  list.innerHTML = "<div class='hint'>Carregando conversas...</div>"

  try {
    const data = await api("/api/chats", {
      method: "POST",
      body: JSON.stringify({ operator: "AND", sort: "-wa_lastMsgTimestamp", limit: 100, offset: 0 }),
    })
    const items = Array.isArray(data?.items) ? data.items : []
    state.chats = items

    // Prefetch da última mensagem + name-image para cada chat (em paralelo controlado)
    await prefetchCards(items)

    renderChats(items)
  } catch (e) {
    console.error(e)
    list.innerHTML = `<div class='error'>Falha ao carregar conversas: ${escapeHtml(e.message || "")}</div>`
  } finally {
    state.loadingChats = false
  }
}

async function prefetchCards(items) {
  const tasks = items.map(async (ch) => {
    const chatid = ch.wa_chatid || ch.chatid || ch.wa_fastid || ch.wa_id || ""
    const resp = await fetchNameImage(chatid)
    state.nameCache.set(chatid, resp)
  })
  await Promise.all(tasks)
}

function renderChats(chats) {
  const list = $("#chat-list")
  list.innerHTML = ""

  if (chats.length === 0) {
    list.innerHTML = "<div class='hint'>Nenhuma conversa encontrada</div>"
    return
  }

  chats.forEach((ch) => {
    const el = document.createElement("div")
    el.className = "chat-item"
    el.onclick = () => openChat(ch)

    const chatid = ch.wa_chatid || ch.chatid || ch.wa_fastid || ch.wa_id || ""
    const cache = state.nameCache.get(chatid) || {}
    const name = (cache.name || ch.wa_contactName || ch.name || chatid || "Contato").toString()
    const lastTs = ch.wa_lastMsgTimestamp || ch.messageTimestamp || ""

    const avatar = document.createElement("div")
    avatar.className = "avatar"
    const imgUrl = cache.imagePreview || cache.image || ""
    if (imgUrl) {
      const img = document.createElement("img")
      img.src = imgUrl
      img.alt = "avatar"
      avatar.appendChild(img)
    } else {
      avatar.textContent = initialsOf(name)
    }

    const main = document.createElement("div")
    main.className = "chat-main"

    const top = document.createElement("div")
    top.className = "row1"
    const nm = document.createElement("div")
    nm.className = "name"
    nm.textContent = name
    const tm = document.createElement("div")
    tm.className = "time"
    tm.textContent = lastTs ? formatTime(lastTs) : ""
    top.appendChild(nm)
    top.appendChild(tm)

    const bottom = document.createElement("div")
    bottom.className = "row2"
    const preview = document.createElement("div")
    preview.className = "preview"

    const pvText = (state.lastMsg.get(chatid) || ch.wa_lastMessageText || "").replace(/\s+/g, " ").trim()
    preview.textContent = pvText || "Sem mensagens"
    preview.title = pvText

    const unread = document.createElement("span")
    unread.className = "badge"
    const count = state.unread.get(chatid) || ch.wa_unreadCount || 0
    if (count > 0) {
      unread.textContent = count
    } else {
      unread.style.display = "none"
    }

    bottom.appendChild(preview)
    bottom.appendChild(unread)

    main.appendChild(top)
    main.appendChild(bottom)
    el.appendChild(avatar)
    el.appendChild(main)
    list.appendChild(el)
  })
}

function formatTime(timestamp) {
  if (!timestamp) return ""
  try {
    const date = new Date(timestamp)
    const now = new Date()
    const diff = now - date
    const hours = Math.floor(diff / (1000 * 60 * 60))

    if (hours < 1) return "Agora"
    if (hours < 24) return `${hours}h`
    if (hours < 48) return "Ontem"
    return date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })
  } catch (e) {
    return timestamp
  }
}

/* ========= OPEN CHAT / MESSAGES ========= */
async function openChat(ch) {
  state.current = ch
  const title = $("#chat-header")
  const status = $(".chat-status")
  const chatid = ch.wa_chatid || ch.chatid || ch.wa_fastid || ch.wa_id || ""

  // name-image preferencial
  const cache = state.nameCache.get(chatid) || {}
  const nm = (cache.name || ch.wa_contactName || ch.name || chatid || "Chat").toString()

  title.textContent = nm
  if (status) status.textContent = "Carregando mensagens..."

  setMobileMode("chat")
  await loadMessages(chatid)

  if (status) status.textContent = "Online"
}

async function loadMessages(chatid) {
  const pane = $("#messages")
  pane.innerHTML = "<div class='hint'>Carregando mensagens...</div>"

  try {
    const data = await api("/api/messages", {
      method: "POST",
      body: JSON.stringify({ chatid, limit: 100, sort: "-messageTimestamp" }),
    })
    const items = Array.isArray(data?.items) ? data.items : []
    renderMessages(items.reverse())

    // Atualiza preview do card após abrir
    const last = items[items.length - 1]
    const pv = (last?.text || last?.caption || last?.message?.text || last?.message?.conversation || last?.body || "")
      .replace(/\s+/g, " ")
      .trim()
    state.lastMsg.set(chatid, pv)
  } catch (e) {
    console.error(e)
    pane.innerHTML = `<div class='error'>Falha ao carregar mensagens: ${escapeHtml(e.message || "")}</div>`
  }
}

function renderMessages(msgs) {
  const pane = $("#messages")
  pane.innerHTML = ""

  if (msgs.length === 0) {
    pane.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">💬</div>
        <h3>Nenhuma mensagem</h3>
        <p>Esta conversa ainda não possui mensagens</p>
      </div>
    `
    return
  }

  msgs.forEach((m) => {
    const me = m.fromMe || m.fromme || m.from_me || false
    const el = document.createElement("div")
    el.className = "msg " + (me ? "me" : "you")
    const text = m.text || m.message?.text || m.caption || m?.message?.conversation || m?.body || ""
    const who = m.senderName || m.pushName || ""
    const ts = m.messageTimestamp || m.timestamp || ""

    el.innerHTML = `
      ${escapeHtml(text)}
      <small>${escapeHtml(who)} • ${formatTime(ts)}</small>
    `
    pane.appendChild(el)
  })

  pane.scrollTop = pane.scrollHeight
}

/* ========= SEND (mantido) ========= */
async function sendNow() {
  const number = $("#send-number").value.trim()
  const text = $("#send-text").value.trim()
  const btnEl = $("#btn-send")

  if (!number || !text) return

  btnEl.disabled = true
  btnEl.innerHTML =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>'

  try {
    await api("/api/send-text", {
      method: "POST",
      body: JSON.stringify({ number, text }),
    })
    $("#send-text").value = ""

    if (state.current && (state.current.wa_chatid || state.current.chatid) === number) {
      setTimeout(() => loadMessages(number), 500)
    }
  } catch (e) {
    alert(e.message || "Falha ao enviar mensagem")
  } finally {
    btnEl.disabled = false
    btnEl.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>'
  }
}

/* ========= BOOT ========= */
document.addEventListener("DOMContentLoaded", () => {
  $("#btn-login").onclick = doLogin
  $("#btn-logout").onclick = () => {
    localStorage.clear()
    location.reload()
  }
  $("#btn-send").onclick = sendNow
  $("#btn-refresh").onclick = () => {
    if (state.current) {
      const chatid = state.current.wa_chatid || state.current.chatid
      loadMessages(chatid)
    } else {
      loadChats()
    }
  }

  const backBtn = document.getElementById("btn-back-mobile")
  if (backBtn) backBtn.onclick = () => setMobileMode("list")

  $("#send-text").addEventListener("keypress", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      sendNow()
    }
  })

  $("#token").addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      e.preventDefault()
      doLogin()
    }
  })

  ensureRoute()
})
