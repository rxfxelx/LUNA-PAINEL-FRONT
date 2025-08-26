/* ========= CONFIG/HELPERS ========= */
const BACKEND = () => (window.__BACKEND_URL__ || "").replace(/\/+$/, "");
const $ = (s) => document.querySelector(s);
const show = (sel) => $(sel).classList.remove("hidden");
const hide = (sel) => $(sel).classList.add("hidden");

// Idle callback (não bloqueia UI)
const rIC = (cb) =>
  (window.requestIdleCallback
    ? window.requestIdleCallback(cb, { timeout: 200 })
    : setTimeout(cb, 0));

// Limitador de concorrência simples
async function runLimited(tasks, limit = 8) {
  const results = [];
  let i = 0;
  const workers = new Array(Math.min(limit, tasks.length)).fill(0).map(async () => {
    while (i < tasks.length) {
      const cur = i++;
      try { results[cur] = await tasks[cur]() } catch (e) { results[cur] = undefined }
    }
  });
  await Promise.all(workers);
  return results;
}

function isMobile() {
  return window.matchMedia("(max-width:1023px)").matches;
}
function setMobileMode(mode) {
  document.body.classList.remove("is-mobile-list", "is-mobile-chat");
  if (!isMobile()) return;
  if (mode === "list") document.body.classList.add("is-mobile-list");
  if (mode === "chat") document.body.classList.add("is-mobile-chat");
}

function jwt() {
  return localStorage.getItem("luna_jwt") || "";
}
function authHeaders() {
  return { Authorization: "Bearer " + jwt() };
}

async function api(path, opts = {}) {
  const res = await fetch(BACKEND() + path, {
    headers: { "Content-Type": "application/json", ...authHeaders(), ...(opts.headers || {}) },
    ...opts,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${t}`);
  }
  return res.json();
}

function escapeHtml(s) {
  return String(s || "").replace(
    /[&<>"']/g,
    (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m],
  );
}

/* ========= STATE ========= */
const state = {
  chats: [],
  current: null,
  lastMsg: new Map(),
  nameCache: new Map(),
  unread: new Map(),
  loadingChats: false,

  // === Classificação (persistente) ===
  aiStage: new Map(),           // chatid -> {stage, confidence, reason, at}
  aiStageLoaded: false,
};

const STAGES = ["contatos", "lead", "lead_quente"];
const STAGE_LABEL = {
  contatos: "Contatos",
  lead: "Lead",
  lead_quente: "Lead Quente",
};
const STAGE_RANK = { contatos: 0, lead: 1, lead_quente: 2 };
function normalizeStage(s) {
  const k = String(s || "").toLowerCase().trim();
  if (k === "contato" || k === "contatos") return "contatos";
  if (k === "lead_quente" || k === "leadquente" || k === "quente") return "lead_quente";
  if (k === "lead") return "lead";
  return "contatos";
}
function maxStage(a, b) {
  a = normalizeStage(a); b = normalizeStage(b);
  return STAGE_RANK[b] > STAGE_RANK[a] ? b : a;
}
function loadStageCache() {
  if (state.aiStageLoaded) return;
  try {
    const raw = localStorage.getItem("luna_ai_stage") || "{}";
    const obj = JSON.parse(raw);
    Object.entries(obj).forEach(([chatid, v]) => state.aiStage.set(chatid, v));
  } catch {}
  state.aiStageLoaded = true;
}
function saveStageCache() {
  const obj = {};
  state.aiStage.forEach((v, k) => { obj[k] = v; });
  localStorage.setItem("luna_ai_stage", JSON.stringify(obj));
}
function getStage(chatid) {
  loadStageCache();
  return state.aiStage.get(chatid) || null;
}
function setStage(chatid, next) {
  loadStageCache();
  const cur = state.aiStage.get(chatid);
  if (!cur) {
    state.aiStage.set(chatid, { ...next, at: Date.now() });
  } else {
    // não rebaixa
    const merged = {
      stage: maxStage(cur.stage, next.stage),
      confidence: Math.max(cur.confidence || 0, next.confidence || 0),
      reason: next.reason || cur.reason || "",
      at: Date.now(),
    };
    state.aiStage.set(chatid, merged);
  }
  saveStageCache();
}

/* ========= TOP TABS ========= */
function ensureStageTabs() {
  const host = document.querySelector(".topbar") || document.querySelector(".tabs") || document.querySelector("header");
  if (!host || host.querySelector(".stage-tabs")) return;

  const wrap = document.createElement("div");
  wrap.className = "stage-tabs";
  wrap.style.display = "flex";
  wrap.style.gap = "8px";
  wrap.style.alignItems = "center";

  const btnGeral = document.createElement("button");
  btnGeral.className = "btn";
  btnGeral.textContent = "Geral";
  btnGeral.onclick = () => loadChats();
  wrap.appendChild(btnGeral);

  ["contatos","lead","lead_quente"].forEach(st => {
    const b = document.createElement("button");
    b.className = "btn";
    b.dataset.stage = st;
    b.textContent = STAGE_LABEL[st];
    b.onclick = () => loadStageView(st);
    wrap.appendChild(b);
  });

  const counters = document.createElement("div");
  counters.className = "stage-counters";
  counters.style.marginLeft = "8px";
  counters.style.fontSize = "12px";
  counters.style.opacity = "0.8";

  host.appendChild(wrap);
  host.appendChild(counters);

  refreshStageCounters();
}
function refreshStageCounters() {
  loadStageCache();
  const counts = { contatos: 0, lead: 0, lead_quente: 0 };
  state.chats.forEach(ch => {
    const chatid = ch.wa_chatid || ch.chatid || ch.wa_fastid || ch.wa_id || "";
    const st = getStage(chatid)?.stage || "contatos";
    if (counts[st] !== undefined) counts[st]++;
  });
  const el = document.querySelector(".stage-counters");
  if (el) el.textContent = `contatos: ${counts.contatos} • lead: ${counts.lead} • lead quente: ${counts.lead_quente}`;
}
async function loadStageView(stage) {
  const list = $("#chat-list");
  list.innerHTML = "<div class='hint'>Carregando…</div>";
  await rIC(() => {});
  loadStageCache();
  const selected = state.chats.filter(ch => {
    const chatid = ch.wa_chatid || ch.chatid || ch.wa_fastid || ch.wa_id || "";
    return (getStage(chatid)?.stage || "contatos") === stage;
  });
  await progressiveRenderChats(selected);
  await prefetchCards(selected);
}

/* ========= LOGIN ========= */
async function doLogin() {
  const token = $("#token").value.trim();
  const msgEl = $("#msg");
  const btnEl = $("#btn-login");

  if (!token) {
    msgEl.textContent = "Por favor, cole o token da instância";
    return;
  }

  msgEl.textContent = "";
  btnEl.disabled = true;
  btnEl.innerHTML = "<span>Conectando...</span>";

  try {
    const r = await fetch(BACKEND() + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    localStorage.setItem("luna_jwt", data.jwt);
    switchToApp();
  } catch (e) {
    console.error(e);
    msgEl.textContent = "Token inválido. Verifique e tente novamente.";
  } finally {
    btnEl.disabled = false;
    btnEl.innerHTML =
      '<span>Entrar no Sistema</span><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>';
  }
}

function switchToApp() {
  hide("#login-view");
  show("#app-view");
  setMobileMode("list");
  ensureStageTabs();
  loadChats();
}

function ensureRoute() {
  if (jwt()) switchToApp();
  else {
    show("#login-view");
    hide("#app-view");
  }
}

/* ========= AVATAR/NAME-IMAGE ========= */
async function fetchNameImage(chatid, preview = true) {
  try {
    const resp = await api("/api/name-image", {
      method: "POST",
      body: JSON.stringify({ number: chatid, preview }),
    });
    return resp;
  } catch (e) {
    return { name: null, image: null, imagePreview: null };
  }
}

function initialsOf(str) {
  const s = (str || "").trim();
  if (!s) return "??";
  const parts = s.split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() || "").join("") || "??";
}

/* ========= CHATS ========= */
async function loadChats() {
  if (state.loadingChats) return;
  state.loadingChats = true;

  const list = $("#chat-list");
  list.innerHTML = "<div class='hint'>Carregando conversas...</div>";

  try {
    const data = await api("/api/chats", {
      method: "POST",
      body: JSON.stringify({ operator: "AND", sort: "-wa_lastMsgTimestamp", limit: 100, offset: 0 }),
    });
    const items = Array.isArray(data?.items) ? data.items : [];
    state.chats = items;

    await progressiveRenderChats(items);
    await prefetchCards(items);

    // Classificação em background de TODAS as conversas (sem rebaixar e com cache)
    classifyAllChatsInBackground(items).then(() => refreshStageCounters());
  } catch (e) {
    console.error(e);
    list.innerHTML = `<div class='error'>Falha ao carregar conversas: ${escapeHtml(e.message || "")}</div>`;
  } finally {
    state.loadingChats = false;
  }
}

async function progressiveRenderChats(chats) {
  const list = $("#chat-list");
  list.innerHTML = "";

  if (chats.length === 0) {
    list.innerHTML = "<div class='hint'>Nenhuma conversa encontrada</div>";
    return;
  }

  const BATCH = 14;
  for (let i = 0; i < chats.length; i += BATCH) {
    const slice = chats.slice(i, i + BATCH);
    slice.forEach((ch) => appendChatSkeleton(list, ch));
    await new Promise((r) => rIC(r));
  }

  chats.forEach((ch) => hydrateChatCard(ch));
}

function appendChatSkeleton(list, ch) {
  const el = document.createElement("div");
  el.className = "chat-item";
  el.dataset.chatid = ch.wa_chatid || ch.chatid || ch.wa_fastid || ch.wa_id || "";
  el.onclick = () => openChat(ch);

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = "··";

  const main = document.createElement("div");
  main.className = "chat-main";

  const top = document.createElement("div");
  top.className = "row1";
  const nm = document.createElement("div");
  nm.className = "name";
  nm.textContent = (ch.wa_contactName || ch.name || el.dataset.chatid || "Contato").toString();
  const tm = document.createElement("div");
  tm.className = "time";
  const lastTs = ch.wa_lastMsgTimestamp || ch.messageTimestamp || "";
  tm.textContent = lastTs ? formatTime(lastTs) : "";
  top.appendChild(nm);
  top.appendChild(tm);

  const bottom = document.createElement("div");
  bottom.className = "row2";
  const preview = document.createElement("div");
  preview.className = "preview";
  const pvText = (state.lastMsg.get(el.dataset.chatid) || ch.wa_lastMessageText || "").replace(/\s+/g, " ").trim();
  preview.textContent = pvText || "Carregando...";
  preview.title = pvText;

  const unread = document.createElement("span");
  unread.className = "badge";
  const count = state.unread.get(el.dataset.chatid) || ch.wa_unreadCount || 0;
  if (count > 0) unread.textContent = count;
  else unread.style.display = "none";

  bottom.appendChild(preview);
  bottom.appendChild(unread);

  main.appendChild(top);
  main.appendChild(bottom);
  el.appendChild(avatar);
  el.appendChild(main);
  list.appendChild(el);
}

function hydrateChatCard(ch) {
  const chatid = ch.wa_chatid || ch.chatid || ch.wa_fastid || ch.wa_id || "";
  const cache = state.nameCache.get(chatid);
  if (!chatid || !cache) return;

  const el = document.querySelector(`.chat-item[data-chatid="${CSS.escape(chatid)}"]`);
  if (!el) return;

  const avatar = el.querySelector(".avatar");
  const nameEl = el.querySelector(".name");
  if (cache.imagePreview || cache.image) {
    avatar.innerHTML = "";
    const img = document.createElement("img");
    img.src = cache.imagePreview || cache.image;
    img.alt = "avatar";
    avatar.appendChild(img);
  } else {
    avatar.textContent = initialsOf(cache.name || nameEl.textContent);
  }
  if (cache.name) nameEl.textContent = cache.name;
}

// Prefetch paralelo limitado
async function prefetchCards(items) {
  const tasks = items.map((ch) => {
    const chatid = ch.wa_chatid || ch.chatid || ch.wa_fastid || ch.wa_id || "";
    return async () => {
      if (!chatid) return;
      if (!state.nameCache.has(chatid)) {
        try {
          const resp = await fetchNameImage(chatid);
          state.nameCache.set(chatid, resp);
          hydrateChatCard(ch);
        } catch {}
      }
      if (!state.lastMsg.has(chatid) && !ch.wa_lastMessageText) {
        try {
          const data = await api("/api/messages", {
            method: "POST",
            body: JSON.stringify({ chatid, limit: 1, sort: "-messageTimestamp" }),
          });
          const last = Array.isArray(data?.items) ? data.items[0] : null;
          if (last) {
            const pv = (
              last.text ||
              last.caption ||
              last?.message?.text ||
              last?.message?.conversation ||
              last?.body ||
              ""
            ).replace(/\s+/g, " ").trim();
            state.lastMsg.set(chatid, pv);

            const card = document.querySelector(`.chat-item[data-chatid="${CSS.escape(chatid)}"] .preview`);
            if (card) {
              card.textContent = pv || "Sem mensagens";
              card.title = pv;
            }
            const tEl = document.querySelector(`.chat-item[data-chatid="${CSS.escape(chatid)}"] .time`);
            if (tEl) tEl.textContent = formatTime(last.messageTimestamp || last.timestamp || "");
          }
        } catch {}
      }
    };
  });

  const CHUNK = 16;
  for (let i = 0; i < tasks.length; i += CHUNK) {
    const slice = tasks.slice(i, i + CHUNK);
    await runLimited(slice, 8);
    await new Promise((r) => rIC(r));
  }
}

function formatTime(timestamp) {
  if (!timestamp) return "";
  try {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;
    const hours = Math.floor(diff / (1000 * 60 * 60));
    if (hours < 1) return "Agora";
    if (hours < 24) return `${hours}h`;
    if (hours < 48) return "Ontem";
    return date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  } catch (e) {
    return timestamp;
  }
}

/* ========= OPEN CHAT / MESSAGES ========= */
async function openChat(ch) {
  state.current = ch;
  const title = $("#chat-header");
  const status = $(".chat-status");
  const chatid = ch.wa_chatid || ch.chatid || ch.wa_fastid || ch.wa_id || "";

  const cache = state.nameCache.get(chatid) || {};
  const nm = (cache.name || ch.wa_contactName || ch.name || chatid || "Chat").toString();

  title.textContent = nm;
  if (status) status.textContent = "Carregando mensagens...";

  setMobileMode("chat");
  await loadMessages(chatid);

  // mostra pill com estágio atual (do cache), sem rodar IA de novo
  const st = getStage(chatid);
  if (st) upsertAIPill(st.stage, st.confidence, st.reason);

  if (status) status.textContent = "Online";
}

async function loadMessages(chatid) {
  const pane = $("#messages");
  pane.innerHTML = "<div class='hint'>Carregando mensagens...</div>";

  try {
    const data = await api("/api/messages", {
      method: "POST",
      body: JSON.stringify({ chatid, limit: 200, sort: "-messageTimestamp" }),
    });
    const items = Array.isArray(data?.items) ? data.items : [];
    await progressiveRenderMessages(items.slice().reverse());

    const last = items[0];
    const pv = (last?.text || last?.caption || last?.message?.text || last?.message?.conversation || last?.body || "")
      .replace(/\s+/g, " ")
      .trim();
    state.lastMsg.set(chatid, pv);

    // não roda IA aqui (já roda no background). Apenas se nunca classificado:
    if (!getStage(chatid)) {
      await classifyAndPersist(chatid, items);
      refreshStageCounters();
    }
  } catch (e) {
    console.error(e);
    pane.innerHTML = `<div class='error'>Falha ao carregar mensagens: ${escapeHtml(e.message || "")}</div>`;
  }
}

/* ========= renderização PROGRESSIVA ========= */
async function progressiveRenderMessages(msgs) {
  const pane = $("#messages");
  pane.innerHTML = "";

  if (!msgs.length) {
    pane.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">💬</div>
        <h3>Nenhuma mensagem</h3>
        <p>Esta conversa ainda não possui mensagens</p>
      </div>
    `;
    return;
  }

  const BATCH = 12;
  for (let i = 0; i < msgs.length; i += BATCH) {
    const slice = msgs.slice(i, i + BATCH);
    slice.forEach((m) => appendMessageBubble(pane, m));
    await new Promise((r) => rIC(r));
    pane.scrollTop = pane.scrollHeight;
  }
}

function appendMessageBubble(pane, m) {
  const me = m.fromMe || m.fromme || m.from_me || false;
  const el = document.createElement("div");
  el.className = "msg " + (me ? "me" : "you");
  const text = m.text || m.message?.text || m.caption || m?.message?.conversation || m?.body || "";
  const who = m.senderName || m.pushName || "";
  const ts = m.messageTimestamp || m.timestamp || "";

  el.innerHTML = `
    ${escapeHtml(text)}
    <small>${escapeHtml(who)} • ${formatTime(ts)}</small>
  `;
  pane.appendChild(el);
}

/* ========= IA — pill ========= */
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
  const label = STAGE_LABEL[normalizeStage(stage)] || stage;
  pill.textContent = `${label} • conf ${(confidence * 100).toFixed(0)}%`;
  pill.title = reason || "";
}

/* ========= IA — classificação + persistência ========= */

// heurística leve (barata) antes de chamar IA
function heuristicStage(items) {
  // pega até 200 msgs (mais recentes primeiro no array original)
  const txts = (items || []).map(m =>
    (m.text || m.caption || m?.message?.text || m?.message?.conversation || m?.body || "").toLowerCase()
  );

  // lead_quente: evidência de transferência/encaminhamento humano
  const hotHints = [
    "vou te passar para",
    "vou encaminhar",
    "encaminhando seu contato",
    "alguém vai falar com você",
    "o time comercial vai te chamar",
    "o setor vai entrar em contato",
    "vou pedir para alguém te chamar",
    "vou transferir",
  ];
  if (txts.some(t => hotHints.some(h => t.includes(h)))) return "lead_quente";

  // lead: perguntas/dúvidas específicas
  const leadHints = ["como funciona", "preço", "valor", "quanto custa", "parcel", "prazo", "horário", "garantia", "demonstração", "demonstracao", "mostra"];
  if (txts.some(t => /(\?|como|quanto|quando|onde|por que|porque)/.test(t) || leadHints.some(h => t.includes(h)))) {
    return "lead";
  }

  return "contatos";
}

async function classifyAndPersist(chatid, items) {
  // 1) heurística
  const h = heuristicStage(items);
  setStage(chatid, { stage: h, confidence: h === "lead_quente" ? 0.7 : (h === "lead" ? 0.6 : 0.4), reason: "Heurística local" });

  // 2) IA (só se não existir classificação melhor)
  try {
    const history = (items || []).slice(0, 200).map(m => ({
      role: (m.fromMe || m.fromme || m.from_me) ? "assistant" : "user",
      content: (m.text || m.caption || m?.message?.text || m?.message?.conversation || m?.body || "").toString()
    })).filter(x => x.content);

    const r = await fetch(BACKEND() + "/api/ai/classify", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(history.length ? { history } : { text: state.lastMsg.get(chatid) || "" }),
    });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json(); // {stage, confidence, reason}

    setStage(chatid, { stage: data.stage, confidence: data.confidence, reason: data.reason });

    // Atualiza pill se o chat atual for este
    if (state.current && (state.current.wa_chatid || state.current.chatid || state.current.wa_fastid || state.current.wa_id) === chatid) {
      upsertAIPill(getStage(chatid).stage, getStage(chatid).confidence, getStage(chatid).reason);
    }
  } catch (e) {
    console.warn("IA classify falhou:", e?.message || e);
  }
}

async function classifyAllChatsInBackground(items) {
  const tasks = (items || []).map(ch => async () => {
    const chatid = ch.wa_chatid || ch.chatid || ch.wa_fastid || ch.wa_id || "";
    if (!chatid) return;

    // se já temos classificação persistida, não reprocessa
    if (getStage(chatid)) return;

    try {
      const data = await api("/api/messages", {
        method: "POST",
        body: JSON.stringify({ chatid, limit: 200, sort: "-messageTimestamp" }),
      });
      const msgs = Array.isArray(data?.items) ? data.items : [];
      await classifyAndPersist(chatid, msgs);
    } catch (e) {
      // ignora
    }
  });

  // roda com limite e de forma não bloqueante
  const CHUNK = 10;
  for (let i = 0; i < tasks.length; i += CHUNK) {
    const slice = tasks.slice(i, i + CHUNK);
    await runLimited(slice, 5);
    await new Promise((r) => rIC(r));
  }
}

/* ========= SEND ========= */
async function sendNow() {
  const number = $("#send-number").value.trim();
  const text = $("#send-text").value.trim();
  const btnEl = $("#btn-send");

  if (!number || !text) return;

  btnEl.disabled = true;
  btnEl.innerHTML =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>';

  try {
    await api("/api/send-text", {
      method: "POST",
      body: JSON.stringify({ number, text }),
    });
    $("#send-text").value = "";

    if (state.current && (state.current.wa_chatid || state.current.chatid) === number) {
      setTimeout(() => loadMessages(number), 500);
    }
  } catch (e) {
    alert(e.message || "Falha ao enviar mensagem");
  } finally {
    btnEl.disabled = false;
    btnEl.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>';
  }
}

/* ========= BOOT ========= */
document.addEventListener("DOMContentLoaded", () => {
  $("#btn-login").onclick = doLogin;
  $("#btn-logout").onclick = () => {
    localStorage.clear();
    location.reload();
  };
  $("#btn-send").onclick = sendNow;
  $("#btn-refresh").onclick = () => {
    if (state.current) {
      const chatid = state.current.wa_chatid || state.current.chatid;
      loadMessages(chatid);
    } else {
      loadChats();
    }
  };

  const backBtn = document.getElementById("btn-back-mobile");
  if (backBtn) backBtn.onclick = () => setMobileMode("list");

  $("#send-text").addEventListener("keypress", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendNow();
    }
  });

  $("#token").addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      doLogin();
    }
  });

  ensureRoute();
});
