/* app.js — Luna Painel (frontend)
 * - Login com Instance Token (salvo como JWT vindo do backend)
 * - Lista de chats com avatar, nome, hora da última mensagem e preview
 * - Mensagens do chat selecionado
 * - Totalmente compatível com o CSS que enviei
 */

/* ========= helpers ========= */
const BACKEND = () => (window.__BACKEND_URL__ || "").replace(/\/+$/,"");
const $       = (s) => document.querySelector(s);
const show    = (sel) => $(sel)?.classList.remove("hidden");
const hide    = (sel) => $(sel)?.classList.add("hidden");

function jwt() {
  return localStorage.getItem("luna_jwt") || "";
}
function setJwt(v) {
  if (v) localStorage.setItem("luna_jwt", v);
}
function clearAuth() {
  localStorage.removeItem("luna_jwt");
  localStorage.removeItem("luna_profile");
}

function authHeaders(extra={}) {
  const h = { "Content-Type": "application/json", ...extra };
  const t = jwt();
  if (t) h["Authorization"] = "Bearer " + t;
  return h;
}

async function api(path, opts = {}) {
  const res = await fetch(BACKEND() + path, {
    headers: authHeaders(opts.headers || {}),
    ...opts
  });
  if (!res.ok) {
    let t = "";
    try { t = await res.text(); } catch {}
    throw new Error(`HTTP ${res.status}: ${t}`);
  }
  return res.json();
}

/* ========= login ========= */
async function doLogin() {
  const token = $("#token")?.value?.trim();
  if (!token) { $("#msg").textContent = "Informe o token da instância"; return; }

  try {
    const r = await fetch(BACKEND() + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token })
    });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    setJwt(data.jwt);
    localStorage.setItem("luna_profile", JSON.stringify({}));
    switchToApp();
  } catch (e) {
    console.error(e);
    $("#msg").textContent = "Token inválido. Verifique e tente novamente.";
  }
}

function switchToApp() {
  hide("#login-view");
  show("#app-view");
  loadChats();
}

function ensureRoute() {
  if (jwt()) switchToApp();
  else { show("#login-view"); hide("#app-view"); }
}

/* ========= normalização dos dados ========= */
/* Garante que sempre teremos name, image, lastMessage{text,timestamp} */
function normalizeChat(raw) {
  const chat = { ...raw };

  // nome: preferir campos de contato; cair para chatId
  chat.name =
    chat.wa_contactName ||
    chat.contactName ||
    chat.wa_name ||
    chat.name ||
    chat.wa_chatid ||
    chat.chatid ||
    chat.chatId ||
    "";

  // chatId padronizado
  chat.chatId = chat.wa_chatid || chat.chatid || chat.chatId || "";

  // avatar
  chat.image = chat.image || chat.profileImage || chat.photo || null;

  // última mensagem (tentar vários campos)
  const lastText =
    (chat.lastMessage && chat.lastMessage.text) ||
    chat.wa_lastMessageText ||
    chat.last_msg_text ||
    chat.preview || "";

  const lastTs =
    (chat.lastMessage && chat.lastMessage.timestamp) ||
    chat.wa_lastMsgTimestamp ||
    chat.last_msg_timestamp ||
    chat.timestamp || null;

  chat.lastMessage = {
    text: lastText || "",
    timestamp: lastTs ? Number(lastTs) : null
  };

  return chat;
}

function fmtTime(tsSec) {
  if (!tsSec) return "";
  const d = new Date(Number(tsSec) * 1000);
  return d.toLocaleTimeString("pt-BR", { hour:"2-digit", minute:"2-digit" });
}

/* ========= render da lista de chats ========= */
function renderChatItem(chat) {
  const item = document.createElement("div");
  item.className = "chat-item";

  // avatar
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  if (chat.image) {
    const img = document.createElement("img");
    img.src = chat.image;
    img.className = "avatar-img";
    img.loading = "lazy";
    avatar.appendChild(img);
  } else {
    const span = document.createElement("span");
    span.className = "avatar-fallback";
    const initials = (chat.name || chat.chatId || "?")
      .split(" ")
      .filter(Boolean)
      .slice(0,2)
      .map(s => s[0]?.toUpperCase())
      .join("") || "??";
    span.textContent = initials;
    avatar.appendChild(span);
  }

  // meta
  const meta = document.createElement("div");
  meta.className = "meta";

  const row1 = document.createElement("div");
  row1.className = "row1";

  const name = document.createElement("div");
  name.className = "name";
  name.textContent = chat.name || chat.chatId;

  const time = document.createElement("div");
  time.className = "time";
  time.textContent = fmtTime(chat.lastMessage?.timestamp);

  row1.appendChild(name);
  row1.appendChild(time);

  const row2 = document.createElement("div");
  row2.className = "row2";

  const preview = document.createElement("div");
  preview.className = "preview";
  preview.textContent = chat.lastMessage?.text || "";

  row2.appendChild(preview);

  meta.appendChild(row1);
  meta.appendChild(row2);

  item.appendChild(avatar);
  item.appendChild(meta);

  item.onclick = () => openChat(chat.chatId, chat.name || chat.chatId);
  return item;
}

/* ========= carregar lista de chats ========= */
async function loadChats() {
  const list = $("#chat-list");
  list.innerHTML = "<div class='hint'>Carregando...</div>";
  try {
    // você pode ajustar o corpo conforme seu backend (paginado, etc.)
    const data = await api("/api/chats", {
      method: "POST",
      body: JSON.stringify({
        operator: "AND",
        sort: "-wa_lastMsgTimestamp",
        limit: 100, offset: 0
      })
    });

    const items = Array.isArray(data?.items) ? data.items : [];
    if (!items.length) {
      list.innerHTML = "<div class='hint'>Nenhum chat encontrado</div>";
      return;
    }

    // normalizar e renderizar
    list.innerHTML = "";
    items.map(normalizeChat).forEach(ch => list.appendChild(renderChatItem(ch)));

  } catch (e) {
    console.error(e);
    list.innerHTML = `<div class='error'>Falha ao carregar chats: ${e.message}</div>`;
  }
}

/* ========= mensagens ========= */
let CURRENT_CHAT_ID = null;

async function openChat(chatId, title) {
  CURRENT_CHAT_ID = chatId;
  $("#chat-header").textContent = title || chatId || "Chat";
  $("#messages").innerHTML = "<div class='hint'>Carregando...</div>";
  await loadMessages(chatId);

  // mobile: entra na tela de chat
  if (window.matchMedia("(max-width:1023px)").matches) {
    document.body.classList.remove("is-mobile-list");
    document.body.classList.add("is-mobile-chat");
  }
}

async function loadMessages(chatId) {
  const pane = $("#messages");
  try {
    const data = await api("/api/messages", {
      method: "POST",
      body: JSON.stringify({ chatid: chatId, limit: 100, sort: "-messageTimestamp" })
    });
    const items = Array.isArray(data?.items) ? data.items : [];
    renderMessages(items.reverse());
  } catch (e) {
    console.error(e);
    pane.innerHTML = `<div class='error'>Falha ao carregar mensagens: ${e.message}</div>`;
  }
}

function renderMessages(msgs) {
  const pane = $("#messages");
  pane.innerHTML = "";
  msgs.forEach(m => {
    const me = m.fromMe || m.fromme || m.from_me || false;
    const el = document.createElement("div");
    el.className = "msg " + (me ? "me" : "you");

    // texto de vários formatos possíveis
    const text =
      m.text ||
      m.message?.text ||
      m.caption ||
      m?.message?.conversation ||
      m?.body || "";

    const who  = m.senderName || m.pushName || "";
    const ts   = m.messageTimestamp || m.timestamp || "";

    el.innerHTML = `${escapeHtml(text)}<small>${escapeHtml(who)} ${ts ? "• " + ts : ""}</small>`;
    pane.appendChild(el);
  });
  pane.scrollTop = pane.scrollHeight;
}

function escapeHtml(s){
  return String(s||"").replace(/[&<>"']/g, m => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[m]));
}

/* ========= envio manual (opcional) ========= */
async function sendNow() {
  const number = $("#send-number")?.value?.trim();
  const text   = $("#send-text")?.value?.trim();
  if (!number || !text) return;

  try {
    await api("/api/send-text", {
      method: "POST",
      body: JSON.stringify({ number, text })
    });
    $("#send-text").value = "";
    if (CURRENT_CHAT_ID) loadMessages(CURRENT_CHAT_ID);
  } catch (e) {
    alert(e.message || "Falha ao enviar");
  }
}

/* ========= eventos ========= */
document.addEventListener("DOMContentLoaded", () => {
  // botões
  $("#btn-login")    ?.addEventListener("click", doLogin);
  $("#btn-logout")   ?.addEventListener("click", () => { clearAuth(); location.reload(); });
  $("#btn-send")     ?.addEventListener("click", sendNow);
  $("#btn-refresh")  ?.addEventListener("click", () => {
    if (CURRENT_CHAT_ID) loadMessages(CURRENT_CHAT_ID);
    else loadChats();
  });
  $(".btn.back")     ?.addEventListener("click", () => {
    document.body.classList.remove("is-mobile-chat");
    document.body.classList.add("is-mobile-list");
  });

  ensureRoute();
});
