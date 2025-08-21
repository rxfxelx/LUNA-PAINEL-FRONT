const BACKEND = () => (window.__BACKEND_URL__ || "").replace(/\/+$/,"");
const $  = (s) => document.querySelector(s);
const show = (sel) => $(sel).classList.remove("hidden");
const hide = (sel) => $(sel).classList.add("hidden");

function jwt() { return localStorage.getItem("luna_jwt") || ""; }
function authHeaders() { return { "Authorization": "Bearer " + jwt() }; }

async function api(path, opts = {}) {
  const res = await fetch(BACKEND() + path, {
    headers: { "Content-Type": "application/json", ...authHeaders(), ...(opts.headers||{}) },
    ...opts
  });
  if (!res.ok) {
    const t = await res.text().catch(()=> "");
    throw new Error(`HTTP ${res.status}: ${t}`);
  }
  return res.json();
}

/* ---------- LOGIN FLOW ---------- */
async function doLogin() {
  const token  = $("#token").value.trim();
  const label  = $("#label").value.trim();
  const number = $("#number").value.trim();
  if (!token) {
    $("#msg").textContent = "Informe o token da instância";
    return;
  }
  try {
    const r = await fetch(BACKEND() + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, label, number_hint: number })
    });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    localStorage.setItem("luna_jwt", data.jwt);
    localStorage.setItem("luna_profile", JSON.stringify(data.profile || { label, number_hint: number }));
    switchToApp();
  } catch (e) {
    console.error(e);
    $("#msg").textContent = e.message || "Falha no login";
  }
}

function switchToApp() {
  // esconde login, mostra app
  hide("#login-view");
  show("#app-view");

  // header do perfil
  try {
    const p = JSON.parse(localStorage.getItem("luna_profile") || "{}");
    $("#profile").textContent = p.label ? `• ${p.label}` : "";
  } catch {}

  // carrega chats
  loadChats();
}

function ensureRoute() {
  if (jwt()) switchToApp();
  else { show("#login-view"); hide("#app-view"); }
}

/* ---------- CHATS/MESSAGES ---------- */
async function loadChats() {
  const list = $("#chat-list");
  list.innerHTML = "<div style='padding:12px;color:#8696a0'>Carregando...</div>";
  try {
    const data = await api("/api/chats", {
      method: "POST",
      body: JSON.stringify({ operator: "AND", sort: "-wa_lastMsgTimestamp", limit: 50, offset: 0 })
    });
    renderChats(data.chats || data.items || []);
  } catch (e) {
    console.error(e);
    list.innerHTML = `<div style='padding:12px;color:#f88'>Falha ao carregar chats: ${e.message}</div>`;
  }
}

function renderChats(chats) {
  const list = $("#chat-list"); list.innerHTML = "";
  if (!Array.isArray(chats) || chats.length === 0) {
    list.innerHTML = "<div style='padding:12px;color:#8696a0'>Nenhum chat encontrado</div>";
    return;
  }
  chats.forEach(ch => {
    const el = document.createElement("div");
    el.className = "chat-item";
    el.onclick = () => openChat(ch);
    const initials = (ch.wa_contactName || ch.name || "?").slice(0,2).toUpperCase();
    el.innerHTML = `
      <div class="avatar">${initials}</div>
      <div class="meta">
        <div class="name">${ch.wa_contactName || ch.name || ch.wa_chatid || "Contato"}</div>
        <div class="time">${ch.wa_lastMsgTimestamp || ""}</div>
        <div class="preview">${(ch.wa_lastMessageText || "").slice(0, 60)}</div>
      </div>`;
    list.appendChild(el);
  });
}

async function openChat(ch) {
  window.__CURRENT_CHAT__ = ch;
  $("#chat-header").textContent = ch.wa_contactName || ch.name || ch.wa_chatid || "Chat";
  $("#send-number").value = (ch.wa_chatid || "").replace("@s.whatsapp.net","").replace("@g.us","");
  await loadMessages(ch.wa_chatid);
}

async function loadMessages(chatid) {
  const pane = $("#messages");
  pane.innerHTML = "<div style='padding:12px;color:#8696a0'>Carregando...</div>";
  try {
    const data = await api("/api/messages", {
      method: "POST",
      body: JSON.stringify({ chatid, limit: 100, sort: "-messageTimestamp" })
    });
    renderMessages(data.messages || data.items || []);
  } catch (e) {
    console.error(e);
    pane.innerHTML = `<div style='padding:12px;color:#f88'>Falha ao carregar mensagens: ${e.message}</div>`;
  }
}

function renderMessages(msgs) {
  const pane = $("#messages"); pane.innerHTML = "";
  msgs.forEach(m => {
    const me = m.fromMe || m.fromme || m.from_me || false;
    const el = document.createElement("div");
    el.className = "msg " + (me ? "me" : "you");
    const text = m.text || m.message?.text || m.caption || m?.message?.conversation || m?.body || "";
    const who  = m.senderName || m.pushName || "";
    const ts   = m.messageTimestamp || m.timestamp || "";
    el.innerHTML = `${escapeHtml(text)}<small>${who} • ${ts}</small>`;
    pane.appendChild(el);
  });
  pane.scrollTop = pane.scrollHeight;
}

function escapeHtml(s){
  return String(s||"").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'' : '&#39;'}[m]));
}

/* ---------- SEND ---------- */
async function sendNow() {
  const number = $("#send-number").value.trim();
  const text   = $("#send-text").value.trim();
  if (!number || !text) return;
  try {
    await api("/api/send-text", { method:"POST", body: JSON.stringify({ number, text }) });
    $("#send-text").value = "";
  } catch (e) {
    alert(e.message || "Falha ao enviar");
  }
}

/* ---------- BOOT ---------- */
document.addEventListener("DOMContentLoaded", () => {
  $("#btn-login").onclick  = doLogin;
  $("#btn-logout").onclick = () => { localStorage.clear(); location.reload(); };
  $("#btn-send").onclick   = sendNow;
  $("#btn-refresh").onclick = () => {
    if (window.__CURRENT_CHAT__) loadMessages(window.__CURRENT_CHAT__.wa_chatid);
    else loadChats();
  };
  ensureRoute(); // decide qual view mostrar
});
