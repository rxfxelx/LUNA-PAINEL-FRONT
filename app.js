/* LUNA – FRONT READ-ONLY (com enrich de nome/foto) */
const BACKEND = () => (window.__BACKEND_URL__ || "").replace(/\/+$/, "");
const $  = (s) => document.querySelector(s);
const show = (sel) => $(sel).classList.remove("hidden");
const hide = (sel) => $(sel).classList.add("hidden");

/* ---------- JWT / API ---------- */
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

/* ---------- Utils ---------- */
const ENRICH_CACHE = new Map(); // chatid -> { name, imageUrl }
function getChatId(ch){ return ch?.wa_chatid || ch?.chatid || ch?.id || ""; }
function normalizeNumber(chatid){
  if (!chatid) return "";
  return chatid.includes("@") ? chatid : (chatid + "@s.whatsapp.net");
}
function getLastText(ch){ return ch?.wa_lastMessageText || ch?.wa_lastMessage?.text || ch?.lastText || ""; }
function getUnread(ch){ return ch?.wa_unreadCount ?? ch?.unread ?? 0; }
function timeStr(ts){
  if (!ts) return "";
  let n = Number(ts);
  if (n > 1e12) n = Math.floor(n/1000);
  if (!Number.isFinite(n)) return String(ts);
  return new Date(n*1000).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
}
function esc(s){ return String(s||"").replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

/* =======================
   LOGIN
   ======================= */
async function doLogin() {
  const token = $("#token").value.trim();
  const msgEl = $("#msg"); msgEl.textContent = "";
  if (!token) { msgEl.textContent = "Informe o token da instância"; return; }

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
    console.error("Login error:", e);
    msgEl.textContent = "Token inválido. Verifique e tente novamente.";
  }
}

function switchToApp() {
  hide("#login-view"); show("#app-view");
  const lv = document.getElementById("login-view");
  if (lv) lv.remove();
  try {
    const p = JSON.parse(localStorage.getItem("luna_profile")||"{}");
    $("#profile").textContent = p.label ? "• " + p.label : "";
  } catch {}
  loadChats();
}

function ensureRoute(){
  if (jwt()) switchToApp();
  else { show("#login-view"); hide("#app-view"); }
}

/* =======================
   CHATS
   ======================= */
async function loadChats() {
  const list = $("#chat-list");
  list.innerHTML = "<div class='hint'>Carregando...</div>";
  try {
    const data = await api("/api/chats", {
      method: "POST",
      body: JSON.stringify({ operator:"AND", sort:"-wa_lastMsgTimestamp", limit:50, offset:0 })
    });
    const items = Array.isArray(data?.items) ? data.items : [];
    if (!items.length) { list.innerHTML = "<div class='hint'>Nenhum chat encontrado</div>"; return; }
    renderChats(items);
    enrichChatsBatched(items.slice(0, 50));
  } catch (e) {
    console.error(e);
    list.innerHTML = `<div class='error'>Falha ao carregar chats: ${e.message}</div>`;
  }
}

function renderChats(chats){
  const list = $("#chat-list"); list.innerHTML = "";
  chats.forEach(ch => {
    const chatid = getChatId(ch);
    const name0  = ch.wa_contactName || ch.name || chatid || "Contato";
    const t      = timeStr(ch.wa_lastMsgTimestamp || ch.lastTs || ch.lastTimestamp);
    const prev   = getLastText(ch);
    const unread = getUnread(ch);

    const el = document.createElement("div");
    el.className = "chat-item";
    el.dataset.chatid = chatid;
    el.onclick = () => openChat(ch);

    el.innerHTML = `
      <div class="avatar"><span>${(name0||'?').slice(0,2).toUpperCase()}</span></div>
      <div class="chat-main">
        <div class="row1">
          <div class="name">${esc(name0)}</div>
          <div class="time">${esc(t)}</div>
        </div>
        <div class="row2">
          <div class="preview">${esc(prev)}</div>
          ${unread > 0 ? `<div class="badge">${unread}</div>` : ``}
        </div>
      </div>`;
    list.appendChild(el);

    if (ENRICH_CACHE.has(chatid)) applyNameImage(el, ENRICH_CACHE.get(chatid));
  });
}

/* ---------- Enriquecimento de nome/foto (POST /api/chat/GetNameAndImageURL) ---------- */
async function enrichChatsBatched(chats){
  const batchSize = 5;
  for (let i = 0; i < chats.length; i += batchSize) {
    const slice = chats.slice(i, i + batchSize);
    await Promise.allSettled(slice.map(ch => enrichOne(ch)));
  }
}

async function enrichOne(ch){
  const chatid = getChatId(ch);
  if (!chatid || ENRICH_CACHE.has(chatid)) return;

  try {
    const number = normalizeNumber(chatid);
    const info = await api("/api/chat/GetNameAndImageURL", {   // <- AQUI: POST no endpoint correto
      method: "POST",
      body: JSON.stringify({ number, preview: true })
    });
    const mapped = {
      name: info?.wa_name || info?.name || "",
      imageUrl: info?.imagePreview || info?.image || ""
    };
    ENRICH_CACHE.set(chatid, mapped);

    const row = document.querySelector(`.chat-item[data-chatid="${CSS.escape(chatid)}"]`);
    if (row) applyNameImage(row, mapped);
  } catch (e) {
    // falha silenciosa
  }
}

function applyNameImage(row, info){
  if (!row || !info) return;
  if (info.name)  row.querySelector(".name").textContent = info.name;
  if (info.imageUrl){
    const a = row.querySelector(".avatar");
    a.innerHTML = "";
    const img = document.createElement("img");
    img.src = info.imageUrl; img.alt = "avatar"; img.loading = "lazy";
    a.appendChild(img);
  }
}

/* =======================
   MESSAGES (READ-ONLY)
   ======================= */
async function openChat(ch){
  window.__CURRENT_CHAT__ = ch;
  const chatid = getChatId(ch);
  $("#chat-header").textContent = ch.wa_contactName || ch.name || chatid || "Chat";
  if (window.matchMedia("(max-width:1023px)").matches){
    document.body.classList.add("is-mobile-chat");
    document.body.classList.remove("is-mobile-list");
  }
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
    el.innerHTML = `${esc(text)}<small>${esc(who)} • ${esc(ts)}</small>`;
    pane.appendChild(el);
  });
  pane.scrollTop = pane.scrollHeight;
}

/* =======================
   MOBILE HELPERS
   ======================= */
function goList(){
  document.body.classList.add("is-mobile-list");
  document.body.classList.remove("is-mobile-chat");
}

/* =======================
   BOOT
   ======================= */
document.addEventListener("DOMContentLoaded", () => {
  $("#btn-login")?.addEventListener("click", doLogin);
  $("#btn-logout")?.addEventListener("click", () => { localStorage.clear(); location.reload(); });
  $("#btn-refresh")?.addEventListener("click", () => {
    if (window.__CURRENT_CHAT__) loadMessages(getChatId(window.__CURRENT_CHAT__));
    else loadChats();
  });
  $("#btn-back-mobile")?.addEventListener("click", goList);
  ensureRoute();
});
