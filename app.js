/* =========================================
 * 1) CONFIG / HELPERS BÁSICOS
 * ======================================= */
const BACKEND = () => (window.__BACKEND_URL__ || "").replace(/\/+$/, "")
const $ = (s) => document.querySelector(s)
const show = (sel) => $(sel).classList.remove("hidden")
const hide = (sel) => $(sel).classList.add("hidden")

// Idle callback
const rIC = (cb) => (window.requestIdleCallback ? window.requestIdleCallback(cb, { timeout: 200 }) : setTimeout(cb, 0))

// Limitador de concorrência
async function runLimited(tasks, limit = 8) {
  const results = []
  let i = 0
  const workers = new Array(Math.min(limit, tasks.length)).fill(0).map(async () => {
    while (i < tasks.length) {
      const cur = i++
      try {
        results[cur] = await tasks[cur]()
      } catch {
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
  return res.json().catch(() => ({}))
}

function escapeHtml(s) {
  return String(s || "").replace(
    /[&<>"']/g,
    (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m],
  )
}
function truncatePreview(s, max = 90) {
  const t = String(s || "")
    .replace(/\s+/g, " ")
    .trim()
  if (!t) return ""
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t
}

/* ========= NDJSON STREAM ========= */
async function* readNDJSONStream(resp) {
  const reader = resp.body.getReader()
  const decoder = new TextDecoder("utf-8")
  let buf = ""
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      try {
        yield JSON.parse(line)
      } catch {}
    }
  }
  if (buf.trim()) {
    try {
      yield JSON.parse(buf.trim())
    } catch {}
  }
}

/* =========================================
 * 2) STATE GLOBAL + ORDENAÇÃO POR RECÊNCIA
 * ======================================= */
const state = {
  chats: [],
  current: null,
  lastMsg: new Map(),
  lastMsgFromMe: new Map(),
  nameCache: new Map(),
  unread: new Map(),
  loadingChats: false,
  stages: new Map(),
  stagesLoaded: true,
  splash: { shown: false, timer: null, forceTimer: null },
  activeTab: "geral",
  listReqId: 0, // versão da renderização atual da lista
  lastTs: new Map(), // chatid -> timestamp (ms) da última atividade conhecida
  orderDirty: false, // sinaliza reordenação pendente
}

// Utilitários de timestamp/ordenação
function toMs(x) {
  const n = Number(x || 0)
  if (String(x).length === 10) return n * 1000 // epoch em segundos
  return isNaN(n) ? 0 : n
}
function updateLastActivity(chatid, ts) {
  if (!chatid) return
  const cur = state.lastTs.get(chatid) || 0
  const val = toMs(ts)
  if (val > cur) {
    state.lastTs.set(chatid, val)
    state.orderDirty = true
    scheduleReorder()
  }
}
let reorderTimer = null
function scheduleReorder() {
  if (reorderTimer) return
  reorderTimer = setTimeout(() => {
    reorderTimer = null
    if (!state.orderDirty) return
    state.orderDirty = false
    reorderChatList()
  }, 60)
}
function reorderChatList() {
  const list = document.getElementById("chat-list")
  if (!list) return
  const cards = Array.from(list.querySelectorAll(".chat-item"))
  if (!cards.length) return

  cards.sort((a, b) => {
    const ta = state.lastTs.get(a.dataset.chatid) || 0
    const tb = state.lastTs.get(b.dataset.chatid) || 0
    return tb - ta // mais recente no topo
  })
  cards.forEach((el) => list.appendChild(el))
}

/* =========================================
 * 3) FILA GLOBAL DE BACKGROUND (não para ao trocar de aba)
 * ======================================= */
const bgQueue = []
let bgRunning = false
function pushBg(task) {
  bgQueue.push(task)
  if (!bgRunning) runBg()
}
async function runBg() {
  bgRunning = true
  while (bgQueue.length) {
    const batch = bgQueue.splice(0, 16)
    await runLimited(batch, 8)
    await new Promise((r) => rIC(r))
  }
  bgRunning = false
}

/* =========================================
 * 4) PIPE DE STAGES (classificação)
 * ======================================= */
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
function getStage(chatid) {
  return state.stages.get(chatid) || null
}
function setStage(chatid, nextStage) {
  const stage = normalizeStage(nextStage)
  const rec = { stage, at: Date.now() }
  state.stages.set(chatid, rec)
  return rec
}

/* =========================================
 * 5) CRM (contadores/visões)
 * ======================================= */
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
function ensureCRMBar() {}
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
function attachCRMControlsToCard() {}

/* =========================================
 * 6) SPLASH / LOGIN / ROUTER
 * ======================================= */
function createSplash() {
  if (state.splash.shown) return
  const el = document.createElement("div")
  el.id = "luna-splash"
  el.className = "splash-screen"

  const logoContainer = document.createElement("div")
  logoContainer.className = "splash-logos-container"

  const lunaLogoDiv = document.createElement("div")
  lunaLogoDiv.className = "splash-logo-luna active"
  const lunaLogo = document.createElement("img")
  lunaLogo.src = "lunapngcinza.png"
  lunaLogo.alt = "Luna Logo"
  lunaLogo.className = "splash-logo"
  lunaLogoDiv.appendChild(lunaLogo)

  const helseniaLogoDiv = document.createElement("div")
  helseniaLogoDiv.className = "splash-logo-helsenia"
  const helseniaLogo = document.createElement("img")
  helseniaLogo.src = "logohelsenia.png"
  helseniaLogo.alt = "Helsenia Logo"
  helseniaLogo.className = "splash-logo"
  helseniaLogoDiv.appendChild(helseniaLogo)

  const progressContainer = document.createElement("div")
  progressContainer.className = "splash-progress-container"

  const progressBar = document.createElement("div")
  progressBar.className = "splash-progress-bar"
  progressContainer.appendChild(progressBar)

  logoContainer.appendChild(lunaLogoDiv) // Luna primeiro
  logoContainer.appendChild(helseniaLogoDiv) // Helsenia segundo
  el.appendChild(logoContainer)
  el.appendChild(progressContainer)
  document.body.appendChild(el)

  setTimeout(() => {
    progressBar.classList.add("animate")
  }, 100)

  setTimeout(() => {
    lunaLogoDiv.classList.remove("active") // Luna sai primeiro
    setTimeout(() => {
      helseniaLogoDiv.classList.add("active") // Helsenia entra depois
    }, 500)
  }, 4000)

  state.splash.shown = true
  state.splash.forceTimer = setTimeout(hideSplash, 8000)
}

function hideSplash() {
  const el = document.getElementById("luna-splash")
  if (el) el.remove()
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

async function doLogin() {
  const token = $("#token")?.value?.trim()
  const msgEl = $("#msg")
  const btnEl = $("#btn-login")
  if (!token) {
    if (msgEl) msgEl.textContent = "Por favor, cole o token da instância"
    return
  }
  if (msgEl) msgEl.textContent = ""
  if (btnEl) {
    btnEl.disabled = true
    btnEl.innerHTML = "<span>Conectando...</span>"
  }
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
    if (msgEl) msgEl.textContent = "Token inválido. Verifique e tente novamente."
  } finally {
    if (btnEl) {
      btnEl.disabled = false
      btnEl.innerHTML =
        '<span>Entrar no Sistema</span><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>'
    }
  }
}

function ensureTopbar() {
  if (!$(".topbar")) {
    const tb = document.createElement("div")
    tb.className = "topbar"
    tb.style.display = "flex"
    tb.style.alignItems = "center"
    tb.style.gap = "8px"
    tb.style.padding = "8px 12px"
    const host = $("#app-view") || document.body
    host.prepend(tb)
  }
}

function switchToApp() {
  hide("#login-view")
  show("#app-view")
  setMobileMode("list")
  ensureTopbar()
  ensureCRMBar()
  ensureStageTabs()
  createSplash()
  loadChats().finally(() => {
    // state.splash.timer = setTimeout(hideSplash, 5300)
  })
}
function ensureRoute() {
  if (jwt()) switchToApp()
  else {
    show("#login-view")
    hide("#app-view")
  }
}

/* =========================================
 * 7) AVATAR / NOME
 * ======================================= */
async function fetchNameImage(chatid, preview = true) {
  try {
    const resp = await api("/api/name-image", { method: "POST", body: JSON.stringify({ number: chatid, preview }) })
    return resp
  } catch {
    return { name: null, image: null, imagePreview: null }
  }
}
function initialsOf(str) {
  const s = (str || "").trim()
  if (!s) return "??"
  const parts = s.split(/\s+/).slice(0, 2)
  return parts.map((p) => p[0]?.toUpperCase() || "").join("") || "??"
}

/* =========================================
 * 8) ABAS DE STAGE (UI)
 * ======================================= */
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
    b.onclick = () => {
      state.activeTab = key
      onclick()
      host.querySelectorAll(".stage-tabs .btn").forEach((x) => x.classList.remove("active"))
      b.classList.add("active")
      const mobileSelect = document.getElementById("mobile-stage-select")
      if (mobileSelect) mobileSelect.value = key
    }
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
  counters.style.marginLeft = "8px"
  counters.style.color = "var(--sub2)"
  counters.style.fontSize = "12px"

  host.appendChild(bar)
  host.appendChild(counters)

  const mobileSelect = document.getElementById("mobile-stage-select")
  if (mobileSelect) {
    mobileSelect.onchange = (e) => {
      const key = e.target.value
      state.activeTab = key
      switch (key) {
        case "geral":
          loadChats()
          break
        case "contatos":
          loadStageTab("contatos")
          break
        case "lead":
          loadStageTab("lead")
          break
        case "lead_quente":
          loadStageTab("lead_quente")
          break
      }
      const btn = host.querySelector(`.stage-tabs .btn[data-stage="${key}"]`)
      if (btn) {
        host.querySelectorAll(".stage-tabs .btn").forEach((x) => x.classList.remove("active"))
        btn.classList.add("active")
      }
    }
  }

  setTimeout(() => {
    const btn = host.querySelector(`.stage-tabs .btn[data-stage="${state.activeTab}"]`) || btnGeral
    btn.click()
  }, 0)
}

function refreshStageCounters() {
  const counts = { contatos: 0, lead: 0, lead_quente: 0 }
  state.chats.forEach((ch) => {
    const chatid = ch.wa_chatid || ch.chatid || ch.wa_fastid || ch.wa_id || ""
    const st = getStage(chatid)?.stage || "contatos"
    if (counts[st] !== undefined) counts[st]++
  })

  const el = document.querySelector(".stage-counters")
  if (el) el.textContent = `contatos: ${counts.contatos} • lead: ${counts.lead} • lead quente: ${counts.lead_quente}`

  const mobileContatos = document.getElementById("mobile-counter-contatos")
  const mobileLead = document.getElementById("mobile-counter-lead")
  const mobileLeadQuente = document.getElementById("mobile-counter-lead_quente")
  if (mobileContatos) mobileContatos.textContent = counts.contatos
  if (mobileLead) mobileLead.textContent = counts.lead
  if (mobileLeadQuente) mobileLeadQuente.textContent = counts.lead_quente
}

async function loadStageTab(stageKey) {
  const reqId = ++state.listReqId
  const list = $("#chat-list")
  list.innerHTML = "<div class='hint'>Carregando…</div>"

  const filtered = state.chats.filter((ch) => {
    const chatid = ch.wa_chatid || ch.chatid || ch.wa_fastid || ch.wa_id || ""
    const st = getStage(chatid)?.stage || "contatos"
    return st === stageKey
  })

  await progressiveRenderChats(filtered, reqId)
  await prefetchCards(filtered)
}

/* =========================================
 * 9) CHATS (stream + prefetch + ordenação)
 * ======================================= */
async function loadChats() {
  if (state.loadingChats) return
  state.loadingChats = true

  const reqId = ++state.listReqId
  const startTab = state.activeTab

  const list = $("#chat-list")
  if (list) list.innerHTML = "<div class='hint'>Carregando conversas...</div>"

  try {
    const res = await fetch(BACKEND() + "/api/chats/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ operator: "AND", sort: "-wa_lastMsgTimestamp" }),
    })
    if (!res.ok || !res.body) throw new Error("Falha no stream de conversas")

    if (reqId !== state.listReqId) return
    if (list) list.innerHTML = ""
    state.chats = []

    for await (const item of readNDJSONStream(res)) {
      if (item?.error) continue

      // mantém o array completo
      state.chats.push(item)

      // timestamp base do card (fallback do backend)
      const baseTs = item.wa_lastMsgTimestamp || item.messageTimestamp || item.updatedAt || 0
      const id = item.wa_chatid || item.chatid || item.wa_fastid || item.wa_id || ""
      updateLastActivity(id, baseTs)

      // DOM só se ainda estiver na mesma visão
      if (state.activeTab === "geral" && startTab === "geral" && reqId === state.listReqId) {
        const curList = $("#chat-list")
        if (curList) appendChatSkeleton(curList, item)
      }

      // --- BACKGROUND: nome/imagem + preview + classificação
      if (!id) continue

      pushBg(async () => {
        // nome/imagem
        try {
          if (!state.nameCache.has(id)) {
            const resp = await fetchNameImage(id)
            state.nameCache.set(id, resp || {})
            const cardEl = document.querySelector(`.chat-item[data-chatid="${CSS.escape(id)}"]`)
            if (cardEl) hydrateChatCard(item)
          }
        } catch {}

        // última mensagem para preview
        try {
          const latest = await api("/api/messages", {
            method: "POST",
            body: JSON.stringify({ chatid: id, limit: 1, sort: "-messageTimestamp" }),
          })
          const last = Array.isArray(latest?.items) ? latest.items[0] : null
          const pv = last
            ? (last.text || last.caption || last?.message?.text || last?.message?.conversation || last?.body || "")
                .replace(/\s+/g, " ")
                .trim()
            : ""
          const fromMe = last ? isFromMe(last) : false

          state.lastMsg.set(id, pv)
          state.lastMsgFromMe.set(id, fromMe)

          const card = document.querySelector(`.chat-item[data-chatid="${CSS.escape(id)}"] .preview`)
          if (card) {
            const txt = pv ? (fromMe ? "Você: " : "") + truncatePreview(pv, 90) : "Sem mensagens"
            card.textContent = txt
            card.title = pv ? (fromMe ? "Você: " : "") + pv : "Sem mensagens"
          }
          if (last) {
            updateLastActivity(id, last.messageTimestamp || last.timestamp || last.t || Date.now())
            const tEl = document.querySelector(`.chat-item[data-chatid="${CSS.escape(id)}"] .time`)
            if (tEl) tEl.textContent = formatTime(last.messageTimestamp || last.timestamp || last.t || "")
          }
        } catch {
          const card = document.querySelector(`.chat-item[data-chatid="${CSS.escape(id)}"] .preview`)
          if (card) {
            card.textContent = "Sem mensagens"
            card.title = "Sem mensagens"
          }
          // fallback: mantém ordenação com base no ts do chat
          const base = state.chats.find((c) => (c.wa_chatid || c.chatid || c.wa_fastid || c.wa_id || "") === id) || {}
          updateLastActivity(id, base.wa_lastMsgTimestamp || base.messageTimestamp || base.updatedAt || 0)
        }

        // classificação
        try {
          const pack = await api("/api/messages", {
            method: "POST",
            body: JSON.stringify({ chatid: id, limit: 20, sort: "-messageTimestamp" }),
          })
          const items = Array.isArray(pack?.items) ? pack.items : []
          const r = await api("/api/media/stage/classify", {
            method: "POST",
            body: JSON.stringify({ chatid: id, messages: items }),
          })
          const stage = normalizeStage(r?.stage || "")
          if (stage) {
            const rec = setStage(id, stage)
            if (state.current && (state.current.wa_chatid || state.current.chatid) === id) upsertStagePill(rec.stage)
            rIC(refreshStageCounters)
          }
        } catch {}
      })
    }

    // se usuário trocou de aba, renderiza filtrado
    if (state.activeTab !== "geral") await loadStageTab(state.activeTab)

    try {
      await api("/api/crm/sync", { method: "POST", body: JSON.stringify({ limit: 1000 }) })
      refreshCRMCounters()
    } catch {}
  } catch (e) {
    console.error(e)
    if (list && reqId === state.listReqId)
      list.innerHTML = `<div class='error'>${escapeHtml(e.message || "Falha ao carregar conversas")}</div>`
  } finally {
    if (reqId === state.listReqId) state.loadingChats = false
  }
}

/* =========================================
 * 10) LISTA (render + cards)
 * ======================================= */
async function progressiveRenderChats(chats, reqId = null) {
  const list = $("#chat-list")
  if (!list) return
  list.innerHTML = ""
  if (chats.length === 0) {
    if (reqId !== null && reqId !== state.listReqId) return
    list.innerHTML = "<div class='hint'>Nenhuma conversa encontrada</div>"
    return
  }
  const BATCH = 14
  for (let i = 0; i < chats.length; i += BATCH) {
    if (reqId !== null && reqId !== state.listReqId) return
    const slice = chats.slice(i, i + BATCH)
    slice.forEach((ch) => {
      if (reqId !== null && reqId !== state.listReqId) return
      appendChatSkeleton(list, ch)
    })
    await new Promise((r) => rIC(r))
  }
  chats.forEach((ch) => {
    if (reqId !== null && reqId !== state.listReqId) return
    hydrateChatCard(ch)
  })
  // garante ordem inicial
  reorderChatList()
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
  preview.textContent = "Carregando..."
  preview.title = "Carregando..."

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

  // alimenta atividade base para ordenação
  const baseTs = ch.wa_lastMsgTimestamp || ch.messageTimestamp || ch.updatedAt || 0
  updateLastActivity(el.dataset.chatid, baseTs)

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

/* =========================================
 * 11) PREFETCH (nomes/últimas/classificação leve)
 * ======================================= */
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
            const fromMe = isFromMe(last)
            state.lastMsgFromMe.set(chatid, fromMe)
            const card = document.querySelector(`.chat-item[data-chatid="${CSS.escape(chatid)}"] .preview`)
            if (card) {
              const txt = (fromMe ? "Você: " : "") + (pv ? truncatePreview(pv, 90) : "Sem mensagens")
              card.textContent = txt
              card.title = (fromMe ? "Você: " : "") + pv
            }
            const tEl = document.querySelector(`.chat-item[data-chatid="${CSS.escape(chatid)}"] .time`)
            if (tEl) tEl.textContent = formatTime(last.messageTimestamp || last.timestamp || last.t || "")
            updateLastActivity(chatid, last.messageTimestamp || last.timestamp || last.t || Date.now())
          } else {
            const card = document.querySelector(`.chat-item[data-chatid="${CSS.escape(chatid)}"] .preview`)
            if (card) {
              card.textContent = "Sem mensagens"
              card.title = "Sem mensagens"
            }
            updateLastActivity(chatid, ch.wa_lastMsgTimestamp || ch.messageTimestamp || ch.updatedAt || 0)
          }
        } catch {}
      }
      // classificação leve
      try {
        const pack = await api("/api/messages", {
          method: "POST",
          body: JSON.stringify({ chatid, limit: 20, sort: "-messageTimestamp" }),
        })
        const items = Array.isArray(pack?.items) ? pack.items : []
        const r = await api("/api/media/stage/classify", {
          method: "POST",
          body: JSON.stringify({ chatid, messages: items }),
        })
        const stage = normalizeStage(r?.stage || "")
        if (stage) {
          setStage(chatid, stage)
          rIC(refreshStageCounters)
        }
      } catch {}
    }
  })

  const CHUNK = 16
  for (let i = 0; i < tasks.length; i += CHUNK) {
    const slice = tasks.slice(i, i + CHUNK)
    await runLimited(slice, 8)
    await new Promise((r) => rIC(r))
  }
}

/* =========================================
 * 12) FORMATAÇÃO DE HORA (HH:mm) e DIAS (Xd)
 * ======================================= */
function formatTime(ts) {
  if (!ts) return ""
  try {
    const d = new Date(ts)
    const now = new Date()
    const diffMs = now - d
    const diffH = diffMs / 36e5
    if (diffH < 24) {
      const hh = String(d.getHours()).padStart(2, "0")
      const mm = String(d.getMinutes()).padStart(2, "0")
      return `${hh}:${mm}`
    }
    const diffD = Math.floor(diffMs / 86400000)
    return `${diffD}d`
  } catch {
    return ""
  }
}

/* =========================================
 * 13) ABRIR CHAT / CARREGAR MENSAGENS
 * ======================================= */
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
  if (st) upsertStagePill(st.stage)

  if (status) status.textContent = "Online"
}

async function classifyInstant(chatid, items) {
  try {
    const r = await api("/api/media/stage/classify", {
      method: "POST",
      body: JSON.stringify({ chatid, messages: items }),
    })
    const stage = normalizeStage(r?.stage || "")
    if (stage) {
      const rec = setStage(chatid, stage)
      upsertStagePill(rec.stage)
      refreshStageCounters()
      return rec
    }
  } catch {}
  return null
}

// Ordenação por timestamp real
function tsOf(m) {
  return Number(m?.messageTimestamp ?? m?.timestamp ?? m?.t ?? m?.message?.messageTimestamp ?? 0)
}

async function loadMessages(chatid) {
  const pane = $("#messages")
  if (pane) pane.innerHTML = "<div class='hint'>Carregando mensagens...</div>"
  try {
    const data = await api("/api/messages", {
      method: "POST",
      body: JSON.stringify({ chatid, limit: 200, sort: "-messageTimestamp" }),
    })
    let items = Array.isArray(data?.items) ? data.items : []

    // ordem cronológica ascendente
    items = items.slice().sort((a, b) => tsOf(a) - tsOf(b))

    await classifyInstant(chatid, items)
    await progressiveRenderMessages(items)

    const last = items[items.length - 1]
    const pv = (last?.text || last?.caption || last?.message?.text || last?.message?.conversation || last?.body || "")
      .replace(/\s+/g, " ")
      .trim()
    if (pv) state.lastMsg.set(chatid, pv)
    state.lastMsgFromMe.set(chatid, isFromMe(last || {}))

    if (last) {
      updateLastActivity(chatid, last.messageTimestamp || last.timestamp || last.t || Date.now())
      const tEl = document.querySelector(`.chat-item[data-chatid="${CSS.escape(chatid)}"] .time`)
      if (tEl) tEl.textContent = formatTime(last.messageTimestamp || last.timestamp || last.t || "")
    }
  } catch (e) {
    console.error(e)
    if (pane) pane.innerHTML = `<div class='error'>Falha ao carregar mensagens: ${escapeHtml(e.message || "")}</div>`
  }
}

/* =========================================
 * 14) RENDERIZAÇÃO DE MENSAGENS (batches)
 * ======================================= */
async function progressiveRenderMessages(msgs) {
  const pane = $("#messages")
  if (!pane) return
  pane.innerHTML = ""

  if (!msgs.length) {
    pane.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">💬</div>
        <h3>Nenhuma mensagem</h3>
        <p>Esta conversa ainda não possui mensagens</p>
      </div>`
    return
  }

  const BATCH = 12
  for (let i = 0; i < msgs.length; i += BATCH) {
    const slice = msgs.slice(i, i + BATCH)
    slice.forEach((m) => {
      try {
        appendMessageBubble(pane, m)
      } catch {
        const el = document.createElement("div")
        el.className = "msg you"
        el.innerHTML =
          "(mensagem não suportada)<small style='display:block;opacity:.7;margin-top:6px'>Erro ao renderizar</small>"
        pane.appendChild(el)
      }
    })
    await new Promise((r) => rIC(r))
    pane.scrollTop = pane.scrollHeight
  }
}

/* =========================================
 * 15) MÍDIA / INTERATIVOS / REPLIES
 * ======================================= */
function pickMediaInfo(m) {
  const mm = m.message || m

  const mime =
    m.mimetype ||
    m.mime ||
    mm?.imageMessage?.mimetype ||
    mm?.videoMessage?.mimetype ||
    mm?.documentMessage?.mimetype ||
    mm?.audioMessage?.mimetype ||
    (mm?.stickerMessage ? "image/webp" : "") ||
    ""

  const url =
    m.mediaUrl ||
    m.url ||
    m.fileUrl ||
    m.downloadUrl ||
    m.image ||
    m.video ||
    mm?.imageMessage?.url ||
    mm?.videoMessage?.url ||
    mm?.documentMessage?.url ||
    mm?.stickerMessage?.url ||
    mm?.audioMessage?.url ||
    ""

  const dataUrl =
    m.dataUrl ||
    mm?.imageMessage?.dataUrl ||
    mm?.videoMessage?.dataUrl ||
    mm?.documentMessage?.dataUrl ||
    mm?.stickerMessage?.dataUrl ||
    mm?.audioMessage?.dataUrl ||
    ""

  const caption =
    m.caption ||
    mm?.imageMessage?.caption ||
    mm?.videoMessage?.caption ||
    mm?.documentMessage?.caption || // caption de doc
    mm?.documentMessage?.fileName || // fallback: nome do arquivo
    m.text ||
    mm?.conversation ||
    m.body ||
    ""

  return {
    mime: String(mime || ""),
    url: String(url || ""),
    dataUrl: String(dataUrl || ""),
    caption: String(caption || ""),
  }
}

async function fetchMediaBlobViaProxy(rawUrl) {
  const q = encodeURIComponent(String(rawUrl || ""))
  const r = await fetch(BACKEND() + "/api/media/proxy?u=" + q, { method: "GET", headers: { ...authHeaders() } })
  if (!r.ok) throw new Error("Falha ao baixar mídia")
  return await r.blob()
}

// Reply preview (mais variações)
function renderReplyPreview(container, m) {
  const ctx =
    m?.message?.extendedTextMessage?.contextInfo ||
    m?.message?.imageMessage?.contextInfo ||
    m?.message?.videoMessage?.contextInfo ||
    m?.message?.stickerMessage?.contextInfo ||
    m?.message?.documentMessage?.contextInfo ||
    m?.message?.audioMessage?.contextInfo ||
    m?.contextInfo ||
    {}

  const qm = ctx.quotedMessage || m?.quotedMsg || m?.quoted_message || null

  if (!qm) return
  const qt =
    qm?.extendedTextMessage?.text ||
    qm?.conversation ||
    qm?.imageMessage?.caption ||
    qm?.videoMessage?.caption ||
    qm?.documentMessage?.caption ||
    qm?.text ||
    ""

  const box = document.createElement("div")
  box.className = "bubble-quote"
  box.style.borderLeft = "3px solid var(--muted, #ccc)"
  box.style.padding = "6px 8px"
  box.style.marginBottom = "6px"
  box.style.opacity = ".8"
  box.style.fontSize = "12px"
  box.textContent = qt || "(mensagem citada)"
  container.appendChild(box)
}

// Interativos
function renderInteractive(container, m) {
  const listMsg = m?.message?.listMessage
  const btnsMsg = m?.message?.buttonsMessage || m?.message?.templateMessage?.hydratedTemplate
  const listResp = m?.message?.listResponseMessage
  const btnResp = m?.message?.buttonsResponseMessage

  if (listMsg) {
    const card = document.createElement("div")
    card.className = "bubble-actions"
    card.style.border = "1px solid var(--muted,#ddd)"
    card.style.borderRadius = "8px"
    card.style.padding = "8px"
    card.style.maxWidth = "320px"
    if (listMsg.title) {
      const h = document.createElement("div")
      h.style.fontWeight = "600"
      h.style.marginBottom = "6px"
      h.textContent = listMsg.title
      card.appendChild(h)
    }
    if (listMsg.description) {
      const d = document.createElement("div")
      d.style.fontSize = "12px"
      d.style.opacity = ".85"
      d.style.marginBottom = "6px"
      d.textContent = listMsg.description
      card.appendChild(d)
    }
    ;(listMsg.sections || []).forEach((sec) => {
      if (sec.title) {
        const st = document.createElement("div")
        st.style.margin = "6px 0 4px"
        st.style.fontSize = "12px"
        st.style.opacity = ".8"
        st.textContent = sec.title
        card.appendChild(st)
      }
      ;(sec.rows || []).forEach((row) => {
        const opt = document.createElement("div")
        opt.style.padding = "6px 8px"
        opt.style.border = "1px solid var(--muted,#eee)"
        opt.style.borderRadius = "6px"
        opt.style.marginBottom = "6px"
        opt.textContent = row.title || row.id || "(opção)"
        card.appendChild(opt)
      })
    })
    container.appendChild(card)
    return true
  }

  if (btnsMsg) {
    const card = document.createElement("div")
    card.className = "bubble-actions"
    card.style.border = "1px solid var(--muted,#ddd)"
    card.style.borderRadius = "8px"
    card.style.padding = "8px"
    card.style.maxWidth = "320px"
    const title = btnsMsg.title || btnsMsg.hydratedTitle
    const text = btnsMsg.text || btnsMsg.hydratedContentText
    if (title) {
      const h = document.createElement("div")
      h.style.fontWeight = "600"
      h.style.marginBottom = "6px"
      h.textContent = title
      card.appendChild(h)
    }
    if (text) {
      const d = document.createElement("div")
      d.style.fontSize = "12px"
      d.style.opacity = ".85"
      d.style.marginBottom = "6px"
      d.textContent = text
      card.appendChild(d)
    }
    const buttons = btnsMsg.buttons || btnsMsg.hydratedButtons || []
    buttons.forEach((b) => {
      const lbl =
        b?.quickReplyButton?.displayText ||
        b?.urlButton?.displayText ||
        b?.callButton?.displayText ||
        b?.displayText ||
        "Opção"
      const btn = document.createElement("div")
      btn.textContent = lbl
      btn.style.display = "inline-block"
      btn.style.padding = "6px 10px"
      btn.style.border = "1px solid var(--muted,#eee)"
      btn.style.borderRadius = "999px"
      btn.style.margin = "4px 6px 0 0"
      btn.style.fontSize = "12px"
      btn.style.opacity = ".9"
      card.appendChild(btn)
    })
    container.appendChild(card)
    return true
  }

  if (listResp) {
    const picked = listResp?.singleSelectReply?.selectedRowId || listResp?.title || "(resposta de lista)"
    const tag = document.createElement("div")
    tag.style.display = "inline-block"
    tag.style.padding = "6px 10px"
    tag.style.border = "1px solid var(--muted,#ddd)"
    tag.style.borderRadius = "6px"
    tag.style.fontSize = "12px"
    tag.textContent = picked
    container.appendChild(tag)
    return true
  }

  if (btnResp) {
    const picked = btnResp?.selectedDisplayText || btnResp?.selectedButtonId || "(resposta)"
    const tag = document.createElement("div")
    tag.style.display = "inline-block"
    tag.style.padding = "6px 10px"
    tag.style.border = "1px solid var(--muted,#ddd)"
    tag.style.borderRadius = "6px"
    tag.style.fontSize = "12px"
    tag.textContent = picked
    container.appendChild(tag)
    return true
  }

  return false
}

/* =========================================
 * 16) AUTORIA (robusta)
 * ======================================= */
function isFromMe(m) {
  return !!(
    m?.fromMe ||
    m?.fromme ||
    m?.from_me ||
    m?.key?.fromMe ||
    m?.message?.key?.fromMe ||
    m?.sender?.fromMe ||
    (typeof m?.participant === "string" && /(:me|@s\.whatsapp\.net)$/i.test(m.participant)) ||
    (typeof m?.author === "string" &&
      (/(:me)$/i.test(m.author) || /@s\.whatsapp\.net/i.test(m.author)) &&
      m.fromMe === true) ||
    (typeof m?.id === "string" && /^true_/.test(m.id)) ||
    m?.user === "me"
  )
}

/* =========================================
 * 17) BOLHA DE MENSAGEM (mídias, texto, replies)
 * ======================================= */
function appendMessageBubble(pane, m) {
  const me = isFromMe(m)
  const el = document.createElement("div")
  el.className = "msg " + (me ? "me" : "you")

  const top = document.createElement("div")
  renderReplyPreview(top, m)
  const hadInteractive = renderInteractive(top, m)

  const { mime, url, dataUrl, caption } = pickMediaInfo(m)
  const plainText =
    m.text ||
    m.message?.text ||
    m?.message?.extendedTextMessage?.text ||
    m?.message?.conversation ||
    m.caption ||
    m.body ||
    ""
  const who = m.senderName || m.pushName || ""
  const ts = m.messageTimestamp || m.timestamp || m.t || ""

  // Sticker
  if (mime && /^image\/webp$/i.test(mime) && (url || dataUrl)) {
    const img = document.createElement("img")
    img.alt = "figurinha"
    img.style.maxWidth = "160px"
    img.style.borderRadius = "8px"
    if (top.childNodes.length) el.appendChild(top)
    el.appendChild(img)
    const meta = document.createElement("small")
    meta.textContent = `${escapeHtml(who)} • ${formatTime(ts)}`
    meta.style.display = "block"
    meta.style.marginTop = "6px"
    meta.style.opacity = ".75"
    el.appendChild(meta)
    pane.appendChild(el)
    const after = () => {
      pane.scrollTop = pane.scrollHeight
    }
    if (dataUrl) {
      img.onload = after
      img.src = dataUrl
    } else if (url) {
      fetchMediaBlobViaProxy(url)
        .then((b) => {
          img.onload = after
          img.src = URL.createObjectURL(b)
        })
        .catch(() => {
          img.alt = "(Falha ao carregar figurinha)"
          after()
        })
    }
    return
  }

  // IMAGEM
  if ((mime && mime.startsWith("image/")) || (!mime && url && /\.(png|jpe?g|gif|webp)(\?|$)/i.test(url))) {
    const figure = document.createElement("figure")
    figure.style.maxWidth = "280px"
    figure.style.margin = "0"
    const img = document.createElement("img")
    img.alt = "imagem"
    img.style.maxWidth = "100%"
    img.style.borderRadius = "8px"
    img.style.display = "block"
    const cap = document.createElement("figcaption")
    cap.style.fontSize = "12px"
    cap.style.opacity = ".8"
    cap.style.marginTop = "6px"
    cap.textContent = caption || plainText || ""
    if (top.childNodes.length) el.appendChild(top)
    figure.appendChild(img)
    if (cap.textContent) figure.appendChild(cap)
    el.appendChild(figure)
    const meta = document.createElement("small")
    meta.textContent = `${escapeHtml(who)} • ${formatTime(ts)}`
    meta.style.display = "block"
    meta.style.marginTop = "6px"
    meta.style.opacity = ".75"
    el.appendChild(meta)
    pane.appendChild(el)
    const after = () => {
      pane.scrollTop = pane.scrollHeight
    }
    if (dataUrl) {
      img.onload = after
      img.src = dataUrl
    } else if (url) {
      fetchMediaBlobViaProxy(url)
        .then((b) => {
          img.onload = after
          img.src = URL.createObjectURL(b)
        })
        .catch(() => {
          img.alt = "(Falha ao carregar imagem)"
          after()
        })
    } else {
      img.alt = "(Imagem não disponível)"
      after()
    }
    return
  }

  // VÍDEO
  if ((mime && mime.startsWith("video/")) || (!mime && url && /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url))) {
    const video = document.createElement("video")
    video.controls = true
    video.style.maxWidth = "320px"
    video.style.borderRadius = "8px"
    video.preload = "metadata"
    if (top.childNodes.length) el.appendChild(top)
    el.appendChild(video)
    const cap = document.createElement("div")
    cap.style.fontSize = "12px"
    cap.style.opacity = ".8"
    cap.style.marginTop = "6px"
    cap.textContent = caption || ""
    if (cap.textContent) el.appendChild(cap)
    const meta = document.createElement("small")
    meta.textContent = `${escapeHtml(who)} • ${formatTime(ts)}`
    meta.style.display = "block"
    meta.style.marginTop = "6px"
    meta.style.opacity = ".75"
    el.appendChild(meta)
    pane.appendChild(el)
    const after = () => {
      pane.scrollTop = pane.scrollHeight
    }
    if (dataUrl) {
      video.onloadeddata = after
      video.src = dataUrl
    } else if (url) {
      fetchMediaBlobViaProxy(url)
        .then((b) => {
          video.onloadeddata = after
          video.src = URL.createObjectURL(b)
        })
        .catch(() => {
          const err = document.createElement("div")
          err.style.fontSize = "12px"
          err.style.opacity = ".8"
          err.textContent = "(Falha ao carregar vídeo)"
          el.insertBefore(err, meta)
          after()
        })
    } else {
      const err = document.createElement("div")
      err.style.fontSize = "12px"
      err.style.opacity = ".8"
      err.textContent = "(Vídeo não disponível)"
      el.insertBefore(err, meta)
      after()
    }
    return
  }

  // ÁUDIO
  if ((mime && mime.startsWith("audio/")) || (!mime && url && /\.(mp3|ogg|m4a|wav)(\?|$)/i.test(url))) {
    const audio = document.createElement("audio")
    audio.controls = true
    audio.preload = "metadata"
    if (top.childNodes.length) el.appendChild(top)
    el.appendChild(audio)
    const meta = document.createElement("small")
    meta.textContent = `${escapeHtml(who)} • ${formatTime(ts)}`
    meta.style.display = "block"
    meta.style.marginTop = "6px"
    meta.style.opacity = ".75"
    el.appendChild(meta)
    pane.appendChild(el)
    const after = () => {
      pane.scrollTop = pane.scrollHeight
    }
    if (dataUrl) {
      audio.onloadeddata = after
      audio.src = dataUrl
    } else if (url) {
      fetchMediaBlobViaProxy(url)
        .then((b) => {
          audio.onloadeddata = after
          audio.src = URL.createObjectURL(b)
        })
        .catch(() => {
          const err = document.createElement("div")
          err.style.fontSize = "12px"
          err.style.opacity = ".8"
          err.textContent = "(Falha ao carregar áudio)"
          el.insertBefore(err, meta)
          after()
        })
    } else {
      const err = document.createElement("div")
      err.style.fontSize = "12px"
      err.style.opacity = ".8"
      err.textContent = "(Áudio não disponível)"
      el.insertBefore(err, meta)
      after()
    }
    return
  }

  // DOCUMENTO
  if ((mime && /^application\//.test(mime)) || (!mime && url && /\.(pdf|docx?|xlsx?|pptx?)$/i.test(url))) {
    if (top.childNodes.length) el.appendChild(top)
    const link = document.createElement("a")
    link.textContent = caption || plainText || "Documento"
    link.target = "_blank"
    link.rel = "noopener noreferrer"
    link.href = "javascript:void(0)"
    link.onclick = async () => {
      try {
        const b = await fetchMediaBlobViaProxy(url)
        const blobUrl = URL.createObjectURL(b)
        window.open(blobUrl, "_blank")
      } catch {
        alert("Falha ao baixar documento")
      }
    }
    el.appendChild(link)
    const meta = document.createElement("small")
    meta.textContent = `${escapeHtml(who)} • ${formatTime(ts)}`
    meta.style.display = "block"
    meta.style.marginTop = "6px"
    meta.style.opacity = ".75"
    el.appendChild(meta)
    pane.appendChild(el)
    pane.scrollTop = pane.scrollHeight
    return
  }

  // INTERATIVO sem texto
  if (hadInteractive && !plainText) {
    if (top.childNodes.length) el.appendChild(top)
    const meta = document.createElement("small")
    meta.textContent = `${escapeHtml(who)} • ${formatTime(ts)}`
    meta.style.display = "block"
    meta.style.marginTop = "6px"
    meta.style.opacity = ".75"
    el.appendChild(meta)
    pane.appendChild(el)
    pane.scrollTop = pane.scrollHeight
    return
  }

  // TEXTO
  if (top.childNodes.length) el.appendChild(top)
  el.innerHTML += `
    ${escapeHtml(plainText)}
    <small>${escapeHtml(who)} • ${formatTime(ts)}</small>
  `
  pane.appendChild(el)
  pane.scrollTop = pane.scrollHeight
}

/* =========================================
 * 18) PILL DE STAGE NO HEADER
 * ======================================= */
function upsertStagePill(stage) {
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
  const label = STAGE_LABEL[normalizeStage(stage)] || stage
  pill.textContent = label
  pill.title = ""
}

/* =========================================
 * 19) RENDER “CLÁSSICO” (fallback simples)
 * ======================================= */
function renderMessages(msgs) {
  const pane = $("#messages")
  if (!pane) return
  pane.innerHTML = ""
  if (msgs.length === 0) {
    pane.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">💬</div>
        <h3>Nenhuma mensagem</h3>
        <p>Esta conversa ainda não possui mensagens</p>
      </div>`
    return
  }
  msgs.forEach((m) => {
    const me = isFromMe(m)
    const el = document.createElement("div")
    el.className = "msg " + (me ? "me" : "you")
    const text = m.text || m.message?.text || m.caption || m?.message?.conversation || m?.body || ""
    const who = m.senderName || m.pushName || ""
    const ts = m.messageTimestamp || m.timestamp || m.t || ""
    el.innerHTML = `${escapeHtml(text)}<small>${escapeHtml(who)} • ${formatTime(ts)}</small>`
    pane.appendChild(el)
  })
  pane.scrollTop = pane.scrollHeight
}

/* =========================================
 * 20) ENVIO (atualiza ordenação imediatamente)
 * ======================================= */
async function sendNow() {
  const number = $("#send-number")?.value?.trim()
  const text = $("#send-text")?.value?.trim()
  const btnEl = $("#btn-send")
  if (!number || !text) return

  if (btnEl) {
    btnEl.disabled = true
    btnEl.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>'
  }

  try {
    await api("/api/send-text", { method: "POST", body: JSON.stringify({ number, text }) })
    updateLastActivity(number, Date.now()) // sobe o chat na hora
    if ($("#send-text")) $("#send-text").value = ""
    if (state.current && (state.current.wa_chatid || state.current.chatid) === number) {
      setTimeout(() => loadMessages(number), 500)
    }
  } catch (e) {
    alert(e.message || "Falha ao enviar mensagem")
  } finally {
    if (btnEl) {
      btnEl.disabled = false
      btnEl.innerHTML =
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>'
    }
  }
}

/* =========================================
 * 21) BOOT
 * ======================================= */
document.addEventListener("DOMContentLoaded", () => {
  $("#btn-login") && ($("#btn-login").onclick = doLogin)
  $("#btn-logout") &&
    ($("#btn-logout").onclick = () => {
      localStorage.clear()
      location.reload()
    })
  $("#btn-send") && ($("#btn-send").onclick = sendNow)
  $("#btn-refresh") &&
    ($("#btn-refresh").onclick = () => {
      if (state.current) {
        const chatid = state.current.wa_chatid || state.current.chatid
        loadMessages(chatid)
      } else {
        loadChats()
      }
    })

  const backBtn = document.getElementById("btn-back-mobile")
  if (backBtn) backBtn.onclick = () => setMobileMode("list")

  $("#send-text") &&
    $("#send-text").addEventListener("keypress", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        sendNow()
      }
    })

  $("#token") &&
    $("#token").addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        e.preventDefault()
        doLogin()
      }
    })

  ensureRoute()
})
