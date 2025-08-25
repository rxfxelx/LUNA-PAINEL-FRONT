<script>
/* =========================
   Config + helpers
========================= */
const BACKEND = () => (window.__BACKEND_URL__ || "").replace(/\/+$/,"");
const $  = (s) => document.querySelector(s);
const show = (sel) => $(sel).classList.remove("hidden");
const hide = (sel) => $(sel).classList.add("hidden");
function jwt() { return localStorage.getItem("luna_jwt") || ""; }
function authHeaders() { return { "Authorization": "Bearer " + jwt() }; }
const isMobile = () => window.matchMedia("(max-width: 1023px)").matches;

async function api(path, opts = {}) {
  const res = await fetch(BACKEND() + path, {
    headers: { "Content-Type": "application/json", ...authHeaders(), ...(opts.headers||{}) },
    ...opts
  });
  if (!res.ok) {
    const t = await res.text().catch(()=> "");
    throw new Error(`HTTP ${res.status}: ${t}`);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

function escapeHtml(s){return String(s||"").replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
function formatTime(ts){
  if(!ts) return "";
  // aceitando timestamp Unix em segundos ou ms
  const n = Number(ts);
  const d = new Date(n < 2e12 ? n*1000 : n);
  return d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
}
function needsBetterName(name){
  if(!name) return true;
  const s = String(name).toLowerCase();
  return s.includes("@s.whatsapp.net") || /^\d{5,}@s\.whatsapp\.net$/.test(s) || /^\d+$/.test(s);
}

/* =========================
   LOGIN FLOW
========================= */
async function doLogin() {
  const token  = $("#token").value.trim();
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
    localStorage.setItem("luna_profile", JSON.stringify({ label: data?.profile?.label || null }));
    switchToApp();
  } catch (e) {
    console.error(e); $("#msg").textContent = "Token inválido. Verifique e tente novamente.";
  }
}

function switchToApp() {
  hide("#login-view"); show("#app-view");
  try { const p = JSON.parse(localStorage.getItem("luna_profile")||"{}");
        $("#profile").textContent = p.label ? `• ${p.label}` : ""; } catch {}
  if (isMobile()) document.body.classList.add("is-mobile-list");
  loadChats();
}

function ensureRoute(){ if (jwt()) switchToApp(); else { show("#login-view"); hide("#app-view"); } }

/* =========================
   NAME/IMAGE ENRICH (cache 60s + dedup)
========================= */
const enrichedCache = new Map(); // chatId -> { name, image, ts }
const inflight = new Map();      // chatId -> Promise
function cacheGetFresh(chatId){ const v = enrichedCache.get(chatId); return v && (Date.now()-v.ts<=60_000) ? v : null; }

/* =========================
   CHATS
========================= */
let __currentChat = null;

async function loadChats(){
  const list = $("#chat-list");
  list.innerHTML = "<div class='hint'>Carregando conversas...</div>";
  try{
    const data = await api("/api/chats", {
      method:"POST",
      body: JSON.stringify({ operator:"AND", sort:"-wa_lastMsgTimestamp", limit: 100, offset: 0 })
    });
    const items = Array.isArray(data?.items) ? data.items : [];
    if (!items.length){ list.innerHTML = "<div class='hint'>Nenhum chat encontrado</div>"; return; }
    renderChats(items);
  }catch(e){
    console.error(e);
    list.innerHTML = `<div class='error'>Falha ao carregar chats: ${escapeHtml(e.message)}</div>`;
  }
}

function renderChats(chats){
  const list = $("#chat-list"); list.innerHTML = "";
  chats.forEach(ch => list.appendChild(createChatItem(ch)));
}

function createChatItem(chat){
  // normaliza campos comuns
  const chatId  = chat.wa_chatid || chat.wa_chatId || chat.chatid || chat.chatId || "";
  const name    = chat.wa_contactName || chat.name || chat.wa_name || chatId || "";
  const unread  = Number(chat.wa_unreadCount || chat.unread || 0);
  const lastTS  = chat.wa_lastMsgTimestamp || chat.lastMessageTimestamp || chat.updatedAt || chat.ts || "";
  const preview = chat.wa_lastMessageText || chat.lastMessageText || chat.preview || "";

  const item    = document.createElement("div");
  item.className= "chat-item";
  const avatar  = document.createElement("div");
  avatar.className = "avatar";

  const main = document.createElement("div"); main.className = "chat-main";
  const row1 = document.createElement("div"); row1.className = "row1";
  const elName= document.createElement("div"); elName.className = "name"; elName.textContent = name;
  const elTime= document.createElement("div"); elTime.className = "time"; elTime.textContent = formatTime(lastTS);
  row1.append(elName, elTime);

  const row2 = document.createElement("div"); row2.className = "row2";
  const elPrev= document.createElement("div"); elPrev.className = "preview"; elPrev.textContent = preview || "";
  row2.appendChild(elPrev);

  if (unread > 0){
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = unread;
    row2.appendChild(badge);
  }

  main.append(row1, row2);
  item.append(avatar, main);

  const mount = {
    updateAvatar: (url)=> setAvatar(url),
    updateName:   (n)=> { elName.textContent = n; }
  };

  function drawFallback(){
    const span = document.createElement("span");
    const initials = (name || chatId || "?").split(" ").filter(Boolean)
      .slice(0,2).map(s=>s[0]?.toUpperCase()).join("") || "??";
    avatar.innerHTML = ""; span.textContent = initials; avatar.appendChild(span);
  }

  function setAvatar(url){
    avatar.innerHTML = "";
    if (url){
      const img = document.createElement("img");
      img.loading = "lazy"; img.alt="avatar"; img.referrerPolicy="no-referrer";
      img.src=url;
      let retried = false;
      img.onerror = async () => {
        if (retried){ drawFallback(); return; }
        retried = true;
        await enrichChatIfNeeded({ chatId, name }, mount, /*force*/true);
      };
      avatar.appendChild(img);
    } else { drawFallback(); }
  }

  // inicial
  drawFallback();
  // tenta enriquecer (nome/foto) com cache curto
  enrichChatIfNeeded({ chatId, name }, mount);

  // click
  item.onclick = () => openChat({ chatId, nameDisplay: elName.textContent });

  return item;
}

async function enrichChatIfNeeded(chat, mount, force=false){
  if (!chat.chatId) return;
  if (!force){
    const fresh = cacheGetFresh(chat.chatId);
    if (fresh){
      if (fresh.image) mount.updateAvatar(fresh.image);
      if (needsBetterName(chat.name) && fresh.name) mount.updateName(fresh.name);
      return;
    }
  }

  if (inflight.has(chat.chatId)){
    const r = await inflight.get(chat.chatId);
    if (r?.image) mount.updateAvatar(r.image);
    if (needsBetterName(chat.name) && r?.name) mount.updateName(r.name);
    return;
  }

  const p = (async () => {
    try{
      const data = await api("/api/name-image", {
        method: "POST",
        body: JSON.stringify({ number: chat.chatId, preview: true })
      });
      const res = {
        name:  data?.name  || data?.wa_name || data?.wa_contactName || "",
        image: data?.image || data?.imagePreview || ""
      };
      enrichedCache.set(chat.chatId, { ...res, ts: Date.now() });
      return res;
    }catch{ return null; }
  })();

  inflight.set(chat.chatId, p);
  const res = await p.finally(()=> inflight.delete(chat.chatId));
  if (!res) return;
  if (res.image) mount.updateAvatar(res.image);
  if (needsBetterName(chat.name) && res.name) mount.updateName(res.name);
}

/* =========================
   OPEN CHAT + MESSAGES
========================= */
async function openChat(ch){
  __currentChat = ch;
  $("#chat-header").textContent = ch.nameDisplay || ch.chatId || "Chat";
  $("#messages").innerHTML = "<div class='hint'>Carregando...</div>";
  if (isMobile()){ document.body.classList.remove("is-mobile-list"); document.body.classList.add("is-mobile-chat"); }
  loadMessages(ch.chatId);
}

async function loadMessages(chatid){
  const pane = $("#messages");
  try{
    const data = await api("/api/messages", {
      method: "POST",
      body: JSON.stringify({ chatid, limit: 120, sort: "-messageTimestamp" })
    });
    const items = Array.isArray(data?.items) ? data.items : [];
    renderMessages(items.reverse());
  }catch(e){
    console.error(e);
    pane.innerHTML = `<div class='error'>Falha ao carregar mensagens: ${escapeHtml(e.message)}</div>`;
  }
}

function renderMessages(msgs){
  const pane = $("#messages"); pane.innerHTML = "";
  msgs.forEach(m => {
    const me = !!(m.fromMe || m.fromme || m.from_me);
    const el = document.createElement("div");
    el.className = "msg " + (me ? "me" : "you");
    const who  = m.senderName || m.pushName || "";
    const ts   = m.messageTimestamp || m.timestamp || "";
    let text = (
      m.text || m.message?.text || m.caption || m?.message?.conversation || m?.body || ""
    );
    // midias básicas (mostra placeholder)
    if (!text && (m.type === "image" || m.message?.imageMessage)) text = "[imagem]";
    if (!text && (m.type === "video" || m.message?.videoMessage)) text = "[vídeo]";
    if (!text && (m.type === "audio" || m.message?.audioMessage)) text = "[áudio]";
    if (!text && (m.type === "document" || m.message?.documentMessage)) text = "[documento]";

    el.innerHTML = `${escapeHtml(text)}<small>${escapeHtml(who)} • ${formatTime(ts)}</small>`;
    pane.appendChild(el);
  });
  pane.scrollTop = pane.scrollHeight;
}

/* =========================
   SEND (se usar)
========================= */
async function sendNow(){
  const number = $("#send-number").value.trim();
  const text   = $("#send-text").value.trim();
  if (!number || !text) return;
  try{
    await api("/api/send-text", { method:"POST", body: JSON.stringify({ number, text }) });
    $("#send-text").value = "";
    if (__currentChat?.chatId) loadMessages(__currentChat.chatId);
  }catch(e){ alert(e.message || "Falha ao enviar"); }
}

/* =========================
   BOOT
========================= */
document.addEventListener("DOMContentLoaded", () => {
  $("#btn-login").onclick  = doLogin;
  $("#btn-logout").onclick = () => { localStorage.clear(); location.reload(); };
  $("#btn-send").onclick   = sendNow;
  $("#btn-refresh").onclick = () => {
    if (__currentChat) loadMessages(__currentChat.chatId);
    else loadChats();
  };
  ensureRoute();
  window.addEventListener("resize", () => {
    if (!jwt()) return;
    if (isMobile() && !__currentChat) { document.body.classList.add("is-mobile-list"); document.body.classList.remove("is-mobile-chat"); }
    else if (isMobile() && __currentChat) { document.body.classList.add("is-mobile-chat"); document.body.classList.remove("is-mobile-list"); }
    else { document.body.classList.remove("is-mobile-list","is-mobile-chat"); }
  });
});
</script>
