/* ========= CONFIG/HELPERS ========= */
const BACKEND = () => (window.__BACKEND_URL__ || "").replace(/\/+$/, "")
const $ = (s) => document.querySelector(s)
const show = (sel) => $(sel).classList.remove("hidden")
const hide = (sel) => $(sel).classList.add("hidden")

// Idle callback (não bloqueia UI)
const rIC = (cb) =>
  (window.requestIdleCallback
    ? window.requestIdleCallback(cb, { timeout: 200 })
    : setTimeout(cb, 0))

// Limitador de concorrência simples
async function runLimited(tasks, limit = 8) {
  const results = []
  let i = 0
  const workers = new Array(Math.min(limit, tasks.length)).fill(0).map(async () => {
    while (i < tasks.length) {
      const cur = i++
      try { results[cur] = await tasks[cur]() } catch (e) { results[cur] = undefined }
    }
  })
  await Promise.all(workers)
  return results
}

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
  currentStage: null, // null = Geral (todos); ou uma das keys CRM
}

/* ========= CRM ========= */
// estágios internos (mantidos para o backend)
const CRM_STAGES = ["novo","sem_resposta","interessado","em_negociacao","fechou","descartado"]

// abas visíveis e mapeamento p/ estágios internos
const VISIBLE_TABS = [
  { key: null,            label: "Geral" },                 // lista "normal" (todos)
  { key: "interessado",   label: "prospectivo cliente" },   // pedido pelo usuário
  { key: "novo",          label: "lead" },
  { key: "sem_resposta",  label: "lead qualificado" },      // reuso do slot: você pediu o rótulo, mantendo a key interna
  { key: "em_negociacao", label: "lead quente" },
  { key: "fechou",        label: "cliente" },
]
// OBS: “sem_resposta/descartado” NÃO aparecem como abas; descartado foi removido.
//      Aqui “lead qualificado” usa a key interna sem_resposta, apenas como rótulo.

async function apiCRMViews(){ return api("/api/crm/views") }
async function apiCRMList(stage, limit=100, offset=0){
  const qs = new URLSearchParams({stage,limit,offset}).toString()
  return api("/api/crm/list?"+qs)
}
async function apiCRMSetStatus(chatid, stage, notes=""){
  return api("/api/crm/status",{method:"POST",body:JSON.stringify({chatid,stage,notes})})
}

/* ========= TOP BAR CRM – ABAS ========= */
function ensureCRMBar(){
  let host = document.querySelector(".topbar") || document.querySelector(".header") || document.body
  if (!host) return

  // remove barra antiga se existir (evita duplicar)
  const old = host.querySelector(".crm-tabs")
  if (old) old.remove()

  const wrap = document.createElement("div")
  wrap.className = "crm-tabs"
  wrap.style.display = "flex"
  wrap.style.gap = "12px"
  wrap.style.alignItems = "center"
  wrap.style.marginLeft = "16px"

  VISIBLE_TABS.forEach(tab => {
    const b = document.createElement("button")
    b.className = "btn" // usa o mesmo estilo dos seus botões
    b.dataset.stage = tab.key === null ? "" : tab.key
    b.textContent = tab.label
    b.onclick = async () => {
      // ativa visualmente
      for (const el of wrap.querySelectorAll("button")) el.classList.remove("active")
      b.classList.add("active")

      state.currentStage = tab.key
      if (tab.key === null) {
        // “Geral” = lista normal
        await loadChats()
      } else {
        await loadCRMStage(tab.key)
      }
    }
    wrap.appendChild(b)
  })

  const counters = document.createElement("div")
  counters.className = "crm-counters"
  counters.style.fontSize = "12px"
  counters.style.color   = "var(--sub2)"
  counters.style.marginLeft = "8px"

  const container = document.createElement("div")
  container.style.display = "flex"
  container.style.alignItems = "center"
  container.appendChild(wrap)
  container.appendChild(counters)

  // injeta logo após os botões padrão do seu topo
  host.appendChild(container)

  // ativa “Geral” inicialmente
  wrap.querySelector("button")?.classList.add("active")

  refreshCRMCounters()
}

async function refreshCRMCounters(){
  try{
    const data=await apiCRMViews()
    const c=data?.counts||{}
    // string resumida no topo, no mesmo formato que você já usa
    const s = `lead: ${c.novo||0} • lead qualificado: ${c.sem_resposta||0} • lead quente: ${c.em_negociacao||0} • cliente: ${c.fechou||0} • prospectivo: ${c.interessado||0}`
    const el=document.querySelector(".crm-counters")
    if(el) el.textContent = s
  }catch{}
}

async function loadCRMStage(stage){
  state.current = null // limpa chat aberto
  const title = $("#chat-header"); if (title) title.textContent = ""
  const status = $(".chat-status"); if (status) status.textContent = "Online"
  const pane = $("#messages"); if (pane) pane.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">💬</div>
      <h3>Nenhuma conversa selecionada</h3>
      <p>Escolha um chat da lista para visualizar as mensagens</p>
    </div>`

  const list=$("#chat-list")
  list.innerHTML="<div class='hint'>Carregando visão CRM...</div>"
  try{
    const data=await apiCRMList(stage,100,0)
    const items=[]
    for(const it of (data?.items||[])){
      // it.chat pode vir resumido; garantimos um objeto com wa_chatid
      const ch=it.chat||{}
      const fromCrm = it.chatid || it.crm?.chatid || ch.wa_chatid || ch.chatid || ""
      if (!ch.wa_chatid && fromCrm) ch.wa_chatid = fromCrm
      items.push(ch)
    }
    state.chats = items
    await progressiveRenderChats(items)
    await prefetchCards(items)
  }catch(e){
    list.innerHTML=`<div class='error'>Falha ao carregar CRM: ${escapeHtml(e.message||"")}</div>`
  }finally{
    refreshCRMCounters()
  }
}

/* ======= Sem botões por card (gear/IA) – mantido vazio ======= */
function attachCRMControlsToCard(cardEl, chatObj){ /* no-op */ }

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
  ensureCRMBar()
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

    await progressiveRenderChats(items)
    await prefetchCards(items)

    // sincroniza contadores CRM (silencioso)
    try {
      await api("/api/crm/sync", { method: "POST", body: JSON.stringify({ limit: 500 }) })
      refreshCRMCounters()
    } catch {}
  } catch (e) {
    console.error(e)
    list.innerHTML = `<div class='error'>Falha ao carregar conversas: ${escapeHtml(e.message || "")}</div>`
  } finally {
    state.loadingChats = false
  }
}

// Renderiza chats em lotes pequenos para aparecer rápido
async function progressiveRenderChats(chats) {
  const list = $("#chat-list")
  list.innerHTML = ""

  if (chats.length === 0) {
    list.innerHTML = "<div class='hint'>Nenhuma conversa encontrada</div>"
    return
  }

  const BATCH = 14
  for (let i = 0; i < chats.length; i += BATCH) {
    const slice = chats.slice(i, i + BATCH)
    slice.forEach((ch) => appendChatSkeleton(list, ch))
    await new Promise((r) => rIC(r))
  }

  chats.forEach((ch) => hydrateChatCard(ch))
}

function appendChatSkeleton(list, ch) {
  const el = document.createElement("div")
  el.className = "chat-item"
  el.dataset.chatid = ch.wa_chatid || ch.chatid || ch.wa_fastid || ch.wa_id || ""
  el.onclick = () => openChat(ch)

  const avatar = document.createElement("div")
  avatar.className = "avatar"
  avatar.textContent = "··"

  const main = document.createElement("div")
  main.className = "chat-main"

  const top = document.createElement("div")
  top.className = "row1"
  const nm = document.createElement("div")
  nm.className = "name"
  nm.textContent = (ch.wa_contactName || ch.name || el.dataset.chatid || "Contato").toString()
  const tm = document.createElement("div")
  tm.className = "time"
  const lastTs = ch.wa_lastMsgTimestamp || ch.messageTimestamp || ""
  tm.textContent = lastTs ? formatTime(lastTs) : ""
  top.appendChild(nm)
  top.appendChild(tm)

  const bottom = document.createElement("div")
  bottom.className = "row2"
  const preview = document.createElement("div")
  preview.className = "preview"
  const pvText = (state.lastMsg.get(el.dataset.chatid) || ch.wa_lastMessageText || "").replace(/\s+/g, " ").trim()
  preview.textContent = pvText || "Carregando..."
  preview.title = pvText

  const unread = document.createElement("span")
  unread.className = "badge"
  const count = state.unread.get(el.dataset.chatid) || ch.wa_unreadCount || 0
  if (count > 0) unread.textContent = count
  else unread.style.display = "none"

  bottom.appendChild(preview)
  bottom.appendChild(unread)

  main.appendChild(top)
  main.appendChild(bottom)
  el.appendChild(avatar)
  el.appendChild(main)
  list.appendChild(el)

  attachCRMControlsToCard(el, ch) // no-op
}

function hydrateChatCard(ch) {
  const chatid = ch.wa_chatid || ch.chatid || ch.wa_fastid || ch.wa_id || ""
  const cache = state.nameCache.get(chatid)
  if (!chatid || !cache) return

  const el = document.querySelector(`.chat-item[data-chatid="${CSS.escape(chatid)}"]`)
  if (!el) return

  const avatar = el.querySelector(".avatar")
  const nameEl = el.querySelector(".name")
  if (cache.imagePreview || cache.image) {
    avatar.innerHTML = ""
    const img = document.createElement("img")
    img.src = cache.imagePreview || cache.image
    img.alt = "avatar"
    avatar.appendChild(img)
  } else {
    avatar.textContent = initialsOf(cache.name || nameEl.textContent)
  }
  if (cache.name) nameEl.textContent = cache.name
}

// Prefetch paralelo limitado
async function prefetchCards(items) {
  const tasks = items.map((ch) => {
    const chatid = ch.wa_chatid || ch.chatid || ch.wa_fastid || ch.wa_id || ""
    return async () => {
      if (!chatid) return
      if (!state.nameCache.has(chatid)) {
        try {
          const resp = await fetchNameImage(chatid)
          state.nameCache.set(chatid, resp)
          hydrateChatCard(ch)
        } catch {}
      }
      if (!state.lastMsg.has(chatid) && !ch.wa_lastMessageText) {
        try {
          const data = await api("/api/messages", {
            method: "POST",
            body: JSON.stringify({ chatid, limit: 1, sort: "-messageTimestamp" }),
          })
          const last = Array.isArray(data?.items) ? data.items[0] : null
          if (last) {
            const pv = (
              last.text ||
              last.caption ||
              last?.message?.text ||
              last?.message?.conversation ||
              last?.body ||
              ""
            ).replace(/\s+/g, " ").trim()
            state.lastMsg.set(chatid, pv)

            const card = document.querySelector(`.chat-item[data-chatid="${CSS.escape(chatid)}"] .preview`)
            if (card) {
              card.textContent = pv || "Sem mensagens"
              card.title = pv
            }
            const tEl = document.querySelector(`.chat-item[data-chatid="${CSS.escape(chatid)}"] .time`)
            if (tEl) tEl.textContent = formatTime(last.messageTimestamp || last.timestamp || "")
          }
        } catch {}
      }
    }
  })

  const CHUNK = 16
  for (let i = 0; i < tasks.length; i += CHUNK) {
    const slice = tasks.slice(i, i + CHUNK)
    await runLimited(slice, 8)
    await new Promise((r) => rIC(r))
  }
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
  // garante um chatid válido antes de prosseguir
  const chatid = ch.wa_chatid || ch.chatid || ch.wa_fastid || ch.wa_id || ""
  if (!chatid) return

  state.current = ch
  const title = $("#chat-header")
  const status = $(".chat-status")

  // name-image preferencial
  const cache = state.nameCache.get(chatid) || {}
  const nm = (cache.name || ch.wa_contactName || ch.name || chatid || "Chat").toString()

  if (title) title.textContent = nm
  if (status) status.textContent = "Carregando mensagens..."

  setMobileMode("chat")
  await loadMessages(chatid)

  if (status) status.textContent = "Online"
}

async function loadMessages(chatid) {
  if (!chatid) return // evita erro 400 no backend

  const pane = $("#messages")
  pane.innerHTML = "<div class='hint'>Carregando mensagens...</div>"

  try {
    const data = await api("/api/messages", {
      method: "POST",
      body: JSON.stringify({ chatid, limit: 200, sort: "-messageTimestamp" }),
    })
    const items = Array.isArray(data?.items) ? data.items : []
    await progressiveRenderMessages(items.slice().reverse())

    const last = items[0]
    const pv = (last?.text || last?.caption || last?.message?.text || last?.message?.conversation || last?.body || "")
      .replace(/\s+/g, " ")
      .trim()
    state.lastMsg.set(chatid, pv)

    // IA: classificar (se você tiver a rota ligada)
    try {
      await classifyCurrentChatFromItems(chatid, items)
    } catch {}
  } catch (e) {
    console.error(e)
    pane.innerHTML = `<div class='error'>Falha ao carregar mensagens: ${escapeHtml(e.message || "")}</div>`
  }
}

/* ========= renderização PROGRESSIVA ========= */
async function progressiveRenderMessages(msgs) {
  const pane = $("#messages")
  pane.innerHTML = ""

  if (!msgs.length) {
    pane.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">💬</div>
        <h3>Nenhuma mensagem</h3>
        <p>Esta conversa ainda não possui mensagens</p>
      </div>
    `
    return
  }

  const BATCH = 12
  for (let i = 0; i < msgs.length; i += BATCH) {
    const slice = msgs.slice(i, i + BATCH)
    slice.forEach((m) => appendMessageBubble(pane, m))
    await new Promise((r) => rIC(r))
    pane.scrollTop = pane.scrollHeight
  }
}

function appendMessageBubble(pane, m) {
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
}

/* ========= IA — PILL + CLASSIFICAÇÃO ========= */
function upsertAIPill(stage, confidence, reason) {
  let pill = document.getElementById("ai-pill");
  if (!pill) {
    pill = document.createElement("span");
    pill.id = "ai-pill";
    pill.style.marginLeft = "8px";
    pill.style.padding = "4px 8px";
    pill.style.borderRadius = "999px";
    pill.style.fontSize = "12px";
    pill.style.background = "var(--muted)";
    pill.style.color = "var(--text)";
    const header = document.querySelector(".chatbar") || document.querySelector(".chat-title") || document.body;
    header.appendChild(pill);
  }
  const map = {
    novo: "Lead",
    sem_resposta: "Lead qualificado",
    interessado: "prospectivo cliente",
    em_negociacao: "lead quente",
    fechou: "cliente",
    descartado: "Descartado"
  };
  const label = map[stage] || stage;
  pill.textContent = `${label} • conf ${(confidence * 100).toFixed(0)}%`;
  pill.title = reason || "";
}

// Busca mais histórico (se precisar) e chama IA
async function classifyCurrentChatFromItems(chatid, items){
  if (!chatid) return
  let full = Array.isArray(items) ? items.slice() : []
  if (full.length < 150) {
    try {
      const extra = await api("/api/messages", {
        method: "POST",
        body: JSON.stringify({ chatid, limit: 200, sort: "-messageTimestamp" })
      })
      const arr = Array.isArray(extra?.items) ? extra.items : []
      if (arr.length > full.length) full = arr
    } catch {}
  }

  const history = full.slice(0, 200).map(m => ({
    role: (m.fromMe || m.fromme || m.from_me) ? "assistant" : "user",
    content: (m.text || m.caption || m?.message?.text || m?.message?.conversation || m?.body || "").toString()
  })).filter(x => x.content);

  const payload = history.length ? { history } : { text: (state.lastMsg.get(chatid) || "").toString() }

  const r = await fetch(BACKEND() + "/api/ai/classify", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  })
  if (!r.ok) return
  const data = await r.json()

  upsertAIPill(data.stage, data.confidence, data.reason)

  try { await apiCRMSetStatus(chatid, data.stage, `[IA] ${data.reason}`.slice(0, 280)) } catch {}
}

/* ========= SUA renderização “clássica” (mantida) ========= */
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

    if (state.current) {
      const currentId = state.current.wa_chatid || state.current.chatid
      if (currentId && currentId === number) {
        setTimeout(() => loadMessages(number), 500)
      }
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
      if (chatid) loadMessages(chatid)
    } else {
      if (state.currentStage === null) loadChats()
      else loadCRMStage(state.currentStage)
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
