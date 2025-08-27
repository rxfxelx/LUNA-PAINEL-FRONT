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

/* ======== DETECÇÃO REGRAS — INTERESSE & TRANSFERÊNCIA (SEM IA) ======== */
function norm(s="") {
  return String(s)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
}
function msgText(m){
  return norm(
    m?.text || m?.caption || m?.message?.text || m?.message?.conversation || m?.body || ""
  )
}
// padrões de interesse do CLIENTE (user)
const INTEREST_PATTERNS = {
  perguntas: [
    /\?/, /\bcomo\b/, /\bquanto\b/, /\bquando\b/, /\bonde\b/, /\bprazo\b/,
    /\bvalor\b/, /\bpreco\b/, /\bpreço\b/, /\bgarantia\b/, /\bentrega\b/,
    /\bfunciona\b/, /\bdemonstrac?ao\b/, /\bmostrar?\b/, /\bcatalogo\b/, /\bcardapio\b/
  ],
  intencao: [
    /\bquero\b/, /\bgostaria\b/, /\btenho interesse\b/, /\bme interessa\b/,
    /\bpode enviar\b/, /\bpode me mostrar\b/, /\baceito\b/, /\btopo\b/,
    /\btenho duvida(s)?\b/
  ],
  confirmacaoLeve: [
    /\bbeleza\b/, /\bshow\b/, /\bperfeito\b/, /\bok\b/, /\bmanda\b/, /\bmanda sim\b/
  ]
}
const INTEREST_POINTS = { perguntas: 2, intencao: 3, confirmacaoLeve: 1 }
const INTEREST_THRESHOLD = 3 // >= 3 pontos => LEAD

function scoreInterest(userMsgs){
  let score = 0
  for(const m of userMsgs){
    const t = msgText(m)
    for(const [group, regs] of Object.entries(INTEREST_PATTERNS)){
      if (regs.some(r => r.test(t))) score += INTEREST_POINTS[group]
    }
  }
  return score
}

// padrões de TRANSFERÊNCIA/ENCAMINHAMENTO feitos por NÓS (assistant)
const TRANSFER_PATTERNS = [
  /\bvou te passar para\b/, /\bvou passar seu contato\b/, /\bvou encaminhar\b/,
  /\bencaminhando seu contato\b/, /\b(o|a) (time|setor|equipe) (vai|ira) (te )?chamar\b/,
  /\b(alguem|consultor|vendedor) vai (falar|entrar em contato)\b/,
  /\bvou pedir para (alguem|o time) te chamar\b/,
  /\bvou (te )?transferir\b/, /\bte coloco em contato\b/, /\b(o|a) comercial vai (te )?chamar\b/
]
function isTransferredByAgent(agentMsgs){
  for(const m of agentMsgs){
    const t = msgText(m)
    if (TRANSFER_PATTERNS.some(r => r.test(t))) return true
  }
  return false
}

/* ========= STATE ========= */
const state = {
  chats: [],
  current: null, // objeto do chat aberto
  lastMsg: new Map(), // chatid => preview da última mensagem
  nameCache: new Map(), // chatid => {name,image,imagePreview}
  unread: new Map(), // chatid => count
  loadingChats: false,

  // === Classificação (persistente no navegador) ===
  // chatid -> {stage, confidence, reason, at, lastKey}
  aiStage: new Map(),
  aiStageLoaded: false,
}

/* ========= STAGES ========= */
const STAGES = ["contatos", "lead", "lead_quente"]
const STAGE_LABEL = { contatos: "Contatos", lead: "Lead", lead_quente: "Lead Quente" }
const STAGE_RANK  = { contatos: 0, lead: 1, lead_quente: 2 }

function normalizeStage(s) {
  const k = String(s || "").toLowerCase().trim()
  if (k.startsWith("contato")) return "contatos"
  if (k.includes("lead_quente") || k.includes("quente")) return "lead_quente"
  if (k === "lead") return "lead"
  return "contatos"
}
function maxStage(a, b) {
  a = normalizeStage(a); b = normalizeStage(b)
  return STAGE_RANK[b] > STAGE_RANK[a] ? b : a
}

function loadStageCache() {
  if (state.aiStageLoaded) return
  try {
    const raw = localStorage.getItem("luna_ai_stage") || "{}"
    const obj = JSON.parse(raw)
    Object.entries(obj).forEach(([chatid, v]) => state.aiStage.set(chatid, v))
  } catch {}
  state.aiStageLoaded = true
}
function saveStageCache() {
  const obj = {}
  state.aiStage.forEach((v, k) => { obj[k] = v })
  localStorage.setItem("luna_ai_stage", JSON.stringify(obj))
}
function getStage(chatid) {
  loadStageCache()
  return state.aiStage.get(chatid) || null
}

/* ======== CLASSIFICAÇÃO SÓ POR REGRAS ======== */
function classifyByRules(items){
  const all = Array.isArray(items) ? items : []
  const userMsgs   = all.filter(m => !(m.fromMe || m.fromme || m.from_me))
  const agentMsgs  = all.filter(m =>  (m.fromMe || m.fromme || m.from_me))

  // Lead Quente se NÓS sinalizamos transferência/encaminhamento
  if (isTransferredByAgent(agentMsgs)) {
    return { stage: "lead_quente", confidence: 0.9, reason: "Transferência detectada" }
  }

  // Contatos = cliente ainda não engajou (0 msg) OU só 1 msg sem interesse
  const interest = scoreInterest(userMsgs)
  if (userMsgs.length === 0) {
    return { stage: "contatos", confidence: 0.6, reason: "Sem resposta do cliente" }
  }
  if (userMsgs.length === 1 && interest < INTEREST_THRESHOLD) {
    return { stage: "contatos", confidence: 0.58, reason: "Uma mensagem sem interesse claro" }
  }

  // Lead = demonstrou interesse (pontuação suficiente)
  if (interest >= INTEREST_THRESHOLD) {
    const conf = Math.min(0.85, 0.55 + 0.1 * interest)
    return { stage: "lead", confidence: conf, reason: `Interesse detectado (score=${interest})` }
  }

  // fallback: se está conversando mas sem sinais fortes, trata como lead
  if (userMsgs.length >= 2) {
    return { stage: "lead", confidence: 0.62, reason: "Troca de mensagens sem transferência" }
  }

  return { stage: "contatos", confidence: 0.55, reason: "Sem sinais suficientes" }
}

/* ======== PERSISTÊNCIA LOCAL (nunca rebaixa) ======== */
function makeTranscriptKey(items) {
  if (!Array.isArray(items) || !items.length) return "empty"
  const lastTs = items[0]?.messageTimestamp || items[0]?.timestamp || 0
  const len = items.length
  const tail = (items[0]?.text || items[0]?.body || "").slice(0, 64)
  return `${len}:${lastTs}:${tail.length}`
}

function promoteAndPersist(chatid, {stage, confidence, reason, key}) {
  loadStageCache()
  const prev = getStage(chatid) || { stage: "contatos", confidence: 0, reason: "", at: 0, lastKey: null }
  const nextStage = maxStage(prev.stage, stage) // nunca rebaixa
  const rec = {
    stage: nextStage,
    confidence: Math.max(prev.confidence || 0, confidence || 0),
    reason: reason || prev.reason || "",
    at: Date.now(),
    lastKey: key || prev.lastKey || null,
  }
  state.aiStage.set(chatid, rec)
  saveStageCache()
  return rec
}

/* ========= CRM (mantido, mas sem botões/sem render de barra) ========= */
const CRM_STAGES = ["novo","sem_resposta","interessado","em_negociacao","fechou","descartado"]

async function apiCRMViews(){ return api("/api/crm/views") }
async function apiCRMList(stage, limit=100, offset=0){
  const qs = new URLSearchParams({stage,limit,offset}).toString()
  return api("/api/crm/list?"+qs)
}
async function apiCRMSetStatus(chatid, stage, notes=""){
  return api("/api/crm/status",{method:"POST",body:JSON.stringify({chatid,stage,notes})})
}
function ensureCRMBar(){ /* no-op */ }
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
function attachCRMControlsToCard(cardEl, chatObj){ return }

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
  ensureStageTabs()
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

/* ========= STAGE TABS (Geral / Contatos / Lead / Lead Quente) ========= */
function ensureStageTabs() {
  const host = document.querySelector(".topbar")
  if (!host || host.querySelector(".stage-tabs")) return

  const bar = document.createElement("div")
  bar.className = "stage-tabs"
  bar.style.display = "flex"
  bar.style.gap = "8px"

  const addBtn = (key, label, onclick) => {
    const b = document.createElement("button")
    b.className = "btn"
    b.dataset.stage = key
    b.textContent = label
    b.onclick = onclick
    return b
  }

  const btnGeral = addBtn("geral", "Geral", () => loadChats())
  const btnCont   = addBtn("contatos", "Contatos", () => loadStageTab("contatos"))
  const btnLead   = addBtn("lead", "Lead", () => loadStageTab("lead"))
  const btnLQ     = addBtn("lead_quente", "Lead Quente", () => loadStageTab("lead_quente"))

  bar.appendChild(btnGeral)
  bar.appendChild(btnCont)
  bar.appendChild(btnLead)
  bar.appendChild(btnLQ)

  const counters = document.createElement("div")
  counters.className = "stage-counters"
  counters.style.marginLeft = "8px"
  counters.style.color = "var(--sub2)"
  counters.style.fontSize = "12px"

  host.appendChild(bar)
  host.appendChild(counters)

  refreshStageCounters()
}

function refreshStageCounters() {
  loadStageCache()
  const counts = { contatos: 0, lead: 0, lead_quente: 0 }
  state.chats.forEach(ch => {
    const chatid = ch.wa_chatid || ch.chatid || ch.wa_fastid || ch.wa_id || ""
    const st = getStage(chatid)?.stage || "contatos"
    if (counts[st] !== undefined) counts[st]++
  })
  const el = document.querySelector(".stage-counters")
  if (el) el.textContent =
    `contatos: ${counts.contatos} • lead: ${counts.lead} • lead quente: ${counts.lead_quente}`
}

async function loadStageTab(stageKey) {
  const list = $("#chat-list")
  list.innerHTML = "<div class='hint'>Carregando…</div>"

  loadStageCache()
  const filtered = state.chats.filter(ch => {
    const chatid = ch.wa_chatid || ch.chatid || ch.wa_fastid || ch.wa_id || ""
    const st = getStage(chatid)?.stage || "contatos"
    return st === stageKey
  })

  await progressiveRenderChats(filtered)
  await prefetchCards(filtered)
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

    // classifica todas em background (SOMENTE REGRAS) e atualiza contadores
    try {
      await classifyAllChatsInBackground(items)
      refreshStageCounters()
    } catch {}

    // opcional: sync CRM
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

  const st = getStage(chatid)
  if (st) upsertAIPill(st.stage, st.confidence, st.reason)

  if (status) status.textContent = "Online"
}

async function loadMessages(chatid) {
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

    try {
      await classifyAndPersist(chatid, items) // só REGRAS
      refreshStageCounters()
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

/* ========= BADGE DE STATUS NO HEADER ========= */
function upsertAIPill(stage, confidence, reason) {
  let pill = document.getElementById("ai-pill")
  if (!pill) {
    pill = document.createElement("span")
    pill.id = "ai-pill"
    pill.style.marginLeft = "8px"
    pill.style.padding = "4px 8px"
    pill.style.borderRadius = "999px"
    pill.style.fontSize = "12px"
    pill.style.background = "var(--muted)"
    pill.style.color = "var(--text)"
    const header = document.querySelector(".chatbar") || document.querySelector(".chat-title") || document.body
    header.appendChild(pill)
  }
  const map = { contatos: "Contatos", lead: "Lead", lead_quente: "Lead Quente" }
  const label = map[normalizeStage(stage)] || stage
  pill.textContent = `${label} • conf ${(confidence * 100).toFixed(0)}%`
  pill.title = reason || ""
}

/* ========= CLASSIFICAÇÃO E PERSISTÊNCIA (SÓ REGRAS) ========= */
async function classifyAndPersist(chatid, items) {
  const key = makeTranscriptKey(items)
  const current = getStage(chatid)
  if (current?.lastKey === key) return current

  const h = classifyByRules(items)
  const rec = promoteAndPersist(chatid, { stage: h.stage, confidence: h.confidence, reason: h.reason, key })

  const curId = state.current && (state.current.wa_chatid || state.current.chatid || state.current.wa_fastid || state.current.wa_id)
  if (curId === chatid) upsertAIPill(rec.stage, rec.confidence, rec.reason)

  return rec
}

async function classifyAllChatsInBackground(items) {
  const tasks = (items || []).map(ch => async () => {
    const chatid = ch.wa_chatid || ch.chatid || ch.wa_fastid || ch.wa_id || ""
    if (!chatid) return
    try {
      const data = await api("/api/messages", {
        method: "POST",
        body: JSON.stringify({ chatid, limit: 200, sort: "-messageTimestamp" }),
      })
      const msgs = Array.isArray(data?.items) ? data.items : []
      await classifyAndPersist(chatid, msgs)
    } catch (e) { /* ignora */ }
  })

  const CHUNK = 10
  for (let i = 0; i < tasks.length; i += CHUNK) {
    const slice = tasks.slice(i, i + CHUNK)
    await runLimited(slice, 5)
    await new Promise((r) => rIC(r))
  }
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
