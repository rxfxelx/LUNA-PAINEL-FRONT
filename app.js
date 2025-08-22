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

/* ---------- Caches ---------- */
const NAME_CACHE = new Map(); // chatid -> { name, imageUrl }
let LABELS = [];

/* ---------- Utils ---------- */
function getChatId(ch){ return ch?.wa_chatid || ch?.chatid || ch?.id || ""; }
function getLastText(ch){ return ch?.wa_lastMessageText || ch?.wa_lastMessage?.text || ch?.lastText || ""; }
function getUnread(ch){ return ch?.wa_unreadCount || ch?.unread || 0; }
function formatTime(ts){
  if (!ts) return "";
  let n = Number(ts);
  if (!Number.isFinite(n)) return String(ts);
  if (n > 1e12) n = Math.floor(n/1000); // ms -> s
  const d = new Date(n*1000);
  return d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
}
function escapeHtml(s){ return String(s||"").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'' : '&#39;'}[m])); }

/* ---------- LOGIN (host fixo no backend) ---------- */
async function doLogin() {
  const token  = $("#token").value.trim();
  const label  = $("#label").value.trim();
  const number = $("#number").value.trim();
  if (!token)  { $("#msg").textContent = "Informe o token da instância"; return; }

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
    console.error(e); $("#msg").textContent = e.message || "Falha no login";
  }
}

function switchToApp() {
  hide("#login-view"); show("#app-view");
  try { const p = JSON.parse(localStorage.getItem("luna_profile")||"{}");
        $("#profile").textContent = p.label ? `• ${p.label}` : ""; } catch {}
  loadChats();
  api("/api/labels").then(ls => { LABELS = ls; }).catch(()=>{});
  api("/api/instance/status").then(st => console.log("STATUS:", st)).catch(()=>{});
}

function ensureRoute(){ if (jwt()) switchToApp(); else { show("#login-view"); hide("#app-view"); } }

/* ---------- CHATS ---------- */
async function loadChats() {
  const list = $("#chat-list");
  list.innerHTML = "<div class='hint'>Carregando...</div>";
  try {
    const data = await api("/api/chats", {
      method: "POST",
      body: JSON.stringify({ operator: "AND", sort: "-wa_lastMsgTimestamp", limit: 50, offset: 0 })
    });
    const items = Array.isArray(data?.items) ? data.items : [];
    if (items.length === 0) { list.innerHTML = "<div class='hint'>Nenhum chat encontrado</div>"; return; }
    renderChats(items);
    enrichChats(items.slice(0, 50));
  } catch (e) {
    console.error(e);
    list.innerHTML = `<div class='error'>Falha ao carregar chats: ${e.message}</div>`;
  }
}

function renderChats(chats){
  const list = $("#chat-list"); list.innerHTML = "";
  chats.forEach(ch => {
    const chatid  = getChatId(ch);
    const name0   = ch.wa_contactName || ch.name || chatid || "Contato";
    const preview = getLastText(ch);
    const time    = formatTime(ch.wa_lastMsgTimestamp || ch.lastTs || ch.lastTimestamp);
    const unread  = getUnread(ch);

    const el = document.createElement("div");
    el.className = "chat-item";
    el.dataset.chatid = chatid;
    el.onclick = () => openChat(ch);
    el.innerHTML = `
      <div class="avatar">
        <span>${(name0||"?").slice(0,2).toUpperCase()}</span>
      </div>
      <div class="chat-main">
        <div class="row1">
          <div class="name">${escapeHtml(name0)}</div>
          <div class="time">${escapeHtml(time)}</div>
        </div>
        <div class="row2">
          <div class="preview">${escapeHtml(preview)}</div>
          ${unread ? `<div class="badge">${unread}</div>` : `<div class="badge badge--empty"></div>`}
        </div>
      </div>
    `;
    list.appendChild(el);

    if (NAME_CACHE.has(chatid)) applyNameImage(el, NAME_CACHE.get(chatid));
  });
}

async function enrichChats(chats){
  const jobs = chats.map(async ch => {
    const chatid = getChatId(ch);
    if (!chatid || NAME_CACHE.has(chatid)) return;
    try {
      const info = await api(`/api/chat/name-image?chatid=${encodeURIComponent(chatid)}`, { method:"GET" });
      NAME_CACHE.set(chatid, info || {});
      const row = document.querySelector(`.chat-item[data-chatid="${CSS.escape(chatid)}"]`);
      if (row) applyNameImage(row, info || {});
    } catch {}
  });
  await Promise.allSettled(jobs);
}

function applyNameImage(rowEl, info){
  if (!rowEl || !info) return;
  if (info.name)  rowEl.querySelector(".name").textContent = info.name;
  if (info.imageUrl){
    const a = rowEl.querySelector(".avatar");
    a.innerHTML = "";
    const img = document.createElement("img");
    img.src = info.imageUrl; img.alt = "avatar";
    a.appendChild(img);
  }
}

/* ---------- MESSAGES ---------- */
async function openChat(ch){
  window.__CURRENT_CHAT__ = ch;
  const chatid = getChatId(ch);
  $("#chat-header").textContent = ch.wa_contactName || ch.name || chatid || "Chat";
  $("#send-number").value = (chatid || "").replace("@s.whatsapp.net","").replace("@g.us","");
  await loadMessages(chatid);
}

async function loadMessages(chatid){
  const pane = $("#messages");
  pane.innerHTML = "<div class='hint'>Carregando...</div>";
  try {
    const data = await api("/api/messages", {
      method: "POST",
      body: JSON.stringify({ chatid, limit: 100, sort: "-messageTimestamp" })
    });
    const items = Array.isArray(data?.items) ? data.items : [];
    renderMessages(items);
  } catch (e) {
    console.error(e);
    pane.innerHTML = `<div class='error'>Falha ao carregar mensagens: ${e.message}</div>`;
  }
}

function renderMessages(msgs){
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

/* ---------- SEND ---------- */
async function sendNow(){
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
