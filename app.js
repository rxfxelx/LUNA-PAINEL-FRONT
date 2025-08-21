const backend = () => (window.__BACKEND_URL__||"").replace(/\/+$/,"")
const jwt = () => localStorage.getItem("luna_jwt")||""
const auth = () => ({ "Authorization": "Bearer "+jwt() })

let CURRENT_CHAT=null, es=null

async function api(path, opts={}){
  const r = await fetch(backend()+path,{headers:{ "Content-Type":"application/json",...auth()},...opts})
  if(!r.ok) throw new Error(await r.text())
  return r.json()
}

function showLogin(){document.getElementById("login-view").classList.remove("hidden");document.getElementById("app-view").classList.add("hidden")}
function showApp(){document.getElementById("login-view").classList.add("hidden");document.getElementById("app-view").classList.remove("hidden")}

document.addEventListener("DOMContentLoaded",()=>{
  if(jwt()) {showApp(); initApp()} else showLogin()

  document.getElementById("btn-login").onclick=async()=>{
    const token=document.getElementById("token").value.trim()
    const label=document.getElementById("label").value.trim()
    const number=document.getElementById("number").value.trim()
    try{
      const r=await fetch(backend()+"/api/auth/login",{method:"POST",headers:{ "Content-Type":"application/json"},body:JSON.stringify({token,label,number_hint:number})})
      if(!r.ok) throw new Error(await r.text())
      const d=await r.json()
      localStorage.setItem("luna_jwt",d.jwt)
      localStorage.setItem("luna_profile",JSON.stringify({label,number}))
      showApp(); initApp()
    }catch(e){document.getElementById("msg").textContent=e.message}
  }
})

function initApp(){
  const p=JSON.parse(localStorage.getItem("luna_profile")||"{}")
  document.getElementById("profile").textContent=(p.label||"")+" "+(p.number?"• "+p.number:"")
  document.getElementById("btn-logout").onclick=()=>{localStorage.clear();location.reload()}
  document.getElementById("btn-send").onclick=sendText
  document.getElementById("btn-sse").onclick=()=>{startSSE();alert("SSE conectado")}
  loadChats()
}

async function loadChats(){
  const list=document.getElementById("chat-list")
  list.innerHTML="<div style='padding:12px;color:#8696a0'>Carregando...</div>"
  try{
    const d=await api("/api/chats",{method:"POST",body:JSON.stringify({limit:50})})
    renderChats(d.chats||d.items||[])
  }catch(e){list.innerHTML="<div style='padding:12px;color:#f88'>"+e.message+"</div>"}
}

function renderChats(chats){
  const list=document.getElementById("chat-list"); list.innerHTML=""
  chats.forEach(ch=>{
    const d=document.createElement("div"); d.className="chat-item"; d.onclick=()=>openChat(ch)
    const initials=(ch.wa_contactName||ch.name||"?").slice(0,2).toUpperCase()
    d.innerHTML=`<div class="avatar">${initials}</div>
      <div class="meta"><div class="name">${ch.wa_contactName||ch.name||ch.wa_chatid}</div>
      <div class="time">${ch.wa_lastMsgTimestamp||""}</div>
      <div class="preview">${(ch.wa_lastMessageText||"").slice(0,60)}</div></div>`
    list.appendChild(d)
  })
}

async function openChat(ch){
  CURRENT_CHAT=ch
  document.getElementById("chat-header").textContent=ch.wa_contactName||ch.name||ch.wa_chatid
  document.getElementById("send-number").value=(ch.wa_chatid||"").replace("@s.whatsapp.net","").replace("@g.us","")
  await loadMessages(ch.wa_chatid)
}

async function loadMessages(chatid){
  const pane=document.getElementById("messages")
  pane.innerHTML="<div style='padding:12px;color:#8696a0'>Carregando...</div>"
  try{
    const d=await api("/api/messages",{method:"POST",body:JSON.stringify({chatid,limit:100})})
    renderMessages(d.messages||d.items||[])
  }catch(e){pane.innerHTML="<div style='padding:12px;color:#f88'>"+e.message+"</div>"}
}

function renderMessages(msgs){
  const pane=document.getElementById("messages"); pane.innerHTML=""
  msgs.forEach(m=>{
    const mine=m.fromMe||m.fromme||m.from_me||false
    const div=document.createElement("div"); div.className="msg "+(mine?"me":"you")
    const text=m.text||m.message?.text||m.caption||m?.message?.conversation||m?.body||""
    const who=m.senderName||m.pushName||""
    const ts=m.messageTimestamp||m.timestamp||""
    div.innerHTML=`${escapeHtml(text)}<small>${who} • ${ts}</small>`
    pane.appendChild(div)
  })
  pane.scrollTop=pane.scrollHeight
}

function escapeHtml(s){return String(s||"").replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[m]))}

async function sendText(){
  const number=document.getElementById("send-number").value.trim()
  const text=document.getElementById("send-text").value.trim()
  if(!number||!text)return
  try{await api("/api/send-text",{method:"POST",body:JSON.stringify({number,text})});document.getElementById("send-text").value=""}catch(e){alert(e.message)}
}

function startSSE(){
  if(es){es.close();es=null}
  es=new EventSource(backend()+"/api/sse?jwt="+jwt())
  es.onmessage=()=>{if(CURRENT_CHAT)loadMessages(CURRENT_CHAT.wa_chatid);else loadChats()}
}
