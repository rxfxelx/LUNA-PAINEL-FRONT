/* app.js — Luna Painel (frontend) */

/* ========= helpers ========= */
const BACKEND = () => (window.__BACKEND_URL__ || "").replace(/\/+$/,"");
const $       = (s) => document.querySelector(s);
const show    = (sel) => $(sel)?.classList.remove("hidden");
const hide    = (sel) => $(sel)?.classList.add("hidden");

function jwt(){ return localStorage.getItem("luna_jwt") || ""; }
function setJwt(v){ if(v) localStorage.setItem("luna_jwt", v); }
function clearAuth(){ localStorage.removeItem("luna_jwt"); localStorage.removeItem("luna_profile"); }

function authHeaders(extra={}) {
  const h = { "Content-Type": "application/json", ...extra };
  const t = jwt();
  if (t) h.Authorization = "Bearer " + t;
  return h;
}

async function api(path, opts={}) {
  const res = await fetch(BACKEND() + path, { headers: authHeaders(opts.headers||{}), ...opts });
  if (!res.ok) { let t=""; try{ t = await res.text(); }catch{} throw new Error(`HTTP ${res.status}: ${t}`); }
  return res.json();
}

/* ========= login ========= */
async function doLogin() {
  const token = $("#token")?.value?.trim();
  if (!token) { $("#msg").textContent = "Informe o token da instância"; return; }
  try {
    const r = await fetch(BACKEND()+"/api/auth/login", {
      method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ token })
    });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    setJwt(data.jwt);
    localStorage.setItem("luna_profile", "{}");
    switchToApp();
  } catch(e){ console.error(e); $("#msg").textContent = "Token inválido. Verifique e tente novamente."; }
}

function switchToApp(){ hide("#login-view"); show("#app-view"); loadChats(); }
function ensureRoute(){ if (jwt()) switchToApp(); else { show("#login-view"); hide("#app-view"); } }

/* ========= normalização ========= */
function firstNonEmpty(...arr){ for(const v of arr){ if(v!==undefined && v!==null && String(v).trim()!=="") return v; } return ""; }

function normalizeChat(raw){
  const chat = { ...raw };

  // ID
  chat.chatId = chat.wa_chatid || chat.chatid || chat.chatId || chat.wa_fastid || "";

  // Nome
  chat.name = firstNonEmpty(
    chat.wa_contactName, chat.contactName, chat.wa_name, chat.name, chat.chatId
  );

  // Avatar (se vier do backend)
  chat.image = chat.image || chat.profileImage || chat.photo || null;

  // Última mensagem (vários formatos possíveis)
  const lastText = firstNonEmpty(
    chat.wa_lastMessageText,
    chat.lastMessageText,
    chat.last_msg_text,
    chat.last_message_text,
    chat.lastMessage?.text,
    chat.preview,
    ""
  );
  const lastTs = Number(firstNonEmpty(
    chat.wa_lastMsgTimestamp,
    chat.lastMessage?.timestamp,
    chat.last_msg_timestamp,
    chat.timestamp,
    ""
  )) || null;

  chat.lastMessage = { text: lastText, timestamp: lastTs };
  return chat;
}

function fmtTime(tsSec){
  if (!tsSec) return "";
  const d = new Date(Number(tsSec) * 1000);
  return d.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"});
}

/* ========= enriquecimento (nome + foto) ========= */
const enrichedCache = new Map(); // chatId -> {name,image}

async function enrichChatIfNeeded(chat, mount) {
  if (!chat.chatId) return;

  // Já temos em cache?
  if (enrichedCache.has(chat.chatId)) {
    const cached = enrichedCache.get(chat.chatId);
    if (!chat.image && cached.image) mount.updateAvatar(cached.image);
    if (needsBetterName(chat.name) && cached.name) mount.updateName(cached.name);
    return;
  }

  // Precisa mesmo enriquecer?
  const missingImage = !chat.image;
  const weakName     = needsBetterName(chat.name);
  if (!missingImage && !weakName) return;

  try {
    const data = await api("/api/name-image", {
      method:"POST",
      body: JSON.stringify({ number: chat.chatId, preview: true })
    });
    const res = { name: data?.name || data?.wa_name || data?.wa_contactName || "", image: data?.image || "" };
    enrichedCache.set(chat.chatId, res);

    if (res.image && missingImage) mount.updateAvatar(res.image);
    if (res.name && weakName)      mount.updateName(res.name);

  } catch(e){ /* silencioso */ }
}

function needsBetterName(name){
  if (!name) return true;
  // nomes "fracos": apenas número/email do whatsapp
  const s = String(name).toLowerCase();
  return /@s\.whatsapp\.net$/.test(s) || /^\d+$/.test(s) || s.length<=2;
}

/* ========= render da lista ========= */
function renderChatItem(chat){
  // container
  const item = document.createElement("div");
  item.className = "chat-item";

  // avatar
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  const setAvatar = (url) => {
    avatar.innerHTML = "";
    if (url) {
      const img = document.createElement("img");
      img.src = url; img.loading="lazy"; img.alt = "avatar";
      avatar.appendChild(img);
    } else {
      const span = document.createElement("span");
      const initials = (chat.name || chat.chatId || "?")
        .split(" ").filter(Boolean).slice(0,2).map(s=>s[0]?.toUpperCase()).join("") || "??";
      span.textContent = initials;
      avatar.appendChild(span);
    }
  };
  setAvatar(chat.image);

  // meta
  const meta = document.createElement("div"); meta.className="meta";
  const row1 = document.createElement("div"); row1.className="row1";
  const name = document.createElement("div"); name.className="name"; name.textContent = chat.name || chat.chatId;
  const time = document.createElement("div"); time.className="time"; time.textContent = fmtTime(chat.lastMessage?.timestamp);
  row1.appendChild(name); row1.appendChild(time);

  const row2 = document.createElement("div"); row2.className="row2";
  const preview = document.createElement("div"); preview.className="preview";
  preview.textContent = chat.lastMessage?.text || "";
  row2.appendChild(preview);

  meta.appendChild(row1); meta.appendChild(row2);

  item.appendChild(avatar);
  item.appendChild(meta);

  // mount helpers para atualizar DOM quando enriquecer
  const mount = {
    updateAvatar: (url)=> setAvatar(url),
    updateName:   (n)=> { name.textContent = n; }
  };

  // enriquecimento (lazy, não trava a UI)
  enrichChatIfNeeded(chat, mount);

  item.onclick = ()=> openChat(chat.chatId, name.textContent);
  return item;
}

/* ========= carregar lista ========= */
async function loadChats(){
  const list = $("#chat-list");
  list.innerHTML = "<div class='hint'>Carregando...</div>";
  try{
    const data = await api("/api/chats", {
      method:"POST",
      body: JSON.stringify({ operator:"AND", sort:"-wa_lastMsgTimestamp", limit:100, offset:0 })
    });
    const items = Array.isArray(data?.items) ? data.items : [];
    if (!items.length){ list.innerHTML = "<div class='hint'>Nenhum chat encontrado</div>"; return; }

    list.innerHTML = "";
    items.map(normalizeChat).forEach(ch => list.appendChild(renderChatItem(ch)));

  } catch(e){
    console.error(e);
    list.innerHTML = `<div class='error'>Falha ao carregar chats: ${e.message}</div>`;
  }
}

/* ========= mensagens ========= */
let CURRENT_CHAT_ID = null;

async function openChat(chatId, title){
  CURRENT_CHAT_ID = chatId;
  $("#chat-header").textContent = title || chatId || "Chat";
  $("#messages").innerHTML = "<div class='hint'>Carregando...</div>";
  await loadMessages(chatId);

  if (window.matchMedia("(max-width:1023px)").matches) {
    document.body.classList.remove("is-mobile-list");
    document.body.classList.add("is-mobile-chat");
  }
}

async function loadMessages(chatId){
  const pane = $("#messages");
  try{
    const data = await api("/api/messages", {
      method:"POST",
      body: JSON.stringify({ chatid: chatId, limit: 100, sort: "-messageTimestamp" })
    });
    const items = Array.isArray(data?.items) ? data.items : [];
    renderMessages(items.reverse());
  } catch(e){
    console.error(e);
    pane.innerHTML = `<div class='error'>Falha ao carregar mensagens: ${e.message}</div>`;
  }
}

function renderMessages(msgs){
  const pane = $("#messages"); pane.innerHTML = "";
  msgs.forEach(m=>{
    const me = m.fromMe || m.fromme || m.from_me || false;
    const el = document.createElement("div");
    el.className = "msg " + (me?"me":"you");

    const text = firstNonEmpty(
      m.text, m.message?.text, m.caption, m?.message?.conversation, m?.body, ""
    );
    const who = firstNonEmpty(m.senderName, m.pushName, "");
    const ts  = firstNonEmpty(m.messageTimestamp, m.timestamp, "");

    el.innerHTML = `${escapeHtml(text)}<small>${escapeHtml(who)}${ts?" • "+ts:""}</small>`;
    pane.appendChild(el);
  });
  pane.scrollTop = pane.scrollHeight;
}

function escapeHtml(s){ return String(s||"").replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

/* ========= envio manual (opcional) ========= */
async function sendNow(){
  const number=$("#send-number")?.value?.trim();
  const text=$("#send-text")?.value?.trim();
  if(!number || !text) return;
  try{
    await api("/api/send-text",{ method:"POST", body: JSON.stringify({ number,text }) });
    $("#send-text").value="";
    if (CURRENT_CHAT_ID) loadMessages(CURRENT_CHAT_ID);
  }catch(e){ alert(e.message || "Falha ao enviar"); }
}

/* ========= eventos ========= */
document.addEventListener("DOMContentLoaded",()=>{
  $("#btn-login")   ?.addEventListener("click", doLogin);
  $("#btn-logout")  ?.addEventListener("click", ()=>{ clearAuth(); location.reload(); });
  $("#btn-send")    ?.addEventListener("click", sendNow);
  $("#btn-refresh") ?.addEventListener("click", ()=>{ CURRENT_CHAT_ID ? loadMessages(CURRENT_CHAT_ID) : loadChats(); });
  $(".btn.back")    ?.addEventListener("click", ()=>{
    document.body.classList.remove("is-mobile-chat");
    document.body.classList.add("is-mobile-list");
  });
  ensureRoute();
});
