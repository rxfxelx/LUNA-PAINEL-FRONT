/* ========= CONFIG/HELPERS ========= */
const BACKEND = () => (window.__BACKEND_URL__ || "").replace(/\/+$/, "")
const $ = (s) => document.querySelector(s)
const show = (sel) => $(sel).classList.remove("hidden")
const hide = (sel) => $(sel).classList.add("hidden")

// Idle callback (não bloqueia UI)
const rIC = (cb) => (window.requestIdleCallback ? window.requestIdleCallback(cb, { timeout: 200 }) : setTimeout(cb, 0))

// Limitador de concorrência simples
async function runLimited(tasks, limit = 8) {
  const results = []
  let i = 0
  const workers = new Array(Math.min(limit, tasks.length)).fill(0).map(async () => {
    while (i < tasks.length) {
      const cur = i++
      try {
        results[cur] = await tasks[cur]()
      } catch (e) {
        results[cur] = undefined
      }
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
  // chatid -> {stage, at, lastKey}
  aiStage: new Map(),
  aiStageLoaded: false,

  // Splash
  splash: { shown: false, timer: null, forceTimer: null },
}

/* ========= STAGES (Contatos, Lead, Lead Quente) ========= */
const STAGES = ["contatos", "lead", "lead_quente"]
const STAGE_LABEL = { contatos: "Contatos", lead: "Lead", lead_quente: "Lead Quente" }
const STAGE_RANK = { contatos: 0, lead: 1, lead_quente: 2 }

function normalizeStage(s) {
  const k = String(s || "")
    .toLowerCase()
    .trim()
  if (k.startsWith("contato")) return "contatos"
  if (k.includes("lead_quente") || k.includes("quente")) return "lead_quente"
  if (k === "lead") return "lead"
  return "contatos"
}
function maxStage(a, b) {
  a = normalizeStage(a)
  b = normalizeStage(b)
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
  state.aiStage.forEach((v, k) => {
    obj[k] = v
  })
  localStorage.setItem("luna_ai_stage", JSON.stringify(obj))
}
function getStage(chatid) {
  loadStageCache()
  return state.aiStage.get(chatid) || null
}
function setStage(chatid, nextStage, key) {
  loadStageCache()
  const cur = getStage(chatid) || { stage: "contatos", at: 0, lastKey: null }
  const stage = maxStage(cur.stage, normalizeStage(nextStage))
  const rec = { stage, at: Date.now(), lastKey: key || cur.lastKey }
  state.aiStage.set(chatid, rec)
  saveStageCache()
  return rec
}

/* ========= CRM (mantido, mas sem botões/sem render de barra) ========= */
const CRM_STAGES = ["novo", "sem_resposta", "interessado", "em_negociacao", "fechou", "descartado"]

async function apiCRMViews() {
  return api("/api/crm/views")
}
async function apiCRMList(stage, limit = 100, offset = 0) {
  const qs = new URLSearchParams({ stage, limit, offset }).toString()
  return api("/api/crm/list?" + qs)
}
async function apiCRMSetStatus(chatid, stage, notes = "") {
  return api("/api/crm/status", { method: "POST", body: JSON.stringify({ chatid, stage, notes }) })
}
function ensureCRMBar() {
  /* no-op: escondido por padrão */
}
async function refreshCRMCounters() {
  try {
    const data = await apiCRMViews()
    const counts = data?.counts || {}
    const el = document.querySelector(".crm-counters")
    if (el) {
      const parts = CRM_STAGES.map((s) => `${s.replace("_", " ")}: ${counts[s] || 0}`)
      el.textContent = parts.join(" • ")
    }
  } catch {}
}
async function loadCRMStage(stage) {
  const list = $("#chat-list")
  list.innerHTML = "<div class='hint'>Carregando visão CRM...</div>"
  try {
    const data = await apiCRMList(stage, 100, 0)
    const items = []
    for (const it of data?.items || []) {
      const ch = it.chat || {}
      if (!ch.wa_chatid && it.crm?.chatid) ch.wa_chatid = it.crm.chatid
      items.push(ch)
    }
    await progressiveRenderChats(items)
    await prefetchCards(items)
  } catch (e) {
    list.innerHTML = `<div class='error'>Falha ao carregar CRM: ${escapeHtml(e.message || "")}</div>`
  } finally {
    refreshCRMCounters()
  }
}
function attachCRMControlsToCard(cardEl, chatObj) {
  return
}

/* ========= SPLASH ========= */
function createSplash() {
  if (state.splash.shown) return
  show("#loading-view")
  state.splash.shown = true

  // Força ocultar em até 7s (máximo)
  state.splash.forceTimer = setTimeout(hideSplash, 7000)
}
function hideSplash() {
  hide("#loading-view")
  state.splash.shown = false
  if (state.splash.timer) {
    clearTimeout(state.splash.timer)
    state.splash.timer = null
  }
  if (state.splash.forceTimer) {
    clearTimeout(state.splash.forceTimer)
    state.splash.forceTimer = null
  }
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
  ensureStageTabs()

  // Splash (máx. 7s) enquanto iniciamos carregamentos + classificações
  createSplash()

  // Carregar conversas (progressivo); splash some assim que a 1ª leva for renderizada
  loadChats().finally(() => {
    // dá um respiro de 300ms para evitar "piscar"
    state.splash.timer = setTimeout(hideSplash, 300)
  })
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

  const addBtn = (key, label, onclick) => {
    const b = document.createElement("button")
    b.className = "btn"
    b.dataset.stage = key
    b.textContent = label
    b.onclick = onclick
    return b
  }

  const btnGeral = addBtn("geral", "Geral", () => loadChats())
  const btnCont = addBtn("contatos", "Contatos", () => loadStageTab("contatos"))
  const btnLead = addBtn("lead", "Lead", () => loadStageTab("lead"))
  const btnLQ = addBtn("lead_quente", "Lead Quente", () => loadStageTab("lead_quente"))

  bar.appendChild(btnGeral)
  bar.appendChild(btnCont)
  bar.appendChild(btnLead)
  bar.appendChild(btnLQ)

  const counters = document.createElement("div")
  counters.className = "stage-counters"

  host.appendChild(bar)
  host.appendChild(counters)

  ensureMobileStageTabs()

  refreshStageCounters()
}

function ensureMobileStageTabs() {
  if (document.querySelector(".stage-tabs-mobile")) return

  const mobileBar = document.createElement("div")
  mobileBar.className = "stage-tabs-mobile"

  const addMobileBtn = (key, label, onclick) => {
    const b = document.createElement("button")
    b.className = "btn"
    b.dataset.stage = key
    b.textContent = label
    b.onclick = () => {
      // Remove active de todos
      mobileBar.querySelectorAll(".btn").forEach((btn) => btn.classList.remove("active"))
      // Adiciona active no clicado
      b.classList.add("active")
      onclick()
    }
    return b
  }

  const btnGeral = addMobileBtn("geral", "Geral", () => loadChats())
  const btnCont = addMobileBtn("contatos", "Contatos", () => loadStageTab("contatos"))
  const btnLead = addMobileBtn("lead", "Lead", () => loadStageTab("lead"))
  const btnLQ = addMobileBtn("lead_quente", "Quente", () => loadStageTab("lead_quente"))

  // Marca Geral como ativo por padrão
  btnGeral.classList.add("active")

  mobileBar.appendChild(btnGeral)
  mobileBar.appendChild(btnCont)
  mobileBar.appendChild(btnLead)
  mobileBar.appendChild(btnLQ)

  document.body.appendChild(mobileBar)
}

function loadStageTab(stage) {
  // Placeholder function for loadStageTab
  console.log(`Loading stage tab: ${stage}`)
}

function refreshStageCounters() {
  // Placeholder function for refreshStageCounters
  console.log("Refreshing stage counters")
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

    // Classifica todas em background (regras locais)
    try {
      await classifyAllChatsInBackground(items)
      refreshStageCounters()
    } catch {}

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
            )
              .replace(/\s+/g, " ")
              .trim()
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
  if (st) upsertAIPill(st.stage)

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

    // Classificação local pelas regras
    try {
      await classifyAndPersist(chatid, items)
      refreshStageCounters()
      const st = getStage(chatid)
      if (st) upsertAIPill(st.stage)
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

/* ========= "PILL" de estágio (usa dados locais) ========= */
function upsertAIPill(stage) {
  let pill = document.getElementById("ai-pill")
  if (!pill) {
    pill = document.createElement("span")
    pill.id = "ai-pill"
    pill.className = "ai-pill"
    const header = document.querySelector(".chatbar") || document.querySelector(".chat-title") || document.body
    header.appendChild(pill)
  }
  const label = STAGE_LABEL[normalizeStage(stage)] || stage
  pill.textContent = label
  pill.title = ""
}

// hash simples do histórico
function makeTranscriptKey(items) {
  if (!Array.isArray(items) || !items.length) return "empty"
  const lastTs = items[0]?.messageTimestamp || items[0]?.timestamp || 0
  const len = items.length
  const tail = (items[0]?.text || items[0]?.body || "").slice(0, 64)
  return `${len}:${lastTs}:${tail.length}`
}

/* ========= CLASSIFICAÇÃO POR REGRAS (SEM IA) ========= */
// Normaliza strings para comparação tolerante
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove acentos
    .replace(/\s+/g, " ")
    .trim()
}

// Regras:
// - Lead Quente: mensagem nossa indicando encaminhamento/transferência.
// - Lead: mensagem nossa "sim, pode continuar" (tolerante).
// - Contatos: padrão/else.
function classifyByRules(items) {
  const msgs = Array.isArray(items) ? items : []
  let stage = "contatos"

  // Regras para Lead Quente: mensagens sobre encaminhamento/transferência
  const hotHints = [
    "vou te passar para",
    "vou te passar pro",
    "vou encaminhar",
    "encaminhando seu contato",
    "colocar voce em contato",
    "colocar você em contato",
    "o time comercial vai te chamar",
    "nossa equipe vai entrar em contato",
    "o setor vai entrar em contato",
    "vou pedir para alguem te chamar",
    "vou transferir",
    "vou passar seu numero",
    "vou passar o seu numero",
    "vou passar seu número",
    "vou passar o seu número",
    "vamos transferir",
    "ela vai ser encaminhada",
    "você vai ser encaminhada",
    "vou colocar em contato",
    "vou te colocar em contato",
  ].map(norm)

  // Regras para Lead: "Sim, pode continuar"
  const leadPatterns = [
    "sim, pode continuar",
    "pode continuar",
    "sim pode continuar",
    "pode prosseguir",
    "sim, pode prosseguir",
  ].map(norm)

  for (const m of msgs) {
    const me = m.fromMe || m.fromme || m.from_me || false
    const text = norm(m.text || m.caption || m?.message?.text || m?.message?.conversation || m?.body || "")
    if (!text) continue

    // Só analisamos mensagens nossas (do atendente)
    if (me) {
      // Lead Quente: mensagens sobre encaminhamento/transferência
      if (hotHints.some((h) => text.includes(h))) {
        stage = "lead_quente"
        break // já é o topo da hierarquia
      }
      // Lead: "Sim, pode continuar"
      if (leadPatterns.some((p) => text.includes(p))) {
        stage = maxStage(stage, "lead")
      }
    }
  }

  return stage
}

async function classifyAndPersist(chatid, items) {
  const key = makeTranscriptKey(items)
  const current = getStage(chatid)
  if (current?.lastKey === key) return current

  const stage = classifyByRules(items)
  const rec = setStage(chatid, stage, key)
  return rec
}

async function classifyAllChatsInBackground(items) {
  const tasks = (items || []).map((ch) => async () => {
    const chatid = ch.wa_chatid || ch.chatid || ch.wa_fastid || ch.wa_id || ""
    if (!chatid) return
    try {
      const data = await api("/api/messages", {
        method: "POST",
        body: JSON.stringify({ chatid, limit: 200, sort: "-messageTimestamp" }),
      })
      const msgs = Array.isArray(data?.items) ? data.items : []
      await classifyAndPersist(chatid, msgs)
    } catch (e) {
      /* ignora */
    }
  })

  const CHUNK = 10
  for (let i = 0; i < tasks.length; i += CHUNK) {
    const slice = tasks.slice(i, i + CHUNK)
    await runLimited(slice, 5)
    await new Promise((r) => rIC(r))
  }
}

/* ========= SUA renderização "clássica" (mantida) ========= */
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
