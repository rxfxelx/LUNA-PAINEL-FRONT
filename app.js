/* ========================================================================
 * LUNA – FRONTEND APP.JS (COMPLETO / ATUALIZADO)
 * 1) Previews na lista com “…” (usa CSS + contém só 1 linha no .preview)
 * 2) Previews carregam SOZINHAS logo após listar os chats (prefetch)
 * 3) Mantém tudo que já funcionava: login, lista, abrir chat, enviar, fotos, etc.
 * ===================================================================== */

/* -------------------- CONFIG & HELPERS -------------------- */
const BACKEND = () => (window.__BACKEND_URL__ || "").replace(/\/+$/, "");
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  currentChatId: null,
  chats: [],
  profiles: new Map(),  // cache por chatid -> { name, image, imagePreview }
  lastMsg: new Map(),   // cache de última mensagem do chat (preview)
};

function setJWT(jwt) { localStorage.setItem("luna_jwt", jwt); }
function getJWT() { return localStorage.getItem("luna_jwt") || ""; }
function clearJWT() { localStorage.removeItem("luna_jwt"); }

function authHeaders() { return { "Authorization": "Bearer " + getJWT() }; }

function showLogin() { $(".login")?.classList.remove("hidden"); $(".app")?.classList.add("hidden"); }
function showApp()   { $(".login")?.classList.add("hidden"); $(".app")?.classList.remove("hidden"); }

function fmtTime(ts) {
  if (!ts) return "";
  const n = typeof ts === "number" ? ts : parseInt(ts, 10);
  if (Number.isNaN(n)) return "";
  const d = new Date((n > 1e12 ? n : n * 1000));
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

async function api(path, opts = {}) {
  const res = await fetch(BACKEND() + path, {
    headers: { "Content-Type": "application/json", ...authHeaders(), ...(opts.headers || {}) },
    ...opts
  });
  if (res.status === 401) {
    const t = await res.text().catch(() => "");
    showLogin();
    throw new Error(`401 Unauthorized: ${t || "Reautentique-se."}`);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${t}`);
  }
  return res.json();
}

/* -------------------- LOGIN (ROBUSTO) -------------------- */
async function doLogin() {
  const loginRoot = $(".login") || document;

  const tokenInput =
    $("#token", loginRoot) ||
    $('input[name="token"]', loginRoot) ||
    $('input[type="text"]', loginRoot) ||
    $('input', loginRoot);

  const btn =
    $("#btn-login", loginRoot) ||
    $('[data-action="login"]', loginRoot) ||
    $('button[type="submit"]', loginRoot) ||
    $('button', loginRoot);

  const errBox =
    $("#login-error", loginRoot) ||
    $(".msg-err", loginRoot) ||
    (function () {
      const d = document.createElement("div");
      d.className = "msg-err";
      btn?.parentElement?.appendChild(d);
      return d;
    })();

  const token = (tokenInput?.value || "").trim();
  errBox.textContent = "";
  if (!token) { errBox.textContent = "Informe o token da instância."; tokenInput?.focus(); return; }

  try {
    if (btn) { btn.disabled = true; btn.dataset._text = btn.textContent; btn.textContent = "Entrando…"; }
    const r = await fetch(BACKEND() + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token })
    });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    if (!data?.jwt) throw new Error("Resposta inválida do servidor.");
    setJWT(data.jwt);

    if (data.profile) localStorage.setItem("luna_profile", JSON.stringify(data.profile));

    showApp();
    await loadChats();
  } catch (e) {
    console.error(e);
    errBox.textContent = e?.message || "Falha no login.";
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = btn.dataset._text || "Entrar"; }
  }
}

/* -------------------- NAME/IMAGE (com cache + revalidação) -------------------- */
async function fetchNameImage(chatid, { preview = true, force = false } = {}) {
  if (!force && state.profiles.has(chatid)) return state.profiles.get(chatid);

  try {
    const data = await api("/api/name-image", {
      method: "POST",
      body: JSON.stringify({ number: chatid, preview })
    });
    const prof = {
      name: data?.name || null,
      image: data?.image || null,
      imagePreview: data?.imagePreview || null
    };
    state.profiles.set(chatid, prof);
    return prof;
  } catch (e) {
    if (/expired|signature/i.test(String(e.message))) {
      try {
        const data = await api("/api/name-image", {
          method: "POST",
          body: JSON.stringify({ number: chatid, preview, force: true })
        });
        const prof = {
          name: data?.name || null,
          image: data?.image || null,
          imagePreview: data?.imagePreview || null
        };
        state.profiles.set(chatid, prof);
        return prof;
      } catch { /* ignore */ }
    }
    return state.profiles.get(chatid) || { name: null, image: null, imagePreview: null };
  }
}

/* -------------------- CHATS -------------------- */
function normalizeChat(c) {
  const name =
    c.wa_contactName || c.wa_name || c.name || c.title || c.wa_chatid || "Contato";
  const lastText = c.wa_lastMessageText || c.lead_lastMsgText || c.lastMessage || "";
  const lastTs = c.wa_lastMsgTimestamp || c.lastMsgTimestamp || c.updatedAt || c.timestamp || "";
  const unread = c.wa_unreadCount ?? c.unreadCount ?? 0;

  return {
    chatid: c.wa_chatid || c.wa_fastid || c.chatid || c.id || "",
    name,
    lastText,
    lastTs,
    unread,
    isGroup: !!(c.wa_isGroup || c.isGroup)
  };
}

async function loadChats() {
  const list = $("#chat-list");
  if (list) list.innerHTML = "<div class='hint'>Carregando…</div>";

  try {
    const data = await api("/api/chats", {
      method: "POST",
      body: JSON.stringify({ operator: "AND", sort: "-wa_lastMsgTimestamp", limit: 50, offset: 0 })
    });
    const items = Array.isArray(data?.items) ? data.items.map(normalizeChat) : [];
    state.chats = items;
    if (list) renderChats(items);

    // PREFETCH das últimas mensagens para cards que vieram sem preview
    prefetchPreviews(items);
  } catch (e) {
    console.error(e);
    if (list) list.innerHTML = `<div class='error'>Falha ao carregar chats: ${escapeHtml(e.message)}</div>`;
  }
}

function renderChats(chats) {
  const list = $("#chat-list");
  if (!list) return;
  list.innerHTML = "";

  chats.forEach(async (c) => {
    const li = document.createElement("div");
    li.className = "chat-item";
    li.dataset.chatid = c.chatid;

    // avatar
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    const prof = await fetchNameImage(c.chatid, { preview: true });
    if (prof?.imagePreview || prof?.image) {
      const img = document.createElement("img");
      img.alt = "";
      img.loading = "lazy";
      img.src = prof.imagePreview || prof.image;
      img.onerror = () => { avatar.textContent = (c.name || "?").slice(0, 2).toUpperCase(); };
      avatar.appendChild(img);
    } else {
      avatar.textContent = (c.name || "?").slice(0, 2).toUpperCase();
    }

    const main = document.createElement("div");
    main.className = "chat-main";

    const row1 = document.createElement("div");
    row1.className = "row1";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = prof?.name || c.name || c.chatid;
    const time = document.createElement("div");
    time.className = "time";
    time.textContent = fmtTime(c.lastTs);
    row1.append(name, time);

    const row2 = document.createElement("div");
    row2.className = "row2";
    const preview = document.createElement("div");
    preview.className = "preview"; // CSS já faz: uma linha + “...”
    const pvText = c.lastText || state.lastMsg.get(c.chatid) || "";
    preview.textContent = pvText;
    preview.title = pvText; // mostrar inteiro no hover
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = c.unread > 0 ? String(c.unread) : "";
    if (c.unread <= 0) badge.style.display = "none";

    row2.append(preview, badge);
    main.append(row1, row2);

    li.append(avatar, main);
    li.addEventListener("click", () => openChat(c.chatid, name.textContent));
    list.appendChild(li);
  });
}

/* -------------------- PREFETCH de previews --------------------
 * Busca a ÚLTIMA mensagem (limit=1) para todos os chats que vieram sem
 * wa_lastMessageText, assim o card já mostra o preview sem precisar abrir.
 * Fazemos em lotes para não sobrecarregar o backend.
 * ------------------------------------------------------------- */
async function prefetchPreviews(chats) {
  const targets = chats.filter(c => !(c.lastText && c.lastText.trim()));

  const BATCH = 6;                      // até 6 requisições simultâneas
  for (let i = 0; i < targets.length; i += BATCH) {
    const slice = targets.slice(i, i + BATCH);
    await Promise.all(slice.map(async (c) => {
      try {
        const data = await api("/api/messages", {
          method: "POST",
          body: JSON.stringify({ chatid: c.chatid, limit: 1, sort: "-messageTimestamp" })
        });
        const last = Array.isArray(data?.items) && data.items[0];
        if (!last) return;

        const previewText =
          last.text || last.caption || last?.message?.text || last?.message?.conversation || last?.body || "";
        state.lastMsg.set(c.chatid, previewText);

        const card = $(`.chat-item[data-chatid="${CSS.escape(c.chatid)}"]`);
        const pv = card?.querySelector(".preview");
        const tm = card?.querySelector(".time");
        if (pv) { pv.textContent = previewText; pv.title = previewText; }
        if (tm) tm.textContent = fmtTime(last.messageTimestamp || last.timestamp || last.date);
      } catch (e) {
        // silencioso; melhor não poluir o console
      }
    }));
  }
}

/* -------------------- MESSAGES -------------------- */
function renderMessages(msgs) {
  const pane = $("#messages");
  if (!pane) return;
  pane.innerHTML = "";

  msgs.forEach(m => {
    const me = m.fromMe || m.fromme || m.from_me || false;
    const bubble = document.createElement("div");
    bubble.className = "msg " + (me ? "me" : "you");

    // conteúdo
    let text =
      m.text || m.caption || m?.message?.text || m?.message?.conversation || m?.body || "";
    if (!text) {
      if (m.type === "image" || m?.message?.imageMessage) text = "📷 Foto";
      else if (m.type === "video" || m?.message?.videoMessage) text = "🎥 Vídeo";
      else if (m.type === "audio" || m?.message?.audioMessage) text = "🎵 Áudio";
      else if (m.type === "document" || m?.message?.documentMessage) text = "📄 Documento";
    }

    const who = m.senderName || m.pushName || (me ? "Você" : "");
    const ts = m.messageTimestamp || m.timestamp || m.date || "";

    // BOLHA continua normal (quebra linha), o preview na LISTA é que fica “...”
    bubble.innerHTML = `${escapeHtml(text)}<small>${escapeHtml(who)} • ${fmtTime(ts)}</small>`;
    pane.appendChild(bubble);
  });

  pane.scrollTop = pane.scrollHeight;
}

async function loadMessages(chatid) {
  const pane = $("#messages");
  if (pane) pane.innerHTML = "<div class='hint'>Carregando…</div>";

  try {
    const data = await api("/api/messages", {
      method: "POST",
      body: JSON.stringify({ chatid, limit: 100, sort: "-messageTimestamp" })
    });

    const items = Array.isArray(data?.items) ? data.items.slice().reverse() : [];
    // Atualiza preview e hora no card
    if (items.length > 0) {
      const last = items[items.length - 1];
      const previewText =
        last.text || last.caption || last?.message?.text || last?.message?.conversation || last?.body || "";
      state.lastMsg.set(chatid, previewText);

      const card = $(`.chat-item[data-chatid="${CSS.escape(chatid)}"]`);
      const pv = card?.querySelector(".preview");
      const tm = card?.querySelector(".time");
      if (pv) { pv.textContent = previewText; pv.title = previewText; }
      const ts = last.messageTimestamp || last.timestamp || last.date;
      if (tm) tm.textContent = fmtTime(ts);

      // zerar badge de não lidas do card aberto
      const badge = card?.querySelector(".badge");
      if (badge) { badge.textContent = ""; badge.style.display = "none"; }
    }

    renderMessages(items);
  } catch (e) {
    console.error(e);
    if (pane) pane.innerHTML = `<div class='error'>Falha ao carregar mensagens: ${escapeHtml(e.message)}</div>`;
  }
}

async function openChat(chatid, displayName) {
  state.currentChatId = chatid;

  const header = $("#chat-header") || $(".chat-title");
  if (header) header.textContent = displayName || chatid;

  const numInput = $("#send-number");
  if (numInput) numInput.value = (chatid || "").replace("@s.whatsapp.net", "").replace("@g.us", "");

  if (window.matchMedia("(max-width: 1023px)").matches) {
    document.body.classList.remove("is-mobile-list");
    document.body.classList.add("is-mobile-chat");
  }

  await loadMessages(chatid);
}

/* -------------------- SEND (opcional) -------------------- */
async function sendNow() {
  const number = $("#send-number")?.value.trim();
  const text = $("#send-text")?.value.trim();
  if (!number || !text) return;
  try {
    await api("/api/send-text", {
      method: "POST",
      body: JSON.stringify({ number, text })
    });
    $("#send-text").value = "";
    const cid = (state.currentChatId || "").replace("@s.whatsapp.net", "").replace("@g.us", "");
    if (cid === number) await loadMessages(state.currentChatId);
  } catch (e) {
    alert(e.message || "Falha ao enviar.");
  }
}

/* -------------------- BOOTSTRAP -------------------- */
document.addEventListener("DOMContentLoaded", () => {
  const loginRoot = $(".login") || document;
  const btnLogin =
    $("#btn-login", loginRoot) ||
    $('[data-action="login"]', loginRoot) ||
    $('button[type="submit"]', loginRoot) ||
    $('button', loginRoot);
  btnLogin?.addEventListener("click", (ev) => { ev.preventDefault?.(); doLogin(); });

  const tokenInput =
    $("#token", loginRoot) ||
    $('input[name="token"]', loginRoot) ||
    $('input[type="text"]', loginRoot) ||
    $('input', loginRoot);
  tokenInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doLogin(); } });

  $("#btn-logout")?.addEventListener("click", () => { clearJWT(); showLogin(); });

  $("#btn-refresh")?.addEventListener("click", () => {
    if (state.currentChatId) loadMessages(state.currentChatId);
    else loadChats();
  });

  $("#btn-send")?.addEventListener("click", (e) => { e.preventDefault(); sendNow(); });

  $(".btn.back")?.addEventListener("click", () => {
    document.body.classList.remove("is-mobile-chat");
    document.body.classList.add("is-mobile-list");
  });

  if (getJWT()) { showApp(); loadChats(); }
  else { showLogin(); }
});
