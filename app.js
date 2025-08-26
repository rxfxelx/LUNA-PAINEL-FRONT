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
}

/* ========= CRM (ACRÉSCIMOS) ========= */
const CRM_STAGES = ["novo","sem_resposta","interessado","em_negociacao","fechou","descartado"]

async function apiCRMViews(){ return api("/api/crm/views") }
async function apiCRMList(stage, limit=100, offset=0){
  const qs = new URLSearchParams({stage,limit,offset}).toString()
  return api("/api/crm/list?"+qs)
}
async function apiCRMSetStatus(chatid, stage, notes=""){
  return api("/api/crm/status",{method:"POST",body:JSON.stringify({chatid,stage,notes})})
}

function ensureCRMBar(){
  const host = document.querySelector(".topbar")
  if(!host || host.querySelector(".crm-tabs")) return

  const wrap = document.createElement("div")
  wrap.className = "crm-tabs"
  wrap.style.display = "flex"
  wrap.style.gap = "8px"
  wrap.style.alignItems = "center"

  const btnAll = document.createElement("button")
  btnAll.className = "btn"
  btnAll.textContent = "Geral"
  btnAll.onclick = () => loadChats()
  wrap.appendChild(btnAll)

  CRM_STAGES.forEach(st=>{
    const b=document.createElement("button")
    b.className="btn"
    b.dataset.stage=st
    b.textContent=st.replace("_"," ")
    b.onclick=()=>loadCRMStage(st)
    wrap.appendChild(b)
  })

  const counters=document.createElement("div")
  counters.className="crm-counters"
  counters.style.fontSize="12px"
  counters.style.color="var(--sub2)"
  counters.style.marginLeft="8px"

  host.appendChild(wrap)
  host.appendChild(counters)
  refreshCRMCounters()
}

async function refreshCRMCounters(){
  try{
    const data=await apiCRMViews()
    const counts=data?.counts||{}
    const el=document.querySelector(".crm-counters")
    if(el){
      const parts=CRM_STAGES.map(s=>`${s.replace("_"," ")}: ${counts[s]||0}`)
      el.textContent=parts.join(" • ")
    }
  }catch{}
}

async function loadCRMStage(stage){
  const list=$("#chat-list")
  list.innerHTML="<div class='hint'>Carregando visão CRM...</div>"
  try{
    const data=await apiCRMList(stage,100,0)
    const items=[]
    for(const it of (data?.items||[])){
      const ch=it.chat||{}
      if(!ch.wa_chatid && it.crm?.chatid) ch.wa_chatid=it.crm.chatid
      items.push(ch)
    }
    await progressiveRenderChats(items)
    await prefetchCards(items)
  }catch(e){
    list.innerHTML=`<div class='error'>Falha ao carregar CRM: ${escapeHtml(e.message||"")}</div>`
  }finally{
    refreshCRMCounters()
  }
}

function attachCRMControlsToCard(cardEl, chatObj){
  const row1=cardEl.querySelector(".row1")
  if(!row1) return
  if(row1.querySelector(".btn-crm-gear")) return

  // engrenagem: muda estágio manualmente
  const gear=document.createElement("button")
  gear.className="btn btn-crm-gear"
  gear.title="Mudar estágio CRM"
  gear.style.marginLeft="6px"
  gear.style.padding="2px 6px"
  gear.textContent="⚙"
  gear.onclick=async(ev)=>{
    ev.stopPropagation()
    const chatid=chatObj.wa_chatid||chatObj.chatid||""
    if(!chatid) return
    const st=prompt("Estágio (novo, sem_resposta, interessado, em_negociacao, fechou, descartado):","interessado")
    if(!st) return
    if(!CRM_STAGES.includes(st)){ alert("Estágio inválido."); return }
    try{
      await apiCRMSetStatus(chatid,st,"")
      await refreshCRMCounters()
      gear.textContent="✅"; setTimeout(()=>gear.textContent="⚙",1200)
    }catch(e){ alert("Falha ao definir estágio: "+(e.message||"")) }
  }
  row1.appendChild(gear)

  // 🤖 IA: classificar automaticamente
  const aiBtn=document.createElement("button")
  aiBtn.className="btn btn-crm-ai"
  aiBtn.title="Classificar com IA"
  aiBtn.style.marginLeft="4px"
  aiBtn.style.padding="2px 6px"
  aiBtn.textContent="🤖"
  aiBtn.onclick=async(ev)=>{
    ev.stopPropagation()
    const chatid=chatObj.wa_chatid||chatObj.chatid||""
    if(!chatid) return
    aiBtn.disabled=true; const old=aiBtn.textContent; aiBtn.textContent="…"
    try{
      await autoClassify(chatid) // chama IA e aplica no CRM
      await refreshCRMCounters()
      aiBtn.textContent="✅"; setTimeout(()=>aiBtn.textContent="🤖",1200)
    }catch(e){
      console.error(e); alert(e.message||"Falha IA")
      aiBtn.textContent=old
    }finally{ aiBtn.disabled=false }
  }
  row1.appendChild(aiBtn)
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

    // dispara uma sincronização CRM (opcional/leve)
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

  const BATCH = 12
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

  attachCRMControlsToCard(el, ch)
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

  const CHUNK = 10
  for (let i = 0; i < tasks.length; i += CHUNK) {
    const slice = tasks.slice(i, i + CHUNK)
    await runLimited(slice, 6)
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
  state.current = ch
  const title = $("#chat-header")
  const status = $(".chat-status")
  const chatid = ch.wa_chatid || ch.chatid || ch.wa_fastid || ch.wa_id || ""

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
    await progressiveRenderMessages(items.slice().reverse())

    const last = items[0]
    const pv = (last?.text || last?.caption || last?.message?.text || last?.message?.conversation || last?.body || "")
      .replace(/\s+/g, " ")
      .trim()
    state.lastMsg.set(chatid, pv)
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

  const BATCH = 10
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

/* ========= IA — classificação automática ========= */
async function autoClassify(chatid){
  // pega um pedaço de histórico para contexto
  const hist = await api("/api/messages", {
    method: "POST",
    body: JSON.stringify({ chatid, limit: 30, sort: "-messageTimestamp" })
  })
  const items = Array.isArray(hist?.items) ? hist.items : []
  // manda transcript (como está) para o backend
  const out = await api("/api/ai/classify", {
    method: "POST",
    body: JSON.stringify({
      chatid,
      transcript: items, // o backend já sabe extrair texto/role
      apply: false       // aplicamos pelo próprio front abaixo
    })
  })
  const stage = out?.stage_mapped || "novo"
  const reason = out?.reason || ""
  // grava no CRM
  await apiCRMSetStatus(chatid, stage, `[IA] ${reason}`.slice(0, 280))
  return out
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
