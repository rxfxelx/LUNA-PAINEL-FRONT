// ===== Config & helpers =====
const BACKEND = () => (window.__BACKEND_URL__ || "").replace(/\/+$/, "");
const $  = (s) => document.querySelector(s);
const show = (sel) => $(sel).classList.remove("hidden");
const hide = (sel) => $(sel).classList.add("hidden");

function jwt(){ return localStorage.getItem("luna_jwt") || ""; }
function authHeaders(){ return { "Authorization": "Bearer " + jwt() }; }

async function api(path, opts = {}) {
  const res = await fetch(BACKEND() + path, {
    headers: { "Content-Type": "application/json", ...authHeaders(), ...(opts.headers || {}) },
    ...opts
  });
  if (!res.ok) {
    const t = await res.text().catch(()=> "");
    throw new Error(`HTTP ${res.status}: ${t}`);
  }
  return res.json();
}

// ====== Nome/foto helpers ======
const NAME_CACHE = new Map();

function fixEncoding(s) {
  try {
    if (typeof s === "string" && /[ÃÂ¢€™‰]/.test(s)) {
      const bytes = Uint8Array.from([...s].map(c => c.charCodeAt(0)));
      return new TextDecoder("utf-8").decode(bytes);
    }
  } catch {}
  return s;
}

function formatNumberFromChatId(chatid) {
  const num = String(chatid || "").replace(/@.*/, "");
  const br = num.replace(/^55(\d{2})(\d{5})(\d{4})$/, "+55 ($1) $2-$3");
  return br !== num ? br : num;
}

function bestName(chat) {
  const last = chat.lastMessage || {};
  const raw =
    chat.wa_contactName ||
    chat.wa_name ||
    chat.name ||
    last.senderName ||
    last.pushName ||
    "";
  if (raw) return fixEncoding(raw);
  return formatNumberFromChatId(chat.wa_chatid || chat.chatid);
}

async function ensureName(chat) {
  const id = chat.wa_chatid || chat.chatid;
  if (!id) return null;
  if (NAME_CACHE.has(id)) return NAME_CACHE.get(id);

  try {
    const res = await api("/api/name-image", {
      method: "POST",
      body: JSON.stringify({ number: id, preview: true })
    });
    const fixed = fixEncoding(res?.name || "");
    if (fixed) {
      NAME_CACHE.set(id, fixed);
      chat.wa_contactName = fixed;
      return fixed;
    }
  } catch {}
  return null;
}

// ====== Login ======
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
    localStorage.setItem("luna_jwt", data.jwt);
    localStorage.setItem("luna_profile", JSON.stringify(data.profile || {}));
    switchToApp();
  } catch (e) {
    $("#msg").textContent = e.message || "Falha no login";
  }
}

function switchToApp() {
  hide("#login-view"); show("#app-view");
  try {
    const p = JSON.parse(localStorage.getItem("luna_profile")||"{}");
    $("#profile").textContent = p?.label ? `• ${p.label}` : "";
  } catch {}
  loadChats();
}

function ensureRoute() {
  if (jwt()) switchToApp(); else { show("#login-view"); hide("#app-view"); }
}

// ====== Chats ======
async function loadChats() {
  const list = $("#chat-list");
  list.innerHTML = "<div style='padding:12px;color:#8696a0'>Carregando...</div>";
  try {
    const data = await api("/api/chats", {
      method: "POST",
      body: JSON.stringify({ operator: "AND", sort: "-wa_lastMsgTimestamp", limit: 50, offset: 0 })
    });
    const items = Array.isArray(data?.items) ? data.items : [];
    if (items.length === 0) {
      list.innerHTML = "<div style='padding:12px;color:#8696a0'>Nenhum chat encontrado</div>";
      return;
    }
    renderChats(items);
  } catch (e) {
    list.innerHTML = `<div style='padding:12px;color:#f88'>Falha ao carregar chats: ${e.message}</div>`;
  }
}

function renderChats(chats) {
  const list = $("#chat-list"); list.innerHTML = "";
  chats.forEach(ch => {
    const el = document.createElement("div");
    el.className = "chat-item";
    el.onclick = () => openChat(ch);

    const displayName = bestName(ch);
    const initials = (displayName || "?").slice(0,2).toUpperCase();
    const ts = ch.wa_lastMsgTimestamp || "";

    el.innerHTML = `
      <div class="avatar">${initials}</div>
      <div class="meta">
        <div class="name">${displayName}</div>
        <div class="time">${ts}</div>
        <div class="preview">${(ch.wa_lastMessageText || "").slice(0, 60)}</div>
      </div>`;

    list.appendChild(el);

    if (!ch.wa_contactName) {
      ensureName(ch).then(n => { if (n) el.querySelector(".name").textContent = n; });
    }
  });
}

// ====== Mensagens ======
async function openChat(ch) {
  await ensureName(ch);
  $("#chat-header").textContent = bestName(ch) || "Chat";
  $("#send-number").value = (ch.wa_chatid || "").replace("@s.whatsapp.net","").replace("@g.us","");
  await loadMessages(ch.wa_chatid || ch.chatid);
}

async function loadMessages(chatid) {
  const pane = $("#messages");
  pane.innerHTML = "<div style='padding:12px;color:#8696a0'>Carregando...</div>";
  try {
    const data = await api("/api/messages", {
      method: "POST",
      body: JSON.stringify({ chatid, limit: 100, sort: "-messageTimestamp" })
    });
    const items = Array.isArray(data?.items) ? data.items : [];
    renderMessages(items);
  } catch (e) {
    pane.innerHTML = `<div style='padding:12px;color:#f88'>Falha ao carregar mensagens: ${e.message}</div>`;
  }
}

function renderMessages(msgs) {
  const pane = $("#messages"); pane.innerHTML = "";
  msgs.forEach(m => {
    const me = m.fromMe || m.fromme || m.from_me || false;
    const el = document.createElement("div");
    el.className = "msg " + (me ? "me" : "you");

    // Texto/mídia simples (ajuste conforme sua UAZAPI):
    const text =
      m.text ||
      m.message?.text ||
      m.caption ||
      m?.message?.conversation ||
      m?.body ||
      "";

    const who = m.senderName || m.pushName || "";
    const ts  = m.messageTimestamp || m.timestamp || "";

    el.innerHTML = `${escapeHtml(text)}<small>${who ? escapeHtml(who) + " • " : ""}${ts}</small>`;
    pane.appendChild(el);
  });
  pane.scrollTop = pane.scrollHeight;
}

function escapeHtml(s){
  return String(s||"").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

// ====== Boot ======
document.addEventListener("DOMContentLoaded", () => {
  const btnLogin   = $("#btn-login");
  const btnLogout  = $("#btn-logout");
  const btnSend    = $("#btn-send");
  const btnRefresh = $("#btn-refresh");

  if (btnLogin)  btnLogin.onclick  = doLogin;
  if (btnLogout) btnLogout.onclick = () => { localStorage.clear(); location.reload(); };
  if (btnSend)   btnSend.onclick   = () => {}; // envio desativado por enquanto
  if (btnRefresh) btnRefresh.onclick = () => {
    if (window.__CURRENT_CHAT__) loadMessages(window.__CURRENT_CHAT__.wa_chatid);
    else loadChats();
  };

  ensureRoute();
});
