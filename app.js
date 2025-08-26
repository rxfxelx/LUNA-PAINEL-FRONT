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

  // === Classificação (persistente) ===
  // chatid -> {stage, confidence, reason, at, votes:{contatos,lead,lead_quente}, lastKey}
  aiStage: new Map(),
  aiStageLoaded: false,
}

/* ========= STAGES (Contatos, Lead, Lead Quente) ========= */
const STAGES = ["contatos", "lead", "lead_quente"]
const STAGE_LABEL = { contatos: "Contatos", lead: "Lead", lead_quente: "Lead Quente" }
const STAGE_RANK  = { contatos: 0, lead: 1, lead_quente: 2 }
const MIN_CONF    = { lead: 0.60, lead_quente: 0.70 }   // histerese por confiança
const MIN_VOTES   = { lead: 2,    lead_quente: 2 }      // histerese por votos

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
function computeStageFromVotes(prevStage, votes, confHint) {
  const cur = normalizeStage(prevStage || "contatos")
  let best = cur
  if ((votes.lead_quente || 0) >= MIN_VOTES.lead_quente && (confHint || 0) >= MIN_CONF.lead_quente)
    best = maxStage(best, "lead_quente")
  if ((votes.lead || 0) >= MIN_VOTES.lead && (confHint || 0) >= MIN_CONF.lead)
    best = maxStage(best, "lead")
  return best
}
function voteStage(chatid, { stage, confidence, reason, key }) {
  loadStageCache()
  const record = getStage(chatid) || {
    stage: "contatos",
    confidence: 0,
    reason: "",
    at: 0,
    votes: { contatos: 0, lead: 0, lead_quente: 0 },
    lastKey: null,
  }
  const st = normalizeStage(stage)
  record.votes[st] = (record.votes[st] || 0) + 1
  const promoted = computeStageFromVotes(record.stage, record.votes, confidence)
  record.stage = maxStage(record.stage, promoted) // nunca rebaixa
  record.confidence = Math.max(record.confidence || 0, confidence || 0)
  if (reason) record.reason = reason
  record.at = Date.now()
  if (key) record.lastKey = key
  state.aiStage.set(chatid, record)
  saveStageCache()
  return record
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
/* ======= DESATIVADO: não renderiza a barra CRM ======= */
function ensureCRMBar(){ /* no-op: escondido por padrão */ }
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
/* ======= DESATIVADO: não cria botões no card ======= */
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
  ensureCRMBar() // no-op
  ensureStageTabs() // abas de classificação
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

    // classifica todas em background (hash + votação + histerese)
    try {
      await classifyAllChatsInBackground(items)
      refreshStageCounters()
    } catch {}

    // opcional: sincroniza contadores CRM (silencioso)
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

  const BATCH = 14 // ligeiro aumento pra encher a tela mais rápido
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

  const CHUNK = 16 // um pouco maior pra reduzir “idas e vindas”
  for (let i = 0; i < tasks.length; i += CHUNK) {
    const slice = tasks.slice(i, i + CHUNK)
    await runLimited(slice, 8) // limite levemente maior
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
    // ↑↑ agora pedimos até 200 para IA ter mais contexto
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

    /* === IA: classificar + histerese + votação e salvar em cache local === */
    try {
      await classifyAndPersist(chatid, items)
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

  const BATCH = 12 // um pouco maior = menos repaints
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

/* ========= IA — PILL + CLASSIFICAÇÃO (estável) ========= */
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

// hash simples do histórico para evitar reprocessar sem mudanças
function makeTranscriptKey(items) {
  if (!Array.isArray(items) || !items.length) return "empty"
  const lastTs = items[0]?.messageTimestamp || items[0]?.timestamp || 0
  const len = items.length
  const tail = (items[0]?.text || items[0]?.body || "").slice(0, 64)
  return `${len}:${lastTs}:${tail.length}`
}

// heurística leve (barata) antes de chamar IA – gera voto
function heuristicStage(items) {
  const txts = (items || []).map(m =>
    (m.text || m.caption || m?.message?.text || m?.message?.conversation || m?.body || "").toLowerCase()
  )

  const hotHints = [
    "vou te passar para", "vou encaminhar", "encaminhando seu contato",
    "alguém vai falar com você", "o time comercial vai te chamar",
    "o setor vai entrar em contato", "vou pedir para alguém te chamar", "vou transferir",
  ]
  if (txts.some(t => hotHints.some(h => t.includes(h)))) return { stage: "lead_quente", conf: 0.75 }

  const qRegex = /(\?|como|quanto|quando|onde|prazo|valor|preço|preco|garantia|demonstra(ç|c)ão|mostra|funciona)/
  if (txts.some(t => qRegex.test(t))) return { stage: "lead", conf: 0.65 }

  return { stage: "contatos", conf: 0.45 }
}

async function classifyAndPersist(chatid, items) {
  const key = makeTranscriptKey(items)

  const current = getStage(chatid)
  if (current?.lastKey === key) return current

  // 1) Heurística vota
  const h = heuristicStage(items)
  voteStage(chatid, { stage: h.stage, confidence: h.conf, reason: "Heurística local", key })

  // 2) IA vota (só se mudou)
  try {
    const history = (items || []).slice(0, 200).map(m => ({
      role: (m.fromMe || m.fromme || m.from_me) ? "assistant" : "user",
      content: (m.text || m.caption || m?.message?.text || m?.message?.conversation || m?.body || "").toString()
    })).filter(x => x.content)

    const r = await fetch(BACKEND() + "/api/ai/classify", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(history.length ? { history } : { text: state.lastMsg.get(chatid) || "" }),
    })
    if (!r.ok) throw new Error(await r.text())
    const data = await r.json()

    const rec = voteStage(chatid, { stage: data.stage, confidence: data.confidence, reason: data.reason, key })

    const curId = state.current && (state.current.wa_chatid || state.current.chatid || state.current.wa_fastid || state.current.wa_id)
    if (curId === chatid) upsertAIPill(rec.stage, rec.confidence, rec.reason)

    return rec
  } catch (e) {
    console.warn("IA classify falhou:", e?.message || e)
    return getStage(chatid)
  }
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
