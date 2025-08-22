const BACKEND = () => (window.__BACKEND_URL__ || "").replace(/\/+$/, "");
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

/* ---------- Caches/Helpers ---------- */
const NAME_CACHE = new Map(); // chatid -> { name, imageUrl }
let LABELS = [];

function getChatId(ch) {
  return ch?.wa_chatid || ch?.chatid || ch?.id || "";
}

/* ---------- LOGIN ---------- */
async function doLogin() {
  const server = $("#server") ? $("#server").value.trim() : ""; // campo novo no login
  const token  = $("#token").value.trim();
  const label  = $("#label").value.trim();
  const number = $("#number").value.trim();

  if (!server) { $("#msg").textContent = "Informe o Servidor (URL), ex: https://hia-clientes.uazapi.com"; return; }
  if (!token)  { $("#msg").textContent = "Informe o token da instância"; return; }

  try {
    const r = await fetch(BACKEND() + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server_url: server, token, label, number_hint: number })
    });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    localStorage.setItem("luna_jwt", data.jwt);
    localStorage.setItem("luna_profile", JSON.stringify({ ...(data.profile||{}), server_url: server }));
    switchToApp();
  } catch (e) {
    console.error(e); $("#msg").textContent = e.message || "Falha no login";
  }
}

function switchToApp() {
  hide("#login-view"); show("#app-view");
  try { const p = JSON.parse(localStorage.getItem("luna_profile")||"{}");
        $("#profile").textContent = p.label ? `• ${p.label}` : ""; } catch {}
  loadChats();
  // pré-carrega metadados (opcional)
  api("/api/labels").then(ls => { LABELS = ls; }).catch(()=>{});
  api("/api/instance/status").then(st => console.log("STATUS:", st)).catch(()=>{});
}

function ensureRoute() { if (jwt()) switchToApp(); else { show("#login-view"); hide("#app-view"); } }

/* ---------- CHATS/MESSAGES ---------- */
async function loadChats() {
  const list = $("#chat-list");
  list.innerHTML = "<div style='padding:12px;color:#8696a0'>Carregando...</div>";
  try {
    const data = await api("/api/chats", {
      method: "POST",
      body: JSON.stringify({ operator: "AND", sort: "-wa_lastMsgTimestamp", limit: 50, offset: 0 })
    });
    console.log("DEBUG /api/chats ->", data);
    const items = Array.isArray(data?.items) ? data.items : [];
    if (items.length === 0) {
      list.innerHTML = "<div style='padding:12px;color:#8696a0'>Nenhum chat encontrado</div>";
      return;
    }
    renderChats(items);
    enrichChats(items.slice(0, 30)); // busca nome/foto dos primeiros 30
  } catch (e) {
    console.error(e);
    list.innerHTML = `<div style='padding:12px;color:#f88'>Falha ao carregar chats: ${e.message}</div>`;
  }
}

function renderChats(chats) {
  const list = $("#chat-list"); list.innerHTML = "";
  chats.forEach(ch => {
    const chatid = getChatId(ch);
    const name0 = ch.wa_contactName || ch.name || chatid || "Contato";
    const initials = (name0 || "?").slice(0,2).toUpperCase();
    const el = document.createElement("div");
    el.className = "chat-item";
    el.dataset.chatid = chatid;
    el.onclick = () => openChat(ch);
    el.innerHTML = `
      <div class="avatar" style="width:36px;height:36px;border-radius:50%;background:#2a3942;display:inline-flex;align-items:center;justify-content:center;color:#8696a0;overflow:hidden">
        <span>${initials}</span>
      </div>
      <div class="meta">
        <div class="name">${name0}</div>
        <div class="time">${ch.wa_lastMsgTimestamp || ""}</div>
        <div class="preview">${(ch.wa_lastMessageText || "").slice(0, 60)}</div>
      </div>`;
    list.appendChild(el);

    if (NAME_CACHE.has(chatid)) applyNameImage(el, NAME_CACHE.get(chatid));
  });
}

async function enrichChats(chats) {
  const jobs = chats.map(async ch => {
    const chatid = getChatId(ch);
    if (!chatid || NAME_CACHE.has(chatid)) return;
    try {
      const info = await api(`/api/chat/name-image?chatid=${encodeURIComponent(chatid)}`, { method:"GET" });
      NAME_CACHE.set(chatid, info || {});
      const row = document.querySelector(`.chat-item[data-chatid="${CSS.escape(chatid)}"]`);
      if (row) applyNameImage(row, info || {});
    } catch (_) {}
  });
  await Promise.allSettled(jobs);
}

function applyNameImage(rowEl, info) {
  if (!rowEl || !info) return;
  if (info.name) rowEl.querySelector(".name").textContent = info.name;
  if (info.imageUrl) {
    const av = rowEl.querySelector(".avatar");
    av.innerHTML = "";
    const img = document.createElement("img");
    img.src = info.imageUrl; img.alt = "avatar";
    img.style.width="36px"; img.style.height="36px"; img.style.borderRadius="50%";
    av.appendChild(img);
  }
}

async function openChat(ch) {
  window.__CURRENT_CHAT__ = ch;
  const chatid = getChatId(ch);
  $("#chat-header").textContent = ch.wa_contactName || ch.name || chatid || "Chat";
  $("#send-number").value = (chatid || "").replace("@s.whatsapp.net","").replace("@g.us","");
  await loadMessages(chatid);
}

async function loadMessages(chatid) {
  const pane = $("#messages");
  pane.innerHTML = "<div style='padding:12px;color:#8696a0'>Carregando...</div>";
  try {
    const data = await api("/api/messages", {
      method: "POST",
      body: JSON.stringify({ chatid, limit: 100, sort: "-messageTimestamp" })
    });
    console.log("DEBUG /api/messages ->", data);
    const items = Array.isArray(data?.items) ? data.items : [];
    renderMessages(items);
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

function escapeHtml(s){ return String(s||"").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'' : '&#39;'}[m])); }

/* ---------- SEND ---------- */
async function sendNow() {
  const number = $("#send-number").value.trim();
  const text   = $("#send-text").value.trim();
  if (!number || !text) return;
  try { await api("/api/send-text", { method:"POST", body: JSON.stringify({ number, text }) });
        $("#send-text").value = ""; }
  catch (e) { alert(e.message || "Falha ao enviar"); }
}

/* ---------- BOOT ---------- */
document.addEventListener("DOMContentLoaded", () => {
  $("#btn-login").onclick  = doLogin;
  $("#btn-logout").onclick = () => { localStorage.clear(); location.reload(); };
  $("#btn-send").onclick   = sendNow;
  $("#btn-refresh").onclick = () => {
    if (window.__CURRENT_CHAT__) loadMessages(getChatId(window.__CURRENT_CHAT__));
    else loadChats();
  };
  ensureRoute();
});
