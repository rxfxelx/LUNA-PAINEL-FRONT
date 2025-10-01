// app.js
/* =========================================
 * 1) CONFIG / HELPERS BÁSICOS
 * ======================================= */
const BACKEND = () => (window.__BACKEND_URL__ || "").replace(/\/+$/, "")
const $ = (s) => document.querySelector(s)
const show = (sel) => { const el = $(sel); if (el) el.classList.remove("hidden") }
const hide = (sel) => { const el = $(sel); if (el) el.classList.add("hidden") }

// Polyfill simples para CSS.escape (compat com navegadores antigos)
;(() => {
  try {
    if (!window.CSS) window.CSS = {}
    if (!CSS.escape) {
      CSS.escape = (v) => String(v).replace(/[^\w-]/g, (c) => '\\' + c.charCodeAt(0).toString(16) + ' ')
    }
  } catch {}
})()

// Idle callback
const rIC = (cb) => (window.requestIdleCallback ? window.requestIdleCallback(cb, { timeout: 200 }) : setTimeout(cb, 0))

// Limitador de concorrência
async function runLimited(tasks, limit = 8) {
  const results = []
  let i = 0
  const workers = new Array(Math.min(limit, tasks.length)).fill(0).map(async () => {
    while (i < tasks.length) {
      const cur = i++
      try { results[cur] = await tasks[cur]() } catch { results[cur] = undefined }
    }
  })
  await Promise.all(workers)
  return results
}

function isMobile() { return window.matchMedia("(max-width:1023px)").matches }
function setMobileMode(mode) {
  document.body.classList.remove("is-mobile-list", "is-mobile-chat")
  if (!isMobile()) return
  if (mode === "list") document.body.classList.add("is-mobile-list")
  if (mode === "chat") document.body.classList.add("is-mobile-chat")
}

function jwt() { return localStorage.getItem("luna_jwt") || "" }

// --- decodifica payload do JWT com padding (corrigido) ---
function jwtPayload() {
  const t = jwt()
  if (!t || t.indexOf(".") < 0) return {}
  try {
    let b64 = t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")
    b64 += "=".repeat((4 - (b64.length % 4)) % 4)
    const json = atob(b64)
    return JSON.parse(json)
  } catch { return {} }
}

/* >>> NOVO: helpers para obter email do usuário logado (conta/instância) */
function decodeJwtPayload(token) {
  try {
    if (!token || token.indexOf(".") < 0) return {}
    let b64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")
    b64 += "=".repeat((4 - (b64.length % 4)) % 4)
    return JSON.parse(atob(b64))
  } catch { return {} }
}
function userEmail() {
  try {
    const acct = localStorage.getItem("luna_acct_jwt") || ""
    const p1 = decodeJwtPayload(acct)
    const e1 = (p1.email || p1.user_email || "").trim()
    if (e1) return e1
    const inst = localStorage.getItem("luna_jwt") || ""
    const p2 = decodeJwtPayload(inst)
    const e2 = (p2.email || p2.user_email || "").trim()
    if (e2) return e2
    return ""
  } catch { return "" }
}
/* <<< FIM: helpers de email */

function authHeaders() {
  const headers = { Authorization: "Bearer " + jwt() }
  const p = jwtPayload()
  const iid = p.instance_id || p.phone_number_id || p.pnid || p.sub || ""
  if (iid) headers["x-instance-id"] = String(iid)
  return headers
}

/*
 * Unwraps nested WhatsApp message containers. Some message
 * types (for example, viewOnceMessage or ephemerals) wrap the actual
 * payload in an additional object. This helper will drill down
 * through these wrappers so that downstream renderers can detect
 * media, interactive components and quoted previews correctly.
 * It will return the innermost message object it can find.
 */
function unwrapMessage(msg) {
  /*
   * Many APIs, including Uazapi, wrap the actual WhatsApp payload under
   * either a `.message` or `.content` property.  Additionally, view‑once
   * and ephemerals add another `.message` layer.  This helper walks
   * through these wrappers, preferring `.message` or `.content` when
   * present.  It stops when no further unwrapping is possible or when
   * the container has multiple keys (indicating a fully populated
   * structure).
   */
  try {
    let m = msg
    while (m) {
      // Determine the immediate container: .message or .content
      const container = (m && (m.message || m.content)) || null
      if (!container || typeof container !== 'object' || Array.isArray(container)) break
      // Handle viewOnce wrappers
      if (container.viewOnceMessage && container.viewOnceMessage.message) {
        m = container.viewOnceMessage.message
        continue
      }
      // Handle ephemerals
      if (container.ephemeralMessage && container.ephemeralMessage.message) {
        m = container.ephemeralMessage.message
        continue
      }
      // If the container contains exactly one key ending in 'Message', unwrap it
      const keys = Object.keys(container)
      if (keys.length === 1 && keys[0].endsWith('Message')) {
        m = container
        continue
      }
      // Otherwise stop unwrapping
      break
    }
    return m
  } catch {
    return msg
  }
}

/*
 * Recursively search a nested object for the first property whose key
 * appears in `keys`.  This is useful for locating media message
 * structures (e.g. imageMessage, videoMessage, documentMessage) or
 * interactive response structures (e.g. listResponseMessage,
 * buttonsResponseMessage) that might be wrapped in multiple layers
 * (templateMessage, hydratedTemplate, interactiveMessage, etc.).  The
 * search depth is limited to prevent excessive traversal.
 *
 * @param {object} obj The object to search
 * @param {string[]} keys A list of keys to look for
 * @param {number} depth Maximum depth to search
 * @returns {object|null} The found nested object or null if none
 */
function findNested(obj, keys, depth = 4) {
  if (!obj || typeof obj !== 'object' || depth < 0) return null
  for (const k of keys) {
    if (obj[k] && typeof obj[k] === 'object') return obj[k]
  }
  for (const key in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue
    const val = obj[key]
    if (val && typeof val === 'object') {
      const found = findNested(val, keys, depth - 1)
      if (found) return found
    }
  }
  return null
}

/*
 * Recursively search a nested object for the first string value whose key
 * matches any of the provided keys. This helper is used to locate a
 * descriptive display name for the instance across arbitrarily nested
 * structures returned by the Uazapi `/instance/status` endpoint.  It
 * searches breadth‑first up to a configurable depth and returns the
 * first non‑empty string it encounters.  If nothing is found it
 * returns null.
 *
 * @param {object} obj The object to search
 * @param {string[]} keys List of keys to look for
 * @param {number} depth Maximum depth to search
 * @returns {string|null} The found value or null
 */
function findFirstValue(obj, keys, depth = 4) {
  if (!obj || typeof obj !== 'object' || depth < 0) return null
  for (const k of keys) {
    const val = obj[k]
    if (typeof val === 'string' && val.trim()) return val
  }
  for (const key in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue
    const val = obj[key]
    if (val && typeof val === 'object') {
      const found = findFirstValue(val, keys, depth - 1)
      if (found) return found
    }
  }
  return null
}

/*
 * Attempt to obtain a human‑friendly name for the currently connected
 * instance. When a user connects an instance via token, the backend
 * proxy (/api/meta/instance/status) will forward the UAZAPI status
 * response. As the format of this response can vary between
 * deployments, this helper searches through a number of commonly
 * used fields to locate a displayable instance name. If none are
 * found, it falls back to the logged in account email address or
 * returns null. The actual DOM update happens in `updateProfileName`.
 */
async function fetchInstanceNameCandidate() {
  try {
    const data = await api('/api/meta/instance/status', { method: 'GET' })
    /*
     * Search for descriptive instance name fields across the entire
     * response.  The Uazapi documentation suggests that fields such as
     * `profileName` or `name` may appear on objects like `instance`,
     * `clientStatus` or `client`.  However, implementations vary and
     * sometimes nest these values deeper.  To remain robust, we
     * traverse the returned JSON looking for the first occurrence of
     * any of a list of candidate keys.  We then filter out values
     * containing an '@' symbol (likely an email) before returning.
     */
    if (data && typeof data === 'object') {
      const fields = [
        'profileName', 'profile_name', 'instanceName', 'pushname', 'pushName', 'push_name',
        'widName', 'name', 'userName', 'phoneName', 'displayName', 'owner',
        'ownerName', 'instanceDisplayName', 'title', 'nickName'
      ]
      let candidate = findFirstValue(data, fields, 6)
      if (candidate && typeof candidate === 'string') {
        candidate = candidate.trim()
        // Skip values that look like an email address
        if (candidate && !/@/.test(candidate)) {
          return candidate
        }
      }
    }
  } catch (e) {
    console.error('Failed to fetch instance name:', e)
  }
  // Fall back to user email if available
  const email = (typeof userEmail === 'function' ? userEmail() : '')
  return email || null
}

/*
 * Update the small profile label in the top bar. Called after
 * successfully connecting an instance or when switching into the
 * application. Does nothing if the DOM element is not found.
 */
/**
 * Atualiza o label de perfil com o nome da instância.  Este método tenta
 * obter um nome legível via `fetchInstanceNameCandidate()`.  Em alguns
 * cenários, o backend pode retornar apenas o e‑mail do operador até que
 * a instância esteja completamente conectada.  Para lidar com isso, se
 * o valor retornado contiver um "@" (sugerindo um e‑mail) ou estiver
 * vazio, uma nova tentativa será agendada após alguns segundos.  O
 * número de tentativas é limitado para evitar chamadas infinitas.
 *
 * @param {number} retryCount Número de tentativas já realizadas.
 */
async function updateProfileName(retryCount = 0) {
  const el = document.getElementById('profile')
  if (!el) return
  try {
    const name = await fetchInstanceNameCandidate()
    const isEmail = typeof name === 'string' && /@/.test(name)
    // Only update if we have a non‑empty name that does not look like an e‑mail
    if (name && typeof name === 'string' && name.trim() && !isEmail) {
      el.textContent = name.trim()
      return
    }
    // If the candidate looks like an e‑mail or is falsy, and we have
    // remaining retries, schedule another attempt.  This helps when the
    // instance is connecting and the profile name becomes available
    // shortly thereafter.
    if (retryCount < 5) {
      setTimeout(() => updateProfileName(retryCount + 1), 4000)
    } else if (name && typeof name === 'string') {
      // After exhausting retries, fall back to whatever we have
      el.textContent = name.trim()
    }
  } catch (e) {
    console.error('updateProfileName failed', e)
  }
}

async function api(path, opts = {}) {
  const res = await fetch(BACKEND() + path, {
    headers: { "Content-Type": "application/json", ...authHeaders(), ...(opts.headers || {}) },
    ...opts,
  })
  if (!res.ok) {
    const t = await res.text().catch(() => "")
    throw new Error(`HTTP ${res.status}: ${t}`)
  }
  return res.json().catch(() => ({}))
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[m])
}
function truncatePreview(s, max = 90) {
  const t = String(s || "").replace(/\s+/g, " ").trim()
  if (!t) return ""
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t
}

/* ===== Helpers de pagamento (sanitização e normalização) ===== */
function digitsOnly(s) { return String(s || "").replace(/\D+/g, "") }

function validCPF(cpf) {
  const s = String(cpf || "").replace(/\D+/g, "");
  if (s.length !== 11) return false;
  if (/^(\d)\1+$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(s[i], 10) * (10 - i);
  let d1 = 11 - (sum % 11); if (d1 >= 10) d1 = 0;
  if (d1 !== parseInt(s[9], 10)) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(s[i], 10) * (11 - i);
  let d2 = 11 - (sum % 11); if (d2 >= 10) d2 = 0;
  return d2 === parseInt(s[10], 10);
}
function validCNPJ(cnpj) {
  const s = String(cnpj || "").replace(/\D+/g, "");
  if (s.length !== 14) return false;
  if (/^(\d)\1+$/.test(s)) return false;
  const calc = (base) => {
    let len = base.length;
    let pos = len - 7, sum = 0;
    for (let i = len; i >= 1; i--) {
      sum += base[len - i] * pos--;
      if (pos < 2) pos = 9;
    }
    const r = sum % 11;
    return (r < 2) ? 0 : 11 - r;
  };
  const base = s.substring(0, 12).split("").map(Number);
  const d1 = calc(base);
  const d2 = calc(base.concat([d1]));
  return (String(d1) === s[12] && String(d2) === s[13]);
}

// Remove acentos e normaliza para A-Z e espaço
function stripDiacritics(str) {
  try { return String(str || "").normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
  catch(e) { return String(str || ""); }
}
// Mantém apenas A-Z e espaço; colapsa múltiplos espaços
function sanitizeCardholderName(name) {
  const s = stripDiacritics(String(name || "")).toUpperCase().replace(/[^A-Z\s]/g, " ").replace(/\s+/g, " ").trim();
  return s;
}

function pad2(v) { return String(v || "").padStart(2, "0").slice(-2) }
function toYYYY(v) {
  const d = digitsOnly(v)
  if (d.length === 4) return d
  if (d.length === 2) return '20' + pad2(d)
  if (d.length === 3) return '20' + d.slice(-2)
  if (d.length === 0) return ''
  return (d.length > 4) ? d.slice(0,4) : ('20' + pad2(d.slice(-2)))
}
function splitName(full) {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return { first_name: "", last_name: "" }
  const first_name = parts.shift()
  const last_name = parts.length ? parts.join(" ") : first_name
  return { first_name, last_name }
}

// Antigo (E.164) — não usar no payload Getnet
function formatPhoneE164BR(phone) {
  if (!phone) return ""
  let p = String(phone).trim()
  if (p.startsWith("+")) return p.replace(/[^\d+]/g, "")
  p = digitsOnly(p)
  if (!p) return ""
  if (p.startsWith("55")) return "+" + p
  return "+55" + p
}

// Novo: apenas dígitos BR (10–11). Remove 55 se vier com DDI.
function phoneDigitsBR(phone) {
  let d = digitsOnly(phone)
  if (d.startsWith("55")) d = d.slice(2)
  return d
}

// Bandeiras aceitas pela Getnet
function detectBrand(cardNumber) {
  const n = digitsOnly(cardNumber)
  if (/^4\d{12,18}$/.test(n)) return "Visa"
  if (/^(5[1-5]\d{14}|2(2[2-9]\d{12}|[3-6]\d{13}|7[01]\d{12}|720\d{12}))$/.test(n)) return "Mastercard"
  if (/^(34|37)\d{13}$/.test(n)) return "Amex"
  // Elo/Hipercard: manter conforme seleção quando regex não detectar
  return null
}
function normalizeBrand(selected, cardNumber) {
  const det = detectBrand(cardNumber)
  if (det) return det
  const m = String(selected || "").trim().toLowerCase()
  if (m.includes("visa")) return "Visa"
  if (m.includes("master")) return "Mastercard"
  if (m.includes("amex") || m.includes("american")) return "Amex"
  if (m.includes("hiper")) return "Hipercard"
  if (m.includes("elo")) return "Elo"
  // fallback seguro
  return "Visa"
}

/* ----- CACHE LOCAL (TTL) + DE-DUPE ----- */
const TTL = {
  NAME_IMAGE_HIT: 24 * 60 * 60 * 1000,
  NAME_IMAGE_MISS: 5 * 60 * 1000,
  PREVIEW: 10 * 60 * 1000,
}
const LStore = {
  get(key) {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) return null
      const { v, exp } = JSON.parse(raw)
      if (exp && Date.now() > exp) { localStorage.removeItem(key); return null }
      return v
    } catch { return null }
  },
  set(key, val, ttlMs) {
    try { localStorage.setItem(key, JSON.stringify({ v: val, exp: Date.now() + (ttlMs || 0) })) } catch {}
  },
}
const inflight = new Map()
function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key)
  const p = Promise.resolve().then(fn).finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}
function prettyId(id = "") {
  const s = String(id)
  if (/@s\.whatsapp\.net$/i.test(s)) return s.replace(/@s\.whatsapp\.net$/i, "")
  return s
}

/* ========= NDJSON STREAM ========= */
async function* readNDJSONStream(resp) {
  const reader = resp.body.getReader()
  const decoder = new TextDecoder("utf-8")
  let buf = ""
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      try { yield JSON.parse(line) } catch {}
    }
  }
  if (buf.trim()) { try { yield JSON.parse(buf.trim()) } catch {} }
}

// ==== Conta (auth de e-mail/senha) ====
const ACCT_JWT_KEY = "luna_acct_jwt"
function acctJwt() { return localStorage.getItem(ACCT_JWT_KEY) || "" }
function acctHeaders() {
  const h = { "Content-Type": "application/json" }
  const t = acctJwt()
  if (t) h.Authorization = "Bearer " + t
  return h
}
async function acctApi(path, opts = {}) {
  const res = await fetch(BACKEND() + path, { headers: { ...acctHeaders(), ...(opts.headers || {}) }, ...opts })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => "")}`)
  return res.json().catch(() => ({}))
}

// ==== Billing System ====
// ⚠️ Alterado: registrar trial para CONTA e INSTÂNCIA sempre (idempotente)
let billingStatus = null
async function registerTrialUser() {
  try { await acctApi("/api/billing/register-trial", { method: "POST" }); console.log("[v1] Trial user registered") }
  catch (e) { console.error("[v1] Failed to register user trial:", e) }
}
async function registerTrial() {
  try {
    // Conta
    if (acctJwt()) {
      await acctApi("/api/billing/register-trial", { method: "POST" })
      console.log("[trial] conta OK")
    }
  } catch (e) { console.warn("[trial] conta falhou (ignorado):", e) }
  try {
    // Instância
    if (jwt()) {
      await api("/api/billing/register-trial", { method: "POST" })
      console.log("[trial] instância OK")
    }
  } catch (e) { console.warn("[trial] instância falhou (ignorado):", e) }
}

/**
 * Verifica status de billing (prioriza a INSTÂNCIA).
 * Quando allowModal=false, nunca abre o modal.
 */
async function checkBillingStatus(opts = {}) {
  const { allowModal = true } = opts
  let ok = true
  let st = null
  let key = window.__BILLING_KEY__ || ""

  try {
    // 1) Prioriza status da INSTÂNCIA (é o que guarda as conversas)
    const r = await fetch(BACKEND() + "/api/billing/status", { headers: { ...authHeaders() } })
    if (r.ok) {
      const data = await r.json().catch(() => ({}))
      st = data?.status ?? data
      key = data?.billing_key || data?.key || data?.tenant_key || key
      ok = !(st?.require_payment === true) && (st?.active !== false)
    } else if (r.status === 402) {
      const txt = await r.text().catch(() => "")
      let j = {}
      try { j = JSON.parse(txt) } catch {}
      const det = j?.detail || j || {}
      st = { ...det, require_payment: true }
      ok = false
    } else if (r.status === 401 || r.status === 403) {
      // Não autenticado na instância -> bloquear conversas
      ok = false
      st = { require_payment: true }
    } else {
      // Falha transitória: não bloquear
      ok = true
    }
  } catch (e) {
    console.error("[billing] erro ao consultar status da instância:", e)
    ok = true // não bloquear por falha temporária
  }

  // 2) Atualiza variáveis globais/visuais
  window.__BILLING_KEY__ = key || window.__BILLING_KEY__
  billingStatus = st
  window.__USER_EMAIL__ = userEmail() || window.__USER_EMAIL__ || ""

  // Mostrar/ocultar modal conforme necessário
  try {
    const appVisible = !!document.getElementById("app-view") && !document.getElementById("app-view").classList.contains("hidden")
    const billingVisible = !!document.getElementById("billing-view") && !document.getElementById("billing-view").classList.contains("hidden")
    if (!ok && allowModal && appVisible && !billingVisible) showBillingModal()
  } catch {}

  updateBillingView()
  return ok
}
function showBillingModal() { $("#billing-modal")?.classList.remove("hidden") }
function hideBillingModal() { $("#billing-modal")?.classList.add("hidden") }
function showBillingModal() { $("#billing-modal")?.classList.remove("hidden") }
function hideBillingModal() { $("#billing-modal")?.classList.add("hidden") }

function updateBillingView() {
  if (!billingStatus) return
  const currentPlan = $("#current-plan")
  const daysRemaining = $("#days-remaining")
  const trialUntil = $("#trial-until")
  const paidUntil = $("#paid-until")

  // 👉 Detecta vitalício (plano pago sem expiração)
  const vital = !!billingStatus.vitalicio ||
                ((billingStatus.last_payment_status||'').toLowerCase()==='paid' && !billingStatus.paid_until)

  if (vital) {
    if (currentPlan) {
      const planName = (billingStatus.plan || "").toLowerCase()
      currentPlan.textContent = planName === "vitalicio" ? "Luna IA Professional" : billingStatus.plan || "Plano ativo"
    }

    // 🔥 Esconde completamente as linhas
    if (daysRemaining) daysRemaining.parentElement.style.display = "none"
    if (trialUntil) trialUntil.parentElement.style.display = "none"
    if (paidUntil) paidUntil.parentElement.style.display = "none"

    // desabilita botão de assinar
    const btn = $("#btn-pay-stripe")
    if (btn) { 
      btn.disabled = true
      btn.classList.add("disabled")
      btn.textContent = "Plano ativo"
    }
    return
  }

  // Default (trial/pago com data de expiração)
  if (currentPlan) currentPlan.textContent = billingStatus.plan || "Trial"

  if (daysRemaining) {
    daysRemaining.parentElement.style.display = ""
    daysRemaining.textContent = String(billingStatus.days_left ?? "0")
  }
  if (trialUntil) {
    trialUntil.parentElement.style.display = ""
    trialUntil.textContent = billingStatus.trial_ends_at ? new Date(billingStatus.trial_ends_at).toLocaleString() : "N/A"
  }
  if (paidUntil) {
    paidUntil.parentElement.style.display = ""
    paidUntil.textContent = billingStatus.paid_until ? new Date(billingStatus.paid_until).toLocaleString() : "N/A"
  }
}



/* >>> NOVO: helper robusto de checkout (API -> Stripe) */
async function goToStripeCheckout({ plan = "luna_base", tenant_key = "", email = "" } = {}) {
  const params = new URLSearchParams({ plan })
  if (tenant_key) params.set("tenant_key", tenant_key)
  if (email) params.set("email", email)

  try {
    const r = await fetch(BACKEND() + "/api/pay/stripe/checkout-url?" + params.toString(), {
      method: "GET",
      credentials: "include",
      headers: { ...authHeaders() }
    })
    if (!r.ok) throw new Error(await r.text().catch(() => ""))
    const data = await r.json().catch(() => ({}))
    if (data && data.url) {
      window.location.href = data.url
      return
    }
    throw new Error("Resposta inválida da API de pagamentos.")
  } catch (err) {
    console.error("[stripe] erro ao iniciar pagamento:", err)
    alert("Erro ao iniciar pagamento. Tente novamente em instantes.")
  }
}

async function createCheckoutLink() {
  try {
    // Garante que o billing_key está carregado
    try { await checkBillingStatus({ allowModal: false }) } catch (e) { console.warn(e) }
    const plan = "luna_base";
    const tk   = (window.__BILLING_KEY__ || "").toString();
    const em   = (window.__USER_EMAIL__  || userEmail() || "").toString();
    await goToStripeCheckout({ plan, tenant_key: tk, email: em })
  } catch (e) {
    console.error("[stripe] Failed to init checkout:", e);
    alert("Erro ao processar pagamento. Tente novamente.");
  }
}


/* ========= UTIL: IP + ID aleatório ========= */
function randId(n = 8) {
  try {
    const bytes = new Uint8Array(n)
    crypto.getRandomValues(bytes)
    return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, n)
  } catch {
    return Math.random().toString(16).slice(2, 2 + n)
  }
}
async function resolveClientIP() {
  const candidates = ["/api/client-ip", "/api/utils/client-ip", "/client-ip", "/ip"]
  for (const p of candidates) {
    try {
      const r = await fetch(BACKEND() + p, { headers: { ...authHeaders() } })
      if (!r.ok) continue
      const j = await r.json().catch(() => ({}))
      // aceita {ip:"1.2.3.4"} ou {client_ip:"1.2.3.4"} ou string
      const ip = j.ip || j.client_ip || (typeof j === "string" ? j : "")
      if (ip && typeof ip === "string" && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip
    } catch {}
  }
  return null
}

/* ========= PAGAMENTO COM CARTÃO ========= */

// Abre o modal de pagamento para coletar dados do cartão
function showCardModal() {
  const modal = document.getElementById("card-modal")
  if (modal) {
    modal.classList.remove("hidden")
    const payload = jwtPayload() || {}
    const emailInput = document.getElementById("card-email")
    if (emailInput && !emailInput.value) emailInput.value = payload.email || payload.sub || ""
    const nameInput = document.getElementById("card-name")
    if (nameInput && !nameInput.value) nameInput.value = payload.name || ""
    const err = document.getElementById("card-error"); if (err) err.textContent = ""
  }
}
// expõe para o HTML (botão da tela de Pagamentos)
window.showCardModal = showCardModal

// Exponha helpers de checkout para que o HTML (index.html) possa chamá‑los diretamente.
window.goToStripeCheckout = goToStripeCheckout;
window.createCheckoutLink = createCheckoutLink;

// Fecha o modal de pagamento
function hideCardModal() { document.getElementById("card-modal")?.classList.add("hidden") }

/* ---------- helpers de erro Getnet ---------- */
function extractGetnetErrorDetail(obj) {
  const e = obj?.payment?.error || obj?.error || {}
  const msg = e.message || obj?.status_details || obj?.message || ""
  const desc = Array.isArray(e.details) && e.details[0]?.description ? e.details[0].description : ""
  const code = e.status_code || e.code || ""
  return [msg, desc, code].filter(Boolean).join(" | ")
}

// Handler para submissão do formulário de pagamento (ÚNICO FLUXO ATIVO)
async function submitCardPayment(event) {
  event.preventDefault()
  const submitBtn = document.getElementById("btn-card-submit")
  const errorEl = document.getElementById("card-error")
  if (errorEl) errorEl.textContent = ""
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Processando..." }

  try {
    // Coleta dados do formulário
    const name = document.getElementById("card-name").value.trim()
    const email = document.getElementById("card-email").value.trim()
    const documentNumberRaw = document.getElementById("card-document").value.trim()
    const phoneRaw = document.getElementById("card-phone").value.trim()

    // Endereço de cobrança (antifraude) — IDs REAIS DO HTML (bill-*)
    const addrStreet = document.getElementById("bill-street")?.value.trim() || ""
    const addrNumber = document.getElementById("bill-number")?.value.trim() || ""
    const addrComplement = document.getElementById("bill-complement")?.value.trim() || ""
    const addrDistrict = document.getElementById("bill-district")?.value.trim() || ""
    const addrCity = document.getElementById("bill-city")?.value.trim() || ""
    const addrState = (document.getElementById("bill-state")?.value.trim() || "").toUpperCase()
    const addrCountry = (document.getElementById("bill-country")?.value.trim() || "BR").toUpperCase() === "BRASIL" ? "BR" : (document.getElementById("bill-country")?.value.trim() || "BR").toUpperCase()
    const addrPostalRaw = document.getElementById("bill-postal")?.value.trim() || ""

    const cardholderName = document.getElementById("cardholder-name").value.trim().toUpperCase()
    const cardNumberRaw = document.getElementById("card-number").value
    const expMonthRaw = document.getElementById("card-exp-month").value.trim()
    const expYearRaw = document.getElementById("card-exp-year").value.trim()
    const securityCodeRaw = document.getElementById("card-cvv").value.trim()
    const selectedBrand = document.getElementById("card-brand").value
    const cardType = (document.getElementById("card-type")?.value || "credit").toLowerCase()

    // ===== Validações obrigatórias =====
    if (!name || !email || !cardholderName || !cardNumberRaw || !expMonthRaw || !expYearRaw || !securityCodeRaw || !selectedBrand || !cardType) {
      throw new Error("Preencha todos os campos obrigatórios.")
    }

    // CPF/CNPJ obrigatório (GetNet)
    const documentNumber = digitsOnly(documentNumberRaw)
    if (!documentNumber) throw new Error("Informe CPF/CNPJ.")

    // Telefone em dígitos (10–11). Obrigatório no débito.
    const phoneDigits = phoneDigitsBR(phoneRaw)
    if (cardType === "debit" && (phoneDigits.length < 10 || phoneDigits.length > 11)) {
      throw new Error("Telefone inválido. Informe DDD+telefone (10 a 11 dígitos).")
    }

    // Endereço de cobrança — obrigatório para antifraude
    const postal = digitsOnly(addrPostalRaw)
    if (!addrStreet || !addrNumber || !addrDistrict || !addrCity || !addrState || addrState.length !== 2 || !postal || postal.length !== 8) {
      throw new Error("Endereço de cobrança inválido. Preencha rua, número, bairro, cidade, UF (2 letras) e CEP (8 dígitos).")
    }

    // Sanitização de cartão e validade
    const cardNumber = digitsOnly(cardNumberRaw)
    const expMonth = pad2(expMonthRaw)
    const expYear = toYYYY(expYearRaw) // AAAA
    const securityCode = digitsOnly(securityCodeRaw)

    // Nome do titular: sanitiza e valida (máx. 26)
    const chName = sanitizeCardholderName(cardholderName)
    if (!chName || chName.split(" ").length < 2) {
      throw new Error("Nome do titular inválido. Digite como impresso no cartão (apenas letras e espaços).")
    }
    if (chName.length > 26) {
      throw new Error("Nome do titular muito longo (máx. 26 caracteres). Use como impresso no cartão.")
    }

    // Ano de expiração em 2 dígitos (YY) para /v1/cards
    const expYear2 = String(expYear).slice(-2)

    // Normalização/validação de bandeira + CVV
    const brand = normalizeBrand(selectedBrand, cardNumber)
    const brandLC = brand.toLowerCase()
    const isAmex = brand === "Amex"
    if ((isAmex && securityCode.length !== 4) || (!isAmex && securityCode.length !== 3)) {
      throw new Error(isAmex ? "CVV inválido (Amex exige 4 dígitos)." : "CVV inválido (3 dígitos).")
    }

    // === Integração de assinatura recorrente com a API da GetNet ===
    const baseURL = "https://api.getnet.com.br"
    const clientId = window.__GETNET_CLIENT_ID__
    const clientSecret = window.__GETNET_CLIENT_SECRET__
    const sellerId = window.__GETNET_SELLER_ID__
    if (!clientId || !clientSecret || !sellerId) {
      throw new Error("Credenciais da GetNet não configuradas.")
    }

    // Para assinaturas, somente o cartão de crédito é permitido
    if (cardType === "debit") {
      throw new Error("Assinaturas recorrentes só são suportadas com cartão de crédito.")
    }

    // 1) Obtenção de token OAuth2
    const authResp = await fetch(`${baseURL}/auth/oauth/v2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: "oob" }).toString(),
    })
    if (!authResp.ok) {
      const errMsg = await authResp.text().catch(() => authResp.status)
      throw new Error(`Erro ao obter token: ${errMsg}`)
    }
    const authJson = await authResp.json()
    const accessToken = authJson.access_token
    if (!accessToken) {
      throw new Error("Token de acesso não recebido.")
    }

    // 2) Tokenização do cartão (PAN -> number_token)
    const tokenizationResp = await fetch(`${baseURL}/v1/tokens/card`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ card_number: cardNumber, customer_id: email }),
    })
    if (!tokenizationResp.ok) {
      const errMsg = await tokenizationResp.text().catch(() => tokenizationResp.status)
      throw new Error(`Erro ao tokenizar cartão: ${errMsg}`)
    }
    const tokenizationJson = await tokenizationResp.json()
    const numberToken = tokenizationJson.number_token || tokenizationJson.numberToken
    if (!numberToken) {
      throw new Error("Número token do cartão não retornado.")
    }

    // 2.1) (Opcional) Verificação de cartão
    try {
      if (window.__GETNET_VERIFY_CARD__ === true) {
        const verifyResp = await fetch(`${baseURL}/v1/cards/verification`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            Authorization: `Bearer ${accessToken}`,
            seller_id: sellerId,
          },
          body: JSON.stringify({
            number_token: numberToken,
            brand: brandLC,
            cardholder_name: chName,
            expiration_month: expMonth,
            expiration_year: expYear2,
            security_code: securityCode
          })
        })
        const vj = await verifyResp.json().catch(() => ({}))
        if (!verifyResp.ok || String(vj.status || "").toUpperCase() !== "VERIFIED") {
          console.warn("[getnet] Verificação de cartão não aprovada:", vj)
        }
      }
    } catch (e) {
      console.warn("[getnet] Falha na verificação de cartão (ignorada em homologação):", e)
    }

    // 3) Cria/atualiza cliente (assinante)
    const { first_name, last_name } = splitName(name)
    const customerPayload = {
      seller_id: sellerId,
      customer_id: email,
      first_name,
      last_name,
      name,
      email,
      document_type: documentNumber.length > 11 ? "CNPJ" : "CPF",
      document_number: documentNumber,
      phone_number: phoneDigits || "",
      billing_address: {
        street: addrStreet,
        number: addrNumber,
        complement: addrComplement,
        district: addrDistrict,
        city: addrCity,
        state: addrState,
        country: addrCountry, // deve ser "BR"
        postal_code: postal,
      },
    }

    const customerResp = await fetch(`${baseURL}/v1/customers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        seller_id: sellerId,
      },
      body: JSON.stringify(customerPayload),
    })

    if (!customerResp.ok) {
      // fallback para atualizar cliente já existente (409 etc.)
      const txt = await customerResp.text().catch(() => "")
      if (customerResp.status === 409 || /already exists|duplicate/i.test(txt)) {
        try {
          const putResp = await fetch(`${baseURL}/v1/customers/${encodeURIComponent(email)}`, {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${accessToken}`,
              seller_id: sellerId,
            },
            body: JSON.stringify(customerPayload),
          })
          if (!putResp.ok) throw new Error(await putResp.text())
        } catch (ee) {
          throw new Error(`Erro ao cadastrar cliente: ${txt || ee?.message || customerResp.status}`)
        }
      } else {
        throw new Error(`Erro ao cadastrar cliente: ${txt || customerResp.status}`)
      }
    }
    const customerJson = await customerResp.json().catch(() => ({}))
    const customerId = customerJson.customer_id || email

    // 4) Salva cartão no cofre (SEM verificar aqui; SEM brand/CVV)
    const cardPayload = {
      number_token: numberToken,
      expiration_month: expMonth,
      expiration_year: expYear2,  // YY
      customer_id: customerId,
      cardholder_name: chName,
      cardholder_identification: documentNumber
    }
    const cardResp = await fetch(`${baseURL}/v1/cards`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
        "seller_id": sellerId,
      },
      body: JSON.stringify(cardPayload),
    })
    if (!cardResp.ok) {
      const errMsg = await cardResp.text().catch(() => cardResp.status)
      throw new Error(`Erro ao salvar cartão: ${errMsg}`)
    }
    const cardJson = await cardResp.json().catch(() => ({}))
    const cardId = cardJson.card_id || cardJson.number_token || numberToken

    // 5) Plano de assinatura
    const amountCents = Number(window.__GETNET_AMOUNT_CENTS__ || 1000) // R$10,00 padrão
    let planId = (window.__GETNET_PLAN_ID__ || "").trim()
    if (!planId) {
      const planPayload = {
        seller_id: sellerId,
        name: "Plano Luna AI Professional",
        description: "Assinatura mensal do Luna AI",
        amount: amountCents,
        currency: "BRL",
        payment_types: ["credit_card"],
        sales_tax: 0,
        product_type: "service",
        period: { type: "monthly", billing_cycle: 30, specific_cycle_in_days: 0 }
      }
      const planResp = await fetch(`${baseURL}/v1/plans`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`,
          "seller_id": sellerId,
        },
        body: JSON.stringify(planPayload),
      })
      if (!planResp.ok) {
        const errMsg = await planResp.text().catch(() => planResp.status)
        throw new Error(`Erro ao criar plano: ${errMsg}`)
      }
      const planJson = await planResp.json().catch(() => ({}))
      planId = planJson.plan_id
      if (!planId) throw new Error("Plano de assinatura não retornou plan_id.")
    }

    // 6) Cria assinatura
    const orderId = `order_${Date.now()}`
    const softDescriptorRaw = (window.__GETNET_SOFT_DESCRIPTOR__ || "").trim()
    const softDescriptor = softDescriptorRaw ? softDescriptorRaw.slice(0, 13) : null // alguns emissores limitam 13

    const credit = {
      transaction_type: "FULL",
      number_installments: 1,
      billing_address: {
        street: addrStreet,
        number: addrNumber,
        complement: addrComplement,
        district: addrDistrict,
        city: addrCity,
        state: addrState,
        country: addrCountry,
        postal_code: postal
      },
      card: {
        card_id: cardId,
        cardholder_name: chName,
        security_code: securityCode,
        brand: brandLC,
        expiration_month: expMonth,
        expiration_year: expYear2
      }
    }
    if (softDescriptor) credit.soft_descriptor = softDescriptor

    const subscriptionPayload = {
      seller_id: sellerId,
      customer_id: customerId,
      plan_id: planId,
      order_id: orderId,
      subscription: { payment_type: { credit } }
      // device será adicionado abaixo apenas se houver IP público
    }

    // ➜ Enviar device **apenas** se houver IP público real
    try {
      const ip = await resolveClientIP()
      if (ip) {
        subscriptionPayload.device = {
          ip_address: ip,
          device_id: `web-${randId(10)}`
        }
      }
    } catch { /* se não conseguir IP, não envia device */ }

    const subscriptionResp = await fetch(`${baseURL}/v1/subscriptions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
        "seller_id": sellerId,
      },
      body: JSON.stringify(subscriptionPayload),
    })
    const subscriptionText = await subscriptionResp.text().catch(() => "")
    let subscriptionJson = {}
    try { subscriptionJson = subscriptionText ? JSON.parse(subscriptionText) : {} } catch {}

    if (!subscriptionResp.ok) {
      const detail = extractGetnetErrorDetail(subscriptionJson) || subscriptionText || subscriptionResp.status
      throw new Error(`Erro ao criar assinatura: ${detail}`)
    }

    // Checagem de erro antifraude mesmo com 200
    const overall = String(subscriptionJson.status || "").toLowerCase() // "failed" em casos 481
    const paymentError = subscriptionJson?.payment?.error
    if (overall === "failed" || paymentError) {
      const detail = extractGetnetErrorDetail(subscriptionJson) || "Transação negada."
      throw new Error(detail)
    }

    const subStatus = String(subscriptionJson.status || "").toLowerCase()

    if (subStatus.includes("active")) {
      hideCardModal()
      alert("Assinatura criada e ativa! Você será cobrado mensalmente.")
    } else {
      // Em alguns fluxos, a assinatura fica 'pending' até captura/autorização.
      hideCardModal()
      alert("Assinatura criada. Aguarde confirmação da Getnet.")
    }
  } catch (err) {
    console.error("[payments] Falha ao processar pagamento:", err)
    const errorEl = document.getElementById("card-error")
    if (errorEl) {
      errorEl.textContent = (err?.message || "Erro desconhecido")
    } else {
      alert(err?.message || "Erro desconhecido")
    }
  } finally {
    const submitBtn = document.getElementById("btn-card-submit")
    if (submitBtn) {
      submitBtn.disabled = false
      submitBtn.textContent = "Pagar"
    }
  }
}

/* ====== Roteador simples + FAB Mobile (NOVO) ====== */
function getViewFromURL() {
  const url = new URL(window.location.href)
  const qp = (url.searchParams.get("view") || "").toLowerCase()
  const hash = (url.hash || "").replace(/^#/, "").toLowerCase()
  const hinted = qp || hash
  if (hinted === "billing" || hinted === "pagamentos") return "billing"
  if (hinted === "conversas" || hinted === "chat" || hinted === "geral") return "conversas"
  return ""
}
function setViewInURL(view, replace = false) {
  try {
    const url = new URL(window.location.href)
    const target = String(view || "").toLowerCase()
    const curView = (url.searchParams.get("view") || "").toLowerCase()
    const same = curView === target
    url.searchParams.set("view", target)
    url.hash = target === "billing" ? "#billing" : ""
    const stateObj = { view: target }
    if (replace || same) history.replaceState(stateObj, "", url)
    else history.pushState(stateObj, "", url)
  } catch {}
}

// FAB Mobile para abrir Pagamentos (aparece só se não houver a barra mobile de navegação)
function ensureMobilePayFAB() {
  if (!isMobile()) return
  if (document.getElementById("mobile-pay-fab")) return
  if (document.getElementById("btn-mobile-pagamentos")) return // já existe menu mobile

  const fab = document.createElement("button")
  fab.id = "mobile-pay-fab"
  fab.type = "button"
  fab.textContent = "Pagamentos"
  fab.style.position = "fixed"
  fab.style.right = "16px"
  fab.style.bottom = "16px"
  fab.style.zIndex = "1000"
  fab.style.padding = "12px 16px"
  fab.style.border = "none"
  fab.style.borderRadius = "999px"
  fab.style.boxShadow = "0 6px 16px rgba(0,0,0,.2)"
  fab.style.background = "var(--accent, #6C5CE7)"
  fab.style.color = "#fff"
  fab.style.fontWeight = "600"
  fab.style.cursor = "pointer"
  fab.onclick = () => { showBillingView() }
  document.body.appendChild(fab)
}
function toggleMobilePayFAB(showFab) {
  const el = document.getElementById("mobile-pay-fab")
  if (!el) return
  el.style.display = showFab ? "inline-flex" : "none"
}

// Hook de navegação
function handleRoute() {
  const want = getViewFromURL()
  const hasAcct = !!acctJwt()
  const hasInst = !!jwt()

  if (!hasAcct || !hasInst) {
    // A tela de login fica com steps; somente sincronizamos o passo.
    show("#login-view"); hide("#app-view")
    if (!hasAcct) { showStepAccount(); return }
    if (!hasInst) { showStepInstance(); return }
  }

  // Já autenticado → app
  hide("#login-view"); show("#app-view")
  if (want === "billing") {
    showBillingView()
  } else {
    showConversasView()
  }
}

/* ========= Views (sincronizam URL + FAB) ========= */
function markActiveMenus(view) {
  document.querySelectorAll(".menu-item").forEach((i) => i.classList.remove("active"))
  if (view === "billing") {
    $("#btn-pagamentos")?.classList.add("active")
    $("#btn-mobile-pagamentos")?.classList.add("active")
  } else {
    $("#btn-conversas")?.classList.add("active")
    $("#btn-mobile-conversas")?.classList.add("active")
  }
}

async function showConversasView() {
  // Antes de exibir as conversas, checamos o status de billing.
  try {
    const ok = await checkBillingStatus({ allowModal: false })
    if (!ok) {
      showBillingView()
      return
    }
  } catch (e) {
    console.error(e)
    // Em caso de erro inesperado, não bloqueamos o acesso, apenas logamos
  }

  // **FIX MOBILE:** Conversas devem abrir a LISTA no mobile
  setMobileMode("list")

  // Classes no body para CSS responsivo
  document.body.classList.add("mode-chat")
  document.body.classList.remove("mode-billing")

  // Elementos visuais
  hide("#billing-view")
  show(".chatbar")
  show("#messages")
  show(".sidebar") // <- garante a sidebar no mobile

  markActiveMenus("chat")
  setViewInURL("conversas", true)
  toggleMobilePayFAB(true)
}

function showBillingView() {
  // **FIX MOBILE:** Forçar o MAIN visível no mobile (onde fica #billing-view)
  setMobileMode("chat")

  // Classes no body para CSS responsivo
  document.body.classList.add("mode-billing")
  document.body.classList.remove("mode-chat")

  // Elementos visuais
  hide(".chatbar")
  hide("#messages")
  show("#billing-view")
  if (isMobile()) hide(".sidebar"); else show(".sidebar") // <- mobile: sem sidebar

  markActiveMenus("billing")
  setViewInURL("billing")
  // 👇 não reabrir modal enquanto o usuário está na tela de pagamentos
  checkBillingStatus({ allowModal: false })
  toggleMobilePayFAB(false)
}

/* =========================================
 * 2) STATE GLOBAL + ORDENAÇÃO POR RECÊNCIA
 * ======================================= */
const state = {
  chats: [], current: null, lastMsg: new Map(), lastMsgFromMe: new Map(),
  nameCache: new Map(), unread: new Map(), loadingChats: false, stages: new Map(),
  splash: { shown: false, timer: null, forceTimer: null }, activeTab: "geral",
  listReqId: 0, lastTs: new Map(), orderDirty: false,
}
function toMs(x) { const n = Number(x || 0); if (String(x).length === 10) return n * 1000; return isNaN(n) ? 0 : n }
function updateLastActivity(chatid, ts) {
  if (!chatid) return
  const cur = state.lastTs.get(chatid) || 0
  const val = toMs(ts)
  if (val > cur) { state.lastTs.set(chatid, val); state.orderDirty = true; scheduleReorder() }
}
let reorderTimer = null
function scheduleReorder() {
  if (reorderTimer) return
  reorderTimer = setTimeout(() => { reorderTimer = null; if (!state.orderDirty) return; state.orderDirty = false; reorderChatList() }, 60)
}
function reorderChatList() {
  const list = document.getElementById("chat-list"); if (!list) return
  const cards = Array.from(list.querySelectorAll(".chat-item")); if (!cards.length) return
  cards.sort((a, b) => (state.lastTs.get(b.dataset.chatid) || 0) - (state.lastTs.get(a.dataset.chatid) || 0))
  cards.forEach((el) => list.appendChild(el))
}

/* =========================================
 * 3) FILA GLOBAL DE BACKGROUND
 * ======================================= */
const bgQueue = []; let bgRunning = false
function pushBg(task) { bgQueue.push(task); if (!bgRunning) runBg() }
async function runBg() {
  bgRunning = true
  while (bgQueue.length) { const batch = bgQueue.splice(0, 16); await runLimited(batch, 8); await new Promise((r) => rIC(r)) }
  bgRunning = false
}

/* =========================================
 * 4) PIPE DE STAGES + BULK + RESERVA
 * ======================================= */
const STAGES = ["contatos", "lead", "lead_quente"]
const STAGE_LABEL = { contatos: "Contatos", lead: "Lead", lead_quente: "Lead Quente" }
function normalizeStage(s) {
  const k = String(s || "").toLowerCase().trim()
  if (k.startsWith("contato")) return "contatos"
  if (k.includes("lead_quente") || k.includes("quente")) return "lead_quente"
  if (k === "lead") return "lead"
  return "contatos"
}
function getStage(chatid) { return state.stages.get(chatid) || null }
function setStage(chatid, nextStage) { const stage = normalizeStage(nextStage); const rec = { stage, at: Date.now() }; state.stages.set(chatid, rec); return rec }

// ------- chamadas compat de endpoints -------
async function callLeadStatusEndpointsBulk(ids) {
  const attempts = [
    { path: "/api/lead-status/bulk", method: "POST", body: { chatids: ids } },
    { path: "/api/lead_status/bulk", method: "POST", body: { chatids: ids } },
    { path: "/api/lead-status/bulk", method: "POST", body: { ids } },
    { path: "/api/lead_status/bulk", method: "POST", body: { ids } },
  ]
  for (const a of attempts) {
    try {
      const res = await api(a.path, { method: a.method, body: JSON.stringify(a.body) })
      if (res && (Array.isArray(res.items) || Array.isArray(res.data))) {
        const arr = Array.isArray(res.items) ? res.items : res.data
        return arr.map((it) => ({ chatid: it.chatid || it.id || it.number || it.chatId || "", stage: it.stage || it.status || it._stage || "" }))
      }
    } catch {}
  }
  return null
}
async function callLeadStatusSingle(chatid) {
  const attempts = [
    { path: "/api/lead-status", method: "POST", body: { chatid } },
    { path: "/api/lead_status", method: "POST", body: { chatid } },
    { path: `/api/lead-status?chatid=${encodeURIComponent(chatid)}`, method: "GET" },
    { path: `/api/lead_status?chatid=${encodeURIComponent(chatid)}`, method: "GET" },
  ]
  for (const a of attempts) {
    try {
      const res = await api(a.path, a.method === "GET" ? {} : { method: a.method, body: JSON.stringify(a.body) })
      const st = normalizeStage(res?.stage || res?.status || res?._stage || "")
      if (st) return { chatid, stage: st }
    } catch {}
  }
  return null
}

// ------- Bulk seed de estágios do banco -------
const _stageBuffer = new Set()
let _stageTimer = null
async function fetchStageNow(chatid) {
  if (!chatid) return
  try {
    const bulkOne = await callLeadStatusEndpointsBulk([chatid])
    let rec = bulkOne?.find((x) => (x.chatid || "") === chatid) || null
    if (!rec) rec = await callLeadStatusSingle(chatid)
    const st = normalizeStage(rec?.stage || "")
    if (st) {
      setStage(chatid, st)
      rIC(refreshStageCounters)
      const cur = state.current
      if (cur && (cur.wa_chatid || cur.chatid) === chatid) upsertStagePill(st)
    }
  } catch (e) { console.warn("fetchStageNow falhou:", e) }
}
function queueStageLookup(chatid) {
  if (!chatid || state.stages.has(chatid)) return
  _stageBuffer.add(chatid)
  if (_stageBuffer.size >= 12) { flushStageLookup() }
  else { if (_stageTimer) clearTimeout(_stageTimer); _stageTimer = setTimeout(flushStageLookup, 250) }
}
async function flushStageLookup() {
  const ids = Array.from(_stageBuffer); _stageBuffer.clear()
  if (_stageTimer) { clearTimeout(_stageTimer); _stageTimer = null }
  if (!ids.length) return
  try {
    const arr = await callLeadStatusEndpointsBulk(ids)
    const seen = new Set()
    if (Array.isArray(arr)) {
      for (const rec of arr) {
        const cid = rec?.chatid || ""; const st = normalizeStage(rec?.stage || "")
        if (!cid || !st) continue; setStage(cid, st); seen.add(cid)
      }
    }
    await runLimited(ids.filter((id) => !seen.has(id)).map((id) => async () => { await fetchStageNow(id) }), 6)
    rIC(refreshStageCounters)
    if (state.activeTab !== "geral") { const tab = state.activeTab; rIC(() => loadStageTab(tab)) }
  } catch (e) {
    console.error("lead-status bulk compat falhou:", e)
    await runLimited(ids.map((id) => async () => { await fetchStageNow(id) }), 6)
  }
}

/* =========================================
 * 5) CRM
 * ======================================= */
const CRM_STAGES = ["novo", "sem_resposta", "interessado", "em_negociacao", "fechou", "descartado"]

// >>> CORRIGIDO: tenta várias rotas/métodos + fallback local se nada responder
async function apiCRMViews() {
  // Normaliza possíveis formatos de resposta em { counts: {...} }
  const toCounts = (data) => {
    if (!data || typeof data !== "object") return null
    if (data.counts && typeof data.counts === "object") return data.counts
    if (data.data && data.data.counts && typeof data.data.counts === "object") return data.data.counts

    const fromArray = (arr) => {
      if (!Array.isArray(arr)) return null
      const out = {}
      for (const it of arr) {
        const key = String(it?.stage ?? it?.status ?? it?.name ?? it?.key ?? "")
          .toLowerCase()
          .replace(/\s+/g, "_")
          .trim()
        const val = Number(it?.count ?? it?.total ?? it?.value ?? it?.qty ?? 0)
        if (key) out[key] = (out[key] || 0) + (isFinite(val) ? val : 0)
      }
      return Object.keys(out).length ? out : null
    }

    return (
      toCounts(data.result) ||
      toCounts(data.summary) ||
      fromArray(data.items) ||
      fromArray(data.data) ||
      null
    )
  }

  // Tenta endpoints comuns (com e sem /api, com/sem barra final) e GET/POST
  const endpoints = [
    ["/api/crm/views", "POST"], ["/api/crm/views", "GET"],
    ["/api/crm/views/", "POST"], ["/api/crm/views/", "GET"],
    ["/api/crm/counters", "GET"], ["/api/crm/counters", "POST"],
    ["/api/crm/overview", "GET"], ["/api/crm/overview/", "GET"],
    ["/api/crm/summary", "GET"], ["/api/crm/summary/", "GET"],
    ["/api/crm", "GET"], ["/api/crm/", "GET"],
    ["/crm/views", "GET"], ["/crm/views/", "GET"],
    ["/crm/counters", "GET"], ["/crm/counters/", "GET"],
  ]

  for (const [path, method] of endpoints) {
    try {
      const opts = method === "POST" ? { method, body: "{}" } : { method }
      const data = await api(path, { ...opts, headers: { Accept: "application/json" } })
      const counts = toCounts(data)
      if (counts) return { counts }
    } catch {}
  }

  // Fallback local: estima contadores a partir dos estágios já carregados no front
  try {
    const counts = { novo: 0, sem_resposta: 0, interessado: 0, em_negociacao: 0, fechou: 0, descartado: 0 }
    for (const [, rec] of (state?.stages || new Map()).entries()) {
      const st = (rec?.stage || "").toLowerCase()
      if (st === "contatos") counts.novo++
      else if (st === "lead") counts.interessado++
      else if (st === "lead_quente") counts.em_negociacao++
    }
    console.warn("[crm] counters via fallback local (nenhum endpoint compatível encontrado).")
    return { counts }
  } catch (e) {
    console.warn("[crm] falha ao obter counters (sem endpoint compatível):", e?.message || e)
    return { counts: {} }
  }
}
// <<<

async function apiCRMList(stage, limit = 100, offset = 0) {
  const qs = new URLSearchParams({ stage, limit, offset }).toString()
  return api("/api/crm/list?" + qs)
}
async function apiCRMSetStatus(chatid, stage, notes = "") {
  return api("/api/crm/status", { method: "POST", body: JSON.stringify({ chatid, stage, notes }) })
}
function ensureCRMBar() {}
async function refreshCRMCounters() {
  try {
    const data = await apiCRMViews()
    const counts = data?.counts || {}
    const el = document.querySelector(".crm-counters")
    if (el) { const parts = CRM_STAGES.map((s) => `${s.replace("_", " ")}: ${counts[s] || 0}`); el.textContent = parts.join(" • ") }
  } catch {}
}
async function loadCRMStage(stage) {
  const list = $("#chat-list"); list.innerHTML = "<div class='hint'>Carregando visão CRM...</div>"
  try {
    const data = await apiCRMList(stage, 100, 0)
    const items = []
    for (const it of (data?.items || [])) {
      const ch = it.chat || {}; if (!ch.wa_chatid && it.crm?.chatid) ch.wa_chatid = it.crm.chatid; items.push(ch)
    }
    await progressiveRenderChats(items); await prefetchCards(items)
  } catch (e) { list.innerHTML = `<div class='error'>Falha ao carregar CRM: ${escapeHtml(e.message || "")}</div>` }
  finally { refreshCRMCounters() }
}
function attachCRMControlsToCard(el, ch) {}

// Etapas de login
function showStepAccount() { hide("#step-instance"); hide("#step-register"); show("#step-account") }
function showStepInstance() { hide("#step-account"); hide("#step-register"); show("#step-instance") }
function showStepRegister() { hide("#step-account"); hide("#step-instance"); show("#step-register") }

// Login por e-mail/senha
async function acctLogin() {
  const email = $("#acct-email")?.value?.trim()
  const pass = $("#acct-pass")?.value?.trim()
  const msgEl = $("#acct-msg"); const btnEl = $("#btn-acct-login")
  if (!email || !pass) { if (msgEl) msgEl.textContent = "Informe e-mail e senha."; return }
  try {
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = "Entrando..." }
    if (msgEl) msgEl.textContent = ""
    const r = await fetch(BACKEND() + "/api/users/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: pass }) })
    if (!r.ok) throw new Error(await r.text())
    const data = await r.json(); if (!data?.jwt) throw new Error("Resposta inválida do servidor.")
    localStorage.setItem(ACCT_JWT_KEY, data.jwt)
    try { await registerTrialUser() } catch (e) { console.error(e) } // <-- não verifica billing aqui
    showStepInstance(); $("#token")?.focus()
  } catch (e) { if (msgEl) msgEl.textContent = e?.message || "Falha no login." }
  finally { if (btnEl) { btnEl.disabled = false; btnEl.textContent = "Entrar" } }
}

// Registro
async function acctRegister() {
  const email = $("#reg-email")?.value?.trim()
  const pass = $("#reg-pass")?.value?.trim()
  const msgEl = $("#reg-msg"); const btnEl = $("#btn-acct-register")
  if (!email || !pass) { if (msgEl) msgEl.textContent = "Informe e-mail e senha."; return }
  try {
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = "Criando..." }
    if (msgEl) msgEl.textContent = ""
    const r = await fetch(BACKEND() + "/api/users/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: pass }) })
    if (!r.ok) throw new Error(await r.text())
    const data = await r.json(); if (!data?.jwt) throw new Error("Resposta inválida do servidor.")
    localStorage.setItem(ACCT_JWT_KEY, data.jwt)
    try { await registerTrialUser() } catch (e) { console.error(e) } // <-- não verifica billing aqui
    showStepInstance(); $("#token")?.focus()
  } catch (e) { if (msgEl) msgEl.textContent = e?.message || "Falha no registro." }
  finally { if (btnEl) { btnEl.disabled = false; btnEl.textContent = "Criar Conta" } }
}

/* =========================================
 * 6) SPLASH / LOGIN / ROUTER
 * ======================================= */
function createSplash() {
  if (state.splash.shown) return
  const el = document.createElement("div"); el.id = "luna-splash"; el.className = "splash-screen"
  const logoContainer = document.createElement("div"); logoContainer.className = "splash-logos-container"
  const lunaLogoDiv = document.createElement("div"); lunaLogoDiv.className = "splash-logo-luna active"
  const lunaLogo = document.createElement("img"); lunaLogo.src = "lunapngcinza.png"; lunaLogo.alt = "Luna"; lunaLogo.className = "splash-logo"; lunaLogoDiv.appendChild(lunaLogo)
  const helseniaLogoDiv = document.createElement("div"); helseniaLogoDiv.className = "splash-logo-helsenia"
  const helseniaLogo = document.createElement("img"); helseniaLogo.src = "logohelsenia.png"; helseniaLogo.alt = "Helsenia"; helseniaLogo.className = "splash-logo"; helseniaLogoDiv.appendChild(helseniaLogo)
  const progressContainer = document.createElement("div"); progressContainer.className = "splash-progress-container"
  const progressBar = document.createElement("div"); progressBar.className = "splash-progress-bar"; progressContainer.appendChild(progressBar)
  logoContainer.appendChild(lunaLogoDiv); logoContainer.appendChild(helseniaLogoDiv); el.appendChild(logoContainer); el.appendChild(progressContainer); document.body.appendChild(el)
  setTimeout(() => { progressBar.classList.add("animate") }, 100)
  setTimeout(() => {
    lunaLogoDiv.classList.remove("active")
    setTimeout(() => { helseniaLogoDiv.classList.add("active"); progressBar.classList.add("helsenia") }, 500)
  }, 4000)
  state.splash.shown = true; state.splash.forceTimer = setTimeout(hideSplash, 8000)
}
function hideSplash() {
  const el = document.getElementById("luna-splash"); if (el) { el.classList.add("fade-out"); setTimeout(() => { el.remove() }, 800) }
  state.splash.shown = false
  if (state.splash.timer) { clearTimeout(state.splash.timer); state.splash.timer = null }
  if (state.splash.forceTimer) { clearTimeout(state.splash.forceTimer); state.splash.forceTimer = null }
}

// >>> AJUSTE: instância só após conta logada
async function doLogin() {
  const token = $("#token")?.value?.trim()
  const msgEl = $("#msg"); const btnEl = $("#btn-login")

  // Exigir conta logada primeiro
  if (!acctJwt()) {
    showStepAccount()
    if (msgEl) msgEl.textContent = "Faça login na sua conta primeiro."
    return
  }

  if (!token) { if (msgEl) msgEl.textContent = "Por favor, cole o token da instância"; return }
  if (msgEl) msgEl.textContent = ""
  if (btnEl) { btnEl.disabled = true; btnEl.innerHTML = "<span>Conectando...</span>" }
  try {
    const body = { token }
    if (typeof window !== "undefined" && window.__UAZAPI_HOST__) body.host = window.__UAZAPI_HOST__
    const r = await fetch(BACKEND() + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual"
    })
    if (!r.ok) throw new Error(await r.text())
    const data = await r.json(); localStorage.setItem("luna_jwt", data.jwt)

    // Abre trial para conta e instância (idempotente)
    try { await registerTrial() } catch {}

    // -> entra no app primeiro; billing só depois
    await switchToApp()
    try { if (typeof handleRoute === 'function') handleRoute() } catch(e) {}
  } catch (e) {
    console.error(e); if (msgEl) msgEl.textContent = "Token inválido. Verifique e tente novamente."
  } finally {
    if (btnEl) {
      btnEl.disabled = false
      btnEl.innerHTML = '<span>Conectar instância</span><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>'
    }
  }
}
// <<< fim do ajuste

function ensureTopbar() {
  if (!$(".topbar")) {
    const tb = document.createElement("div"); tb.className = "topbar"
    tb.style.display = "flex"; tb.style.alignItems = "center"; tb.style.gap = "8px"; tb.style.padding = "8px 12px"
    const host = $("#app-view") || document.body; host.prepend(tb)
  }
}
async function switchToApp() {
  hide("#login-view"); show("#app-view"); setMobileMode("list"); ensureTopbar(); ensureCRMBar(); ensureStageTabs(); createSplash()
  ensureMobilePayFAB()

  // 🔒 Verificação de billing ANTES de tentar carregar conversas
  const ok = await checkBillingStatus()
  if (!ok) {
    showBillingView()
    return
  }

  // Atualiza o nome da instância assim que entrarmos no app
  try { await updateProfileName() } catch (e) { console.error('updateProfileName failed', e) }

  // Agora sim, conversa
  showConversasView()
  await loadChats()
}

// >>> conta primeiro, instância depois
async function ensureRoute() {
  const hasAcct = !!acctJwt()
  const hasInst = !!jwt()

  // Sempre mostrar a view de login enquanto faltarem passos
  show("#login-view"); hide("#app-view")

  if (!hasAcct) { showStepAccount(); return }
  if (!hasInst) { showStepInstance(); return }

  // Com conta e instância → app
  await switchToApp()
  try { if (typeof handleRoute === 'function') handleRoute() } catch(e) {}
}
// <<< fim da correção

/* =========================================
 * 7) AVATAR / NOME
 * ======================================= */
async function fetchNameImage(chatid, preview = true) {
  const key = `ni:${chatid}:${preview ? 1 : 0}`
  const hit = LStore.get(key); if (hit) return hit
  return once(key, async () => {
    try {
      const resp = await api("/api/name-image", { method: "POST", body: JSON.stringify({ number: chatid, preview }) })
      const hasData = !!(resp?.name || resp?.image || resp?.imagePreview)
      LStore.set(key, resp, hasData ? TTL.NAME_IMAGE_HIT : TTL.NAME_IMAGE_MISS)
      return resp
    } catch {
      const empty = { name: null, image: null, imagePreview: null }
      LStore.set(key, empty, TTL.NAME_IMAGE_MISS); return empty
    }
  })
}
function initialsOf(str) {
  const s = (str || "").trim(); if (!s) return "??"
  const parts = s.split(/\s+/).slice(0, 2)
  return parts.map((p) => p[0]?.toUpperCase() || "").join("") || "??"
}

/* =========================================
 * 8) ABAS DE STAGE (UI)
 * ======================================= */
function ensureStageTabs() {
  const host = document.querySelector(".topbar")
  if (!host || host.querySelector(".stage-tabs")) return
  const bar = document.createElement("div"); bar.className = "stage-tabs"; bar.style.display = "flex"; bar.style.gap = "8px"
  const addBtn = (key, label, onclick) => {
    const b = document.createElement("button"); b.className = "btn"; b.dataset.stage = key; b.textContent = label
    b.onclick = () => {
      state.activeTab = key; onclick()
      host.querySelectorAll(".stage-tabs .btn").forEach((x) => x.classList.remove("active"))
      b.classList.add("active")
      const mobileSelect = document.getElementById("mobile-stage-select"); if (mobileSelect) mobileSelect.value = key
    }
    return b
  }
  const btnGeral = addBtn("geral", "Geral", () => loadChats())
  const btnCont = addBtn("contatos", "Contatos", () => loadStageTab("contatos"))
  const btnLead = addBtn("lead", "Lead", () => loadStageTab("lead"))
  const btnLQ = addBtn("lead_quente", "Lead Quente", () => loadStageTab("lead_quente"))
  bar.appendChild(btnGeral); bar.appendChild(btnCont); bar.appendChild(btnLead); bar.appendChild(btnLQ)
  const counters = document.createElement("div"); counters.className = "stage-counters"; counters.style.marginLeft = "8px"; counters.style.color = "var(--sub2)"; counters.style.fontSize = "12px"
  host.appendChild(bar); host.appendChild(counters)

  const mobileSelect = document.getElementById("mobile-stage-select")
  if (mobileSelect) {
    mobileSelect.onchange = (e) => {
      const key = e.target.value; state.activeTab = key
      switch (key) {
        case "geral": loadChats(); break
        case "contatos": loadStageTab("contatos"); break
        case "lead": loadStageTab("lead"); break
        case "lead_quente": loadStageTab("lead_quente"); break
      }
      const btn = host.querySelector(`.stage-tabs .btn[data-stage="${key}"]`)
      if (btn) { host.querySelectorAll(".stage-tabs .btn").forEach((x) => x.classList.remove("active")); btn.classList.add("active") }
    }
  }
  setTimeout(() => { (host.querySelector(`.stage-tabs .btn[data-stage="${state.activeTab}"]`) || btnGeral).click() }, 0)
}

function refreshStageCounters() {
  const counts = { contatos: 0, lead: 0, lead_quente: 0 }
  state.chats.forEach((ch) => {
    const chatid = ch.wa_chatid || ch.chatid || ch.wa_fastid || ch.wa_id || ""
    const st = getStage(chatid)?.stage || "contatos"
    if (counts[st] !== undefined) counts[st]++
  })
  const el = document.querySelector(".stage-counters")
  if (el) el.textContent = `contatos: ${counts.contatos} • lead: ${counts.lead} • lead quente: ${counts.lead_quente}`
  const mobileContatos = document.getElementById("mobile-counter-contatos")
  const mobileLead = document.getElementById("mobile-counter-lead")
  const mobileLeadQuente = document.getElementById("mobile-counter-lead_quente")
  if (mobileContatos) mobileContatos.textContent = counts.contatos
  if (mobileLead) mobileLead.textContent = counts.lead
  if (mobileLeadQuente) mobileLeadQuente.textContent = counts.lead_quente

  if (el && !document.getElementById("verification-progress")) {
    const progressEl = document.createElement("div"); progressEl.id = "verification-progress"; progressEl.className = "verification-progress hidden"
    progressEl.innerHTML = `
      <div class="verification-content">
        <div class="verification-text">
          <span class="verification-label">Verificando classificações...</span>
          <span class="verification-counter">0/0 contatos</span>
        </div>
        <div class="verification-bar"><div class="verification-fill"></div></div>
      </div>`
    el.parentNode.appendChild(progressEl)
  }
}

async function loadStageTab(stageKey) {
  const reqId = ++state.listReqId
  const list = $("#chat-list"); list.innerHTML = "<div class='hint'>Carregando…</div>"
  const filtered = state.chats.filter((ch) => {
    const chatid = ch.wa_chatid || ch.chatid || ch.wa_fastid || ch.wa_id || ""
    const st = getStage(chatid)?.stage || "contatos"
    return st === stageKey
  })
  await progressiveRenderChats(filtered, reqId); await prefetchCards(filtered)
}

/* =========================================
 * 9) CHATS (stream + prefetch + ordenação)
 * ======================================= */
async function loadChats() {
  if (state.loadingChats) return
  state.loadingChats = true
  const reqId = ++state.listReqId
  const startTab = state.activeTab
  const list = $("#chat-list"); if (list) list.innerHTML = "<div class='hint'>Carregando conversas...</div>"
  try {
    const res = await fetch(BACKEND() + "/api/chats/stream", {
      method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ operator: "AND", sort: "-wa_lastMsgTimestamp" }),
    })
    if (!res.ok || !res.body) throw new Error("Falha no stream de conversas")
    if (reqId !== state.listReqId) return
    if (list) list.innerHTML = ""
    state.chats = []
    for await (const item of readNDJSONStream(res)) {
      if (item?.error) continue
      state.chats.push(item)
      const baseTs = item.wa_lastMsgTimestamp || item.messageTimestamp || item.updatedAt || 0
      const id = item.wa_chatid || item.chatid || item.wa_fastid || item.wa_id || ""
      updateLastActivity(id, baseTs)
      const stageFromStream = normalizeStage(item?._stage || item?.stage || item?.status || "")
      if (id && stageFromStream) {
        setStage(id, stageFromStream); rIC(refreshStageCounters)
        if (state.activeTab !== "geral") { const tab = state.activeTab; rIC(() => loadStageTab(tab)) }
        if (state.current && (state.current.wa_chatid || state.current.chatid) === id) upsertStagePill(stageFromStream)
      }
      if (state.activeTab === "geral" && startTab === "geral" && reqId === state.listReqId) {
        const curList = $("#chat-list"); if (curList) appendChatSkeleton(curList, item)
      }
      if (!id) continue
      queueStageLookup(id)
      pushBg(async () => {
        try {
          if (!state.nameCache.has(id)) {
            const resp = await fetchNameImage(id); state.nameCache.set(id, resp || {})
            const cardEl = document.querySelector(`.chat-item[data-chatid="${CSS.escape(id)}"]`); if (cardEl) hydrateChatCard(item)
          }
        } catch {}
        try {
          const pvKey = `pv:${id}`; const pvHit = LStore.get(pvKey)
          if (pvHit && !state.lastMsg.has(id)) {
            state.lastMsg.set(id, pvHit.text || ""); state.lastMsgFromMe.set(id, !!pvHit.fromMe)
            const card = document.querySelector(`.chat-item[data-chatid="${CSS.escape(id)}"] .preview`)
            if (card) {
              const txt = pvHit.text ? (pvHit.fromMe ? "Você: " : "") + truncatePreview(pvHit.text, 90) : "Sem mensagens"
              card.textContent = txt; card.title = pvHit.text ? (pvHit.fromMe ? "Você: " : "") + pvHit.text : "Sem mensagens"
            }
          }
          const latest = await api("/api/messages", { method: "POST", body: JSON.stringify({ chatid: id, limit: 1, sort: "-messageTimestamp" }) })
          const last = Array.isArray(latest?.items) ? latest.items[0] : null
          const pv = last
            ? (last.text || last.caption || last?.message?.text || last?.message?.conversation || last?.body || "")
                .replace(/\s+/g, " ").trim()
            : (item.wa_lastMessageText || "").replace(/\s+/g, " ").trim()
          const fromMe = last ? isFromMe(last) : false
          state.lastMsg.set(id, pv || ""); state.lastMsgFromMe.set(id, fromMe)
          LStore.set(pvKey, { text: pv || "", fromMe }, TTL.PREVIEW)
          const card = document.querySelector(`.chat-item[data-chatid="${CSS.escape(id)}"] .preview`)
          if (card) { const txt = pv ? (fromMe ? "Você: " : "") + truncatePreview(pv, 90) : "Sem mensagens"; card.textContent = txt; card.title = pv ? (fromMe ? "Você: " : "") + pv : "Sem mensagens" }
          if (last) {
            updateLastActivity(id, last.messageTimestamp || last.timestamp || last.t || Date.now())
            const tEl = document.querySelector(`.chat-item[data-chatid="${CSS.escape(id)}"] .time`)
            if (tEl) tEl.textContent = formatTime(last.messageTimestamp || last.timestamp || last.t || "")
          }
        } catch {
          const card = document.querySelector(`.chat-item[data-chatid="${CSS.escape(id)}"] .preview`)
          if (card) { card.textContent = "Sem mensagens"; card.title = "Sem mensagens" }
          const base = state.chats.find((c) => (c.wa_chatid || c.chatid || c.wa_fastid || c.wa_id || "") === id) || {}
          updateLastActivity(id, base.wa_lastMsgTimestamp || base.messageTimestamp || base.updatedAt || 0)
        }
      })
    }
    await flushStageLookup()
    if (state.activeTab !== "geral") await loadStageTab(state.activeTab)

    // >>> CORREÇÃO: sem /api/crm/sync; apenas atualiza contadores
    try { await refreshCRMCounters() } catch {}
    // <<<

  } catch (e) {
    console.error(e)
    const list2 = $("#chat-list")
    if (list2 && reqId === state.listReqId) list2.innerHTML = `<div class='error'>${escapeHtml(e.message || "Falha ao carregar conversas")}</div>`
  } finally {
    if (reqId === state.listReqId) state.loadingChats = false
  }
}

/* =========================================
 * 10) LISTA (render + cards)
 * ======================================= */
async function progressiveRenderChats(chats, reqId = null) {
  const list = $("#chat-list"); if (!list) return
  list.innerHTML = ""
  if (chats.length === 0) { if (reqId !== null && reqId !== state.listReqId) return; list.innerHTML = "<div class='hint'>Nenhuma conversa encontrada</div>"; return }
  const BATCH = 14
  for (let i = 0; i < chats.length; i += BATCH) {
    if (reqId !== null && reqId !== state.listReqId) return
    const slice = chats.slice(i, i + BATCH)
    slice.forEach((ch) => { if (reqId !== null && reqId !== state.listReqId) return; appendChatSkeleton(list, ch) })
    await new Promise((r) => rIC(r))
  }
  chats.forEach((ch) => { if (reqId !== null && reqId !== state.listReqId) return; hydrateChatCard(ch) })
  reorderChatList()
}

function appendChatSkeleton(list, ch) {
  const el = document.createElement("div"); el.className = "chat-item"
  const chatid = ch.wa_chatid || ch.chatid || ch.wa_fastid || ch.wa_id || ""
  el.dataset.chatid = chatid; el.onclick = () => openChat(ch)
  const avatar = document.createElement("div"); avatar.className = "avatar"; avatar.textContent = "··"
  const main = document.createElement("div"); main.className = "chat-main"
  const top = document.createElement("div"); top.className = "row1"
  const nm = document.createElement("div"); nm.className = "name"
  nm.textContent = (ch.wa_contactName || ch.name || prettyId(el.dataset.chatid) || "Contato").toString()
  const tm = document.createElement("div"); tm.className = "time"
  const lastTs = ch.wa_lastMsgTimestamp || ch.messageTimestamp || ""; tm.textContent = lastTs ? formatTime(lastTs) : ""
  top.appendChild(nm); top.appendChild(tm)
  const bottom = document.createElement("div"); bottom.className = "row2"
  const preview = document.createElement("div"); preview.className = "preview"
  // Determine the preview text.  Prefer a cached last message if we
  // already fetched it earlier (e.g. when loading the general tab).
  const cachedPv = state.lastMsg.get(el.dataset.chatid)
  const cachedFromMe = state.lastMsgFromMe.get(el.dataset.chatid)
  const pvRaw = (ch.wa_lastMessageText || "").replace(/\s+/g, " ").trim()
  if (typeof cachedPv === 'string' && cachedPv.trim()) {
    // Use cached preview with optional "Você: " prefix
    const truncated = truncatePreview(cachedPv, 90)
    preview.textContent = cachedFromMe ? `Você: ${truncated}` : truncated
    preview.title = cachedFromMe ? `Você: ${cachedPv}` : cachedPv
  } else if (pvRaw) {
    // Fallback to the last message text from the chat object
    preview.textContent = truncatePreview(pvRaw, 90)
    preview.title = pvRaw
  } else {
    // No preview yet; show a loading indicator that will change to
    // "Sem mensagens" after a delay if still unresolved.
    preview.textContent = 'Carregando...'
    preview.title = 'Carregando...'
    setTimeout(() => {
      if (preview && preview.textContent === 'Carregando...') {
        preview.textContent = 'Sem mensagens'
        preview.title = 'Sem mensagens'
      }
    }, 5000)
  }
  const unread = document.createElement("span"); unread.className = "badge"
  const count = state.unread.get(el.dataset.chatid) || ch.wa_unreadCount || 0
  if (count > 0) unread.textContent = count; else unread.style.display = "none"
  bottom.appendChild(preview); bottom.appendChild(unread); main.appendChild(top); main.appendChild(bottom)
  el.appendChild(avatar); el.appendChild(main); list.appendChild(el)
  const baseTs = ch.wa_lastMsgTimestamp || ch.messageTimestamp || ch.updatedAt || 0; updateLastActivity(el.dataset.chatid, baseTs)
  queueStageLookup(chatid); setTimeout(() => { if (!getStage(chatid)) fetchStageNow(chatid) }, 800)
  attachCRMControlsToCard(el, ch)
}

function hydrateChatCard(ch) {
  const chatid = ch.wa_chatid || ch.chatid || ch.wa_fastid || ch.wa_id || ""
  const cache = state.nameCache.get(chatid); if (!chatid || !cache) return
  const el = document.querySelector(`.chat-item[data-chatid="${CSS.escape(chatid)}"]`); if (!el) return
  const avatar = el.querySelector(".avatar"); const nameEl = el.querySelector(".name")
  if (cache.imagePreview || cache.image) {
    avatar.innerHTML = ""; const img = document.createElement("img"); img.src = cache.imagePreview || cache.image; img.alt = "avatar"; avatar.appendChild(img)
  } else { avatar.textContent = initialsOf(cache.name || nameEl.textContent || prettyId(chatid)) }
  if (cache.name) nameEl.textContent = cache.name; else nameEl.textContent = nameEl.textContent || prettyId(chatid)
}

/* =========================================
 * 11) PREFETCH (nomes/últimas/classificação leve)
 * ======================================= */
async function prefetchCards(items) {
  const progressEl = document.getElementById("verification-progress")
  const counterEl = progressEl?.querySelector(".verification-counter")
  const fillEl = progressEl?.querySelector(".verification-fill")

  if (progressEl && items.length > 0) {
    progressEl.classList.remove("hidden"); if (counterEl) counterEl.textContent = `0/${items.length} contatos`; if (fillEl) fillEl.style.width = "0%"
  }
  let completed = 0
  const tasks = items.map((ch) => {
    const chatid = ch.wa_chatid || ch.chatid || ch.wa_fastid || ch.wa_id || ""
    return async () => {
      if (!chatid) return
      queueStageLookup(chatid)
      if (!state.nameCache.has(chatid)) {
        try { const resp = await fetchNameImage(chatid); state.nameCache.set(chatid, resp); hydrateChatCard(ch) } catch {}
      }
      // Always fetch the last message preview if we haven't cached it yet.  The
      // previous implementation skipped the fetch when the conversation
      // contained a `wa_lastMessageText` property.  However, this caused
      // classification tabs to display stale or missing previews because
      // these tabs filter the chat list by stage and may include chats
      // whose last messages are not yet in the cache.  By removing the
      // `ch.wa_lastMessageText` check we ensure every chat has its preview
      // populated once.
      if (!state.lastMsg.has(chatid)) {
        try {
          const pvKey = `pv:${chatid}`; const pvHit = LStore.get(pvKey)
          if (pvHit) {
            state.lastMsg.set(chatid, pvHit.text || ""); state.lastMsgFromMe.set(chatid, !!pvHit.fromMe)
            const card = document.querySelector(`.chat-item[data-chatid="${CSS.escape(chatid)}"] .preview`)
            if (card) {
              const txt = (pvHit.fromMe ? "Você: " : "") + (pvHit.text ? truncatePreview(pvHit.text, 90) : "Sem mensagens")
              card.textContent = txt; card.title = (pvHit.fromMe ? "Você: " : "") + (pvHit.text || "")
            }
            const tEl = document.querySelector(`.chat-item[data-chatid="${CSS.escape(chatid)}"] .time`)
            if (tEl && ch.wa_lastMsgTimestamp) tEl.textContent = formatTime(ch.wa_lastMsgTimestamp)
          } else {
            const data = await api("/api/messages", { method: "POST", body: JSON.stringify({ chatid, limit: 1, sort: "-messageTimestamp" }) })
            const last = Array.isArray(data?.items) ? data.items[0] : null
            if (last) {
              // Derive a preview from the last message.  Consider both top‑level
              // fields and nested `.message`/`.content` containers.  This
              // accommodates different response formats from Uazapi.
              const lmsg = (last && (last.message || last.content)) || {}
              let pv = (typeof last.text === 'string' && last.text) ||
                (typeof last.caption === 'string' && last.caption) ||
                (typeof lmsg.text === 'string' && lmsg.text) ||
                (typeof lmsg.conversation === 'string' && lmsg.conversation) ||
                (lmsg.extendedTextMessage && lmsg.extendedTextMessage.text) ||
                (typeof lmsg.caption === 'string' && lmsg.caption) ||
                (typeof last.body === 'string' && last.body) ||
                ''
              pv = String(pv || '').replace(/\s+/g, ' ').trim()
              state.lastMsg.set(chatid, pv); const fromMe = isFromMe(last); state.lastMsgFromMe.set(chatid, fromMe)
              LStore.set(pvKey, { text: pv || "", fromMe }, TTL.PREVIEW)
              const card = document.querySelector(`.chat-item[data-chatid="${CSS.escape(chatid)}"] .preview`)
              if (card) { const txt = (fromMe ? "Você: " : "") + (pv ? truncatePreview(pv, 90) : "Sem mensagens"); card.textContent = txt; card.title = (fromMe ? "Você: " : "") + pv }
              const tEl = document.querySelector(`.chat-item[data-chatid="${CSS.escape(chatid)}"] .time`)
              if (tEl) tEl.textContent = formatTime(last.messageTimestamp || last.timestamp || last.t || "")
              updateLastActivity(chatid, last.messageTimestamp || last.timestamp || last.t || Date.now())
            } else {
              const card = document.querySelector(`.chat-item[data-chatid="${CSS.escape(chatid)}"] .preview`)
              if (card) { card.textContent = "Sem mensagens"; card.title = "Sem mensagens" }
              updateLastActivity(chatid, ch.wa_lastMsgTimestamp || ch.messageTimestamp || ch.updatedAt || 0)
            }
          }
        } catch {}
      }
      completed++; if (counterEl) counterEl.textContent = `${completed}/${items.length} contatos`; if (fillEl) fillEl.style.width = `${(completed / items.length) * 100}%`
    }
  })
  const CHUNK = 16
  for (let i = 0; i < tasks.length; i += CHUNK) { const slice = tasks.slice(i, i + CHUNK); await runLimited(slice, 8); await new Promise((r) => rIC(r)) }
  await flushStageLookup()
  if (progressEl) setTimeout(() => { progressEl.classList.add("hidden") }, 1000)
}

/* =========================================
 * 12) FORMATAÇÃO DE HORA
 * ======================================= */
function formatTime(ts) {
  const val = toMs(ts); if (!val) return ""
  try {
    const d = new Date(val); const now = new Date(); const diffMs = now - d; const diffH = diffMs / 36e5
    if (diffH < 24) { const hh = String(d.getHours()).padStart(2, "0"); const mm = String(d.getMinutes()).padStart(2, "0"); return `${hh}:${mm}` }
    const diffD = Math.floor(diffMs / 86400000); return `${diffD}d`
  } catch { return "" }
}

/* =========================================
 * 13) ABRIR CHAT / CARREGAR MENSAGENS
 * ======================================= */
async function openChat(ch) {
  state.current = ch
  const title = $("#chat-header"); const status = $(".chat-status")
  const chatid = ch.wa_chatid || ch.chatid || ch.wa_fastid || ch.wa_id || ""
  const cache = state.nameCache.get(chatid) || {}
  const nm = (cache.name || ch.wa_contactName || ch.name || prettyId(chatid) || "Chat").toString()
  if (title) title.textContent = nm
  if (status) status.textContent = "Carregando mensagens..."
  setMobileMode("chat"); await loadMessages(chatid)
  const known = getStage(chatid)
  if (known) { upsertStagePill(known.stage) } else { await fetchStageNow(chatid); const st = getStage(chatid); if (st) upsertStagePill(st.stage) }
  if (status) status.textContent = "Online"
}
function tsOf(m) { return Number(m?.messageTimestamp ?? m?.timestamp ?? m?.t ?? m?.message?.messageTimestamp ?? 0) }
async function classifyInstant(chatid, items) {
  const got = await getOrInitStage(chatid, { messages: items || [] })
  if (got?.stage) { upsertStagePill(got.stage); refreshStageCounters(); return got }
  return null
}
async function getOrInitStage(chatid, { messages = [] } = {}) {
  const c = getStage(chatid); if (c?.stage) return c
  try { const one = await callLeadStatusSingle(chatid); if (one?.stage) { const rec = setStage(chatid, one.stage); return rec } } catch {}
  try {
    if (!messages || !messages.length) {
      const data = await api("/api/messages", { method: "POST", body: JSON.stringify({ chatid, limit: 50, sort: "-messageTimestamp" }) })
      messages = Array.isArray(data?.items) ? data.items : []
      if (data?.stage) { const rec = setStage(chatid, data.stage); return rec }
    } else {
      const data = await api("/api/media/stage/classify", { method: "POST", body: JSON.stringify({ chatid, messages }) })
      if (data?.stage) { const rec = setStage(chatid, data.stage); return rec }
    }
  } catch {}
  return getStage(chatid) || null
}

async function loadMessages(chatid) {
  const pane = $("#messages"); if (pane) pane.innerHTML = "<div class='hint'>Carregando mensagens...</div>"
  try {
    const data = await api("/api/messages", { method: "POST", body: JSON.stringify({ chatid, limit: 200, sort: "-messageTimestamp" }) })
    let items = Array.isArray(data?.items) ? data.items : []
    items = items.slice().sort((a, b) => tsOf(a) - tsOf(b))
    await classifyInstant(chatid, items); await progressiveRenderMessages(items)
    const last = items[items.length - 1]
    const pv = (last?.text || last?.caption || last?.message?.text || last?.message?.conversation || last?.body || "").replace(/\s+/g, " ").trim()
    if (pv) state.lastMsg.set(chatid, pv)
    const fromMeFlag = isFromMe(last || {}); state.lastMsgFromMe.set(chatid, fromMeFlag)
    LStore.set(`pv:${chatid}`, { text: pv || "", fromMe: fromMeFlag }, TTL.PREVIEW)
    if (last) {
      updateLastActivity(chatid, last.messageTimestamp || last.timestamp || last.t || Date.now())
      const tEl = document.querySelector(`.chat-item[data-chatid="${CSS.escape(chatid)}"] .time`)
      if (tEl) tEl.textContent = formatTime(last.messageTimestamp || last.timestamp || last.t || "")
    }
  } catch (e) {
    console.error(e); if (pane) pane.innerHTML = `<div class='error'>Falha ao carregar mensagens: ${escapeHtml(e.message || "")}</div>`
  }
}

/* =========================================
 * 14) RENDERIZAÇÃO DE MENSAGENS
 * ======================================= */
async function progressiveRenderMessages(msgs) {
  const pane = $("#messages"); if (!pane) return
  pane.innerHTML = ""
  if (!msgs.length) {
    pane.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">💬</div>
        <h3>Nenhuma mensagem</h3>
        <p>Esta conversa ainda não possui mensagens</p>
      </div>`; return
  }
  const BATCH = 12
  for (let i = 0; i < msgs.length; i += BATCH) {
    const slice = msgs.slice(i, i + BATCH)
    slice.forEach((m) => {
      try { appendMessageBubble(pane, m) }
      catch {
        const el = document.createElement("div"); el.className = "msg you"
        el.innerHTML = "(mensagem não suportada)<small style='display:block;opacity:.7;margin-top:6px'>Erro ao renderizar</small>"
        pane.appendChild(el)
      }
    })
    await new Promise((r) => rIC(r)); pane.scrollTop = pane.scrollHeight
  }
}

/* =========================================
 * 15) MÍDIA / INTERATIVOS / REPLIES
 * ======================================= */
function pickMediaInfo(m) {
  // Unwrap nested message structures to find the actual payload.  The
  // underlying payload might live under `.message` or `.content`, so
  // consider both when drilling down.
  const base = unwrapMessage(m)
  // Top‑level message container (may be undefined)
  const mm = (base && (base.message || base.content)) || base
  // Determine mimetype. Sticker messages may not have a mimetype, so
  // supply one manually for webp stickers.
  // Determine mimetype. Start with explicit fields on the unwrapped
  // message. If not found, search nested structures for a media
  // message type and extract the mimetype from there.  Stickers
  // default to image/webp when no mimetype is present.
  let mime = base?.mimetype || base?.mime ||
    (mm && mm.imageMessage ? mm.imageMessage.mimetype : undefined) ||
    (mm && mm.videoMessage ? mm.videoMessage.mimetype : undefined) ||
    (mm && mm.documentMessage ? mm.documentMessage.mimetype : undefined) ||
    (mm && mm.audioMessage ? mm.audioMessage.mimetype : undefined) ||
    (mm && mm.stickerMessage ? 'image/webp' : '') || ''
  let url = base?.mediaUrl || base?.url || base?.fileUrl || base?.downloadUrl || base?.image || base?.video || ''
  let dataUrl = base?.dataUrl || ''
  let caption = base?.caption || base?.text || base?.body || ''
  // If we haven't found a URL or mimetype yet, search within nested
  // message structures for media messages.  This covers cases where
  // the media is embedded inside templateMessage.hydratedTemplate or
  // other wrappers not unwrapped by unwrapMessage().
  const nestedMedia = findNested(mm, ['imageMessage','videoMessage','documentMessage','audioMessage','stickerMessage'], 4)
  if (nestedMedia) {
    mime = mime || nestedMedia.mimetype || (nestedMedia.stickerMessage ? 'image/webp' : '') || ''
    url = url || nestedMedia.url || nestedMedia.fileUrl || nestedMedia.downloadUrl || ''
    dataUrl = dataUrl || nestedMedia.dataUrl || ''
    caption = caption || nestedMedia.caption || nestedMedia.fileName || nestedMedia.filename || ''
  } else {
    // Also try to locate nested url fields directly
    const nestedUrlObj = findNested(mm, ['url','fileUrl','downloadUrl','image','video'], 3)
    if (nestedUrlObj && typeof nestedUrlObj === 'string') url = url || nestedUrlObj
  }
  return {
    mime: String(mime || ''),
    url: String(url || ''),
    dataUrl: String(dataUrl || ''),
    caption: String(caption || ''),
  }
}

/*
 * Extract a preview string from a quoted message.  Quoted messages can
 * contain a variety of structures—simple text, captions on media,
 * interactive message titles, etc.  This helper attempts to locate
 * meaningful text within the nested quoted message by checking a
 * number of common fields.  If none of the probe fields contain
 * content, an empty string is returned and the UI falls back to
 * showing a placeholder.  The search depth is limited to avoid
 * traversing excessively deep objects.
 *
 * @param {object} q The quoted message object
 * @returns {string} A short preview text or empty string
 */
function extractQuotedPreview(q) {
  try {
    const base = unwrapMessage(q) || q
    // Candidate keys in order of preference.  Many interactive
    // structures embed the text under nested properties (e.g.
    // hydratedContentText), so we attempt to locate them via findNested.
    const candidateKeys = [
      'extendedTextMessage.text',
      'text',
      'conversation',
      'caption',
      'title',
      'description',
      'body',
      'contentText',
      'hydratedContentText',
      'matchedText'
    ]
    // Helper to access dotted paths
    const getByPath = (obj, path) => {
      const parts = path.split('.')
      let cur = obj
      for (const p of parts) {
        if (!cur || typeof cur !== 'object') return null
        cur = cur[p]
      }
      return cur
    }
    for (const path of candidateKeys) {
      // Try direct dotted path on the unwrapped base
      let direct = getByPath(base, path)
      // If not found, also check on `.message` and `.content` containers
      if (direct == null && base && typeof base === 'object') {
        const container = base.message || base.content
        if (container) {
          direct = getByPath(container, path)
        }
      }
      if (typeof direct === 'string' && direct.trim()) return direct
      // Then attempt via findNested on the leaf key
      const key = path.split('.').pop()
      let val = findNested(base, [key], 3)
      // Search inside `.message`/`.content` as well if not found
      if (!val && base && typeof base === 'object') {
        const container2 = base.message || base.content
        if (container2) {
          val = findNested(container2, [key], 3)
        }
      }
      if (typeof val === 'string' && val.trim()) return val
    }
    // As a final fallback, check specific media caption fields
    if (base?.imageMessage?.caption) return base.imageMessage.caption
    if (base?.videoMessage?.caption) return base.videoMessage.caption
    if (base?.documentMessage?.caption) return base.documentMessage.caption
    return ''
  } catch {
    return ''
  }
}
async function fetchMediaBlobViaProxy(rawUrl) {
  const q = encodeURIComponent(String(rawUrl || ""))
  const r = await fetch(BACKEND() + "/api/media/proxy?u=" + q, { method: "GET", headers: { ...authHeaders() } })
  if (!r.ok) throw new Error("Falha ao baixar mídia")
  return await r.blob()
}
function renderReplyPreview(container, m) {
  // Walk into nested containers to locate context information.
  const base = unwrapMessage(m)
  // Find the contextInfo object either on the unwrapped message, its
  // `.message`/`.content` container, or nested within.  Uazapi may nest
  // `contextInfo` under `.message`/`.content` instead of on the root.
  let ctx = null
  if (base && typeof base === 'object') {
    ctx = base.contextInfo || ((base.message || base.content || {}).contextInfo)
  }
  if (!ctx) ctx = findNested(base, ['contextInfo'], 4) || {}
  // Locate the quoted message inside contextInfo
  let qm = ctx?.quotedMessage || ctx?.quotedMsg || ctx?.quoted_message || null
  // Some Uazapi responses include the quoted object under a generic
  // `quoted` property.  Treat it as a message only if it is an
  // object (string values are just IDs).
  if (!qm && ctx && typeof ctx === 'object') {
    const q = ctx.quoted
    if (q && typeof q === 'object') qm = q
  }
  if (!qm) {
    qm = findNested(ctx, ['quotedMessage', 'quotedMsg', 'quoted_message'], 4)
  }
  // If still nothing found, bail
  if (!qm) return
  // Unwrap the quoted message (may be nested in containers)
  const q = unwrapMessage(qm)
  // Prepare a container for the quoted content
  const box = document.createElement('div')
  box.className = 'bubble-quote'
  box.style.borderLeft = '3px solid var(--muted, #ccc)'
  box.style.padding = '6px 8px'
  box.style.marginBottom = '6px'
  box.style.opacity = '.8'
  box.style.fontSize = '12px'
  // Render any interactive components from the quoted message inside the box
  let hadInteractive = false
  try {
    hadInteractive = renderInteractive(box, q) || false
  } catch {}
  // Extract plain text preview from the quoted message
  const preview = extractQuotedPreview(q)
  if (preview) {
    // If there were interactive elements, separate the preview below
    if (hadInteractive) {
      const sep = document.createElement('div')
      sep.style.marginTop = '4px'
      sep.style.fontSize = '12px'
      sep.style.opacity = '.8'
      sep.textContent = preview
      box.appendChild(sep)
    } else {
      box.textContent = preview
    }
  } else if (!hadInteractive) {
    // No content found — show placeholder
    box.textContent = '(mensagem citada)'
  }
  container.appendChild(box)
}
function renderInteractive(container, m) {
  // Unwrap nested structures to expose interactive message types.  The
  // underlying payload may reside under `.message` or `.content`, so
  // consider both when determining the root.
  const base = unwrapMessage(m)
  const msg = (base && (base.message || base.content)) || base || {}
  // Some message types wrap the actual content inside
  // `interactiveMessage`, so prefer that if present.
  const root = msg?.interactiveMessage || msg
  // List and button messages may be nested inside templateMessage,
  // hydratedTemplate or other wrappers.  Use findNested to locate
  // them if not directly present on the root.
  const listMsg = root?.listMessage || findNested(root, ['listMessage'], 3)
  const btnsMsg = root?.buttonsMessage || root?.templateMessage?.hydratedTemplate || findNested(root, ['buttonsMessage','hydratedTemplate'], 3)
  const listResp = root?.listResponseMessage || findNested(root, ['listResponseMessage','listResponse'], 3)
  const btnResp = root?.buttonsResponseMessage || findNested(root, ['buttonsResponseMessage','buttonsResponse'], 3)

  if (listMsg) {
    const card = document.createElement('div'); card.className = 'bubble-actions'
    card.style.border = '1px solid var(--muted,#ddd)'; card.style.borderRadius = '8px'; card.style.padding = '8px'; card.style.maxWidth = '320px'
    if (listMsg.title) { const h = document.createElement('div'); h.style.fontWeight = '600'; h.style.marginBottom = '6px'; h.textContent = listMsg.title; card.appendChild(h) }
    if (listMsg.description) { const d = document.createElement('div'); d.style.fontSize = '12px'; d.style.opacity = '.85'; d.style.marginBottom = '6px'; d.textContent = listMsg.description; card.appendChild(d) }
    ;(listMsg.sections || []).forEach((sec) => {
      if (sec.title) { const st = document.createElement('div'); st.style.margin = '6px 0 4px'; st.style.fontSize = '12px'; st.style.opacity = '.8'; st.textContent = sec.title; card.appendChild(st) }
      ;(sec.rows || []).forEach((row) => {
        const opt = document.createElement('div')
        opt.style.padding = '6px 8px'
        opt.style.border = '1px solid var(--muted,#eee)'
        opt.style.borderRadius = '6px'
        opt.style.marginBottom = '6px'
        opt.textContent = row.title || row.id || '(opção)'
        card.appendChild(opt)
      })
    })
    container.appendChild(card); return true
  }
  if (btnsMsg) {
    const card = document.createElement('div'); card.className = 'bubble-actions'
    card.style.border = '1px solid var(--muted,#ddd)'; card.style.borderRadius = '8px'; card.style.padding = '8px'; card.style.maxWidth = '320px'
    const title = btnsMsg.title || btnsMsg.hydratedTitle; const text = btnsMsg.text || btnsMsg.hydratedContentText
    if (title) { const h = document.createElement('div'); h.style.fontWeight = '600'; h.style.marginBottom = '6px'; h.textContent = title; card.appendChild(h) }
    if (text) { const d = document.createElement('div'); d.style.fontSize = '12px'; d.style.opacity = '.85'; d.style.marginBottom = '6px'; d.textContent = text; card.appendChild(d) }
    const buttons = btnsMsg.buttons || btnsMsg.hydratedButtons || []
    buttons.forEach((b) => {
      const lbl = b?.quickReplyButton?.displayText || b?.urlButton?.displayText || b?.callButton?.displayText || b?.displayText || 'Opção'
      const btn = document.createElement('div'); btn.textContent = lbl; btn.style.display = 'inline-block'; btn.style.padding = '6px 10px'; btn.style.border = '1px solid var(--muted,#eee)'; btn.style.borderRadius = '999px'; btn.style.margin = '4px 6px 0 0'; btn.style.fontSize = '12px'; btn.style.opacity = '.9'; card.appendChild(btn)
    })
    container.appendChild(card); return true
  }
  if (listResp) {
    const picked = listResp?.singleSelectReply?.selectedRowId || listResp?.title || '(resposta de lista)'
    const tag = document.createElement('div'); tag.style.display = 'inline-block'; tag.style.padding = '6px 10px'; tag.style.border = '1px solid var(--muted,#ddd)'; tag.style.borderRadius = '6px'; tag.style.fontSize = '12px'; tag.textContent = picked; container.appendChild(tag); return true
  }
  if (btnResp) {
    const picked = btnResp?.selectedDisplayText || btnResp?.selectedButtonId || '(resposta)'
    const tag = document.createElement('div'); tag.style.display = 'inline-block'; tag.style.padding = '6px 10px'; tag.style.border = '1px solid var(--muted,#ddd)'; tag.style.borderRadius = '6px'; tag.style.fontSize = '12px'; tag.textContent = picked; container.appendChild(tag); return true
  }
  return false
}

/* =========================================
 * 16) AUTORIA
 * ======================================= */
function isFromMe(m) {
  return !!(m?.fromMe || m?.fromme || m?.from_me || m?.key?.fromMe || m?.message?.key?.fromMe || m?.sender?.fromMe ||
    (typeof m?.participant === "string" && /(:me|@s\.whatsapp\.net)$/i.test(m.participant)) ||
    (typeof m?.author === "string" && ((/(:me)$/i.test(m.author) || /@s\.whatsapp\.net/i.test(m.author)) && m.fromMe === true)) ||
    (typeof m?.id === "string" && /^true_/.test(m.id)) || m?.user === "me")
}

/* =========================================
 * 17) BOLHA DE MENSAGEM
 * ======================================= */
function appendMessageBubble(pane, m) {
  const me = isFromMe(m)
  const el = document.createElement("div"); el.className = "msg " + (me ? "me" : "you")
  const top = document.createElement("div"); renderReplyPreview(top, m)
  const hadInteractive = renderInteractive(top, m)
  const { mime, url, dataUrl, caption } = pickMediaInfo(m)
  // Determine plain text by checking both the top-level and nested containers.
  // Compute a plain text preview.  Unwrap nested structures to locate
  // text or caption fields.  Fall back to top‑level fields as well.
  const mUnwrapped = unwrapMessage(m) || {}
  const container = (m && (m.message || m.content)) || {}
  const plainText =
    (typeof m.text === 'string' && m.text) ||
    (typeof m.caption === 'string' && m.caption) ||
    (typeof container.text === 'string' && container.text) ||
    (typeof container.conversation === 'string' && container.conversation) ||
    (container.extendedTextMessage && container.extendedTextMessage.text) ||
    (typeof mUnwrapped.text === 'string' && mUnwrapped.text) ||
    (typeof mUnwrapped.conversation === 'string' && mUnwrapped.conversation) ||
    (mUnwrapped.extendedTextMessage && mUnwrapped.extendedTextMessage.text) ||
    (typeof mUnwrapped.caption === 'string' && mUnwrapped.caption) ||
    (typeof m.body === 'string' && m.body) ||
    ''
  const who = m.senderName || m.pushName || ""; const ts = m.messageTimestamp || m.timestamp || m.t || ""

  // If we detected a possible media message but there is no URL or dataUrl yet,
  // attempt to resolve the media via backend.  This covers scenarios where
  // Uazapi provides only a media key and the actual download URL must be
  // retrieved via the /media/resolve endpoint.  Once resolved, we
  // re-invoke rendering logic with the obtained URL.
  // Unwrap once for media detection
  const baseMedia = unwrapMessage(m)
  const hasMediaIndicator = !!(
    (mime && /^(image|video|audio|application)\//i.test(mime)) ||
    findNested(baseMedia, ['imageMessage','videoMessage','documentMessage','audioMessage','stickerMessage'], 3)
  )
  if (!url && !dataUrl && hasMediaIndicator) {
    // Show a placeholder while resolving
    const placeholder = document.createElement('div'); placeholder.className = 'msg-placeholder'; placeholder.textContent = '(carregando mídia…)';
    pane.appendChild(placeholder); pane.scrollTop = pane.scrollHeight
    // Attempt to resolve via API
    api('/api/media/resolve', { method: 'POST', body: JSON.stringify(m) }).then((res) => {
      try {
        const resolvedUrl = res && (res.url || res.downloadUrl || res.dataUrl)
        const resolvedMime = res && (res.mime || res.mimetype || mime)
        const resolvedData = res && res.dataUrl
        // Remove placeholder
        if (placeholder.parentNode) placeholder.parentNode.removeChild(placeholder)
        // If we got a URL or data, update local variables and fall back to standard rendering
        if (resolvedUrl || resolvedData) {
          const mm = { mime: resolvedMime || '', url: resolvedUrl || '', dataUrl: resolvedData || '', caption: caption }
          // Compose a minimal message wrapper to reuse existing rendering
          // Use closures to capture current variables
          // Determine type and render accordingly (image/video/audio/document)
          const { mime: _mime, url: _url, dataUrl: _dataUrl, caption: _cap } = mm
          // Sticker
          if (_mime && /^image\/webp$/i.test(_mime) && (_url || _dataUrl)) {
            const img = document.createElement('img'); img.alt = 'figurinha'; img.style.maxWidth = '160px'; img.style.borderRadius = '8px'
            if (top.childNodes.length) el.appendChild(top); el.appendChild(img)
            const meta = document.createElement('small'); meta.textContent = `${escapeHtml(who)} • ${formatTime(ts)}`; meta.style.display = 'block'; meta.style.marginTop = '6px'; meta.style.opacity = '.75'; el.appendChild(meta)
            pane.appendChild(el); const after = () => { pane.scrollTop = pane.scrollHeight }
            if (_dataUrl) { img.onload = after; img.src = _dataUrl }
            else { fetchMediaBlobViaProxy(_url).then((b) => { img.onload = after; img.src = URL.createObjectURL(b) }).catch(() => { img.alt = '(Falha ao carregar figurinha)'; after() }) }
            return
          }
          // Image
          if ((_mime && _mime.startsWith('image/')) || (!_mime && _url && /\.(png|jpe?g|gif|webp)(\?|$)/i.test(_url))) {
            const figure = document.createElement('figure'); figure.style.maxWidth = '280px'; figure.style.margin = '0'
            const img2 = document.createElement('img'); img2.alt = 'imagem'; img2.style.maxWidth = '100%'; img2.style.borderRadius = '8px'; img2.style.display = 'block'
            const cap2 = document.createElement('figcaption'); cap2.style.fontSize = '12px'; cap2.style.opacity = '.8'; cap2.style.marginTop = '6px'; cap2.textContent = _cap || plainText || ''
            if (top.childNodes.length) el.appendChild(top); figure.appendChild(img2); if (cap2.textContent) figure.appendChild(cap2); el.appendChild(figure)
            const meta2 = document.createElement('small'); meta2.textContent = `${escapeHtml(who)} • ${formatTime(ts)}`; meta2.style.display = 'block'; meta2.style.marginTop = '6px'; meta2.style.opacity = '.75'; el.appendChild(meta2)
            pane.appendChild(el); const after2 = () => { pane.scrollTop = pane.scrollHeight }
            if (_dataUrl) { img2.onload = after2; img2.src = _dataUrl }
            else { fetchMediaBlobViaProxy(_url).then((b) => { img2.onload = after2; img2.src = URL.createObjectURL(b) }).catch(() => { img2.alt = '(Falha ao carregar imagem)'; after2() }) }
            return
          }
          // Video
          if ((_mime && _mime.startsWith('video/')) || (!_mime && _url && /\.(mp4|webm|mov|m4v)(\?|$)/i.test(_url))) {
            const video2 = document.createElement('video'); video2.controls = true; video2.style.maxWidth = '320px'; video2.style.borderRadius = '8px'; video2.preload = 'metadata'
            if (top.childNodes.length) el.appendChild(top); el.appendChild(video2)
            const cap2 = document.createElement('div'); cap2.style.fontSize = '12px'; cap2.style.opacity = '.8'; cap2.style.marginTop = '6px'; cap2.textContent = _cap || ''
            if (cap2.textContent) el.appendChild(cap2)
            const meta2 = document.createElement('small'); meta2.textContent = `${escapeHtml(who)} • ${formatTime(ts)}`; meta2.style.display = 'block'; meta2.style.marginTop = '6px'; meta2.style.opacity = '.75'; el.appendChild(meta2)
            pane.appendChild(el); const after2 = () => { pane.scrollTop = pane.scrollHeight }
            if (_dataUrl) { video2.onloadeddata = after2; video2.src = _dataUrl }
            else { fetchMediaBlobViaProxy(_url).then((b) => { video2.onloadeddata = after2; video2.src = URL.createObjectURL(b) }).catch(() => { const err = document.createElement('div'); err.style.fontSize = '12px'; err.style.opacity = '.8'; err.textContent = '(Falha ao carregar vídeo)'; el.insertBefore(err, meta2); after2() }) }
            return
          }
          // Audio
          if ((_mime && _mime.startsWith('audio/')) || (!_mime && _url && /\.(mp3|ogg|m4a|wav)(\?|$)/i.test(_url))) {
            const audio2 = document.createElement('audio'); audio2.controls = true; audio2.preload = 'metadata'
            if (top.childNodes.length) el.appendChild(top); el.appendChild(audio2)
            const meta2 = document.createElement('small'); meta2.textContent = `${escapeHtml(who)} • ${formatTime(ts)}`; meta2.style.display = 'block'; meta2.style.marginTop = '6px'; meta2.style.opacity = '.75'; el.appendChild(meta2)
            pane.appendChild(el); const after2 = () => { pane.scrollTop = pane.scrollHeight }
            if (_dataUrl) { audio2.onloadeddata = after2; audio2.src = _dataUrl }
            else { fetchMediaBlobViaProxy(_url).then((b) => { audio2.onloadeddata = after2; audio2.src = URL.createObjectURL(b) }).catch(() => { const err = document.createElement('div'); err.style.fontSize = '12px'; err.style.opacity = '.8'; err.textContent = '(Falha ao carregar áudio)'; el.insertBefore(err, meta2); after2() }) }
            return
          }
          // Document
          if ((_mime && /^application\//.test(_mime)) || (!_mime && _url && /\.(pdf|docx?|xlsx?|pptx?)$/i.test(_url))) {
            if (top.childNodes.length) el.appendChild(top)
            const link = document.createElement('a'); link.textContent = _cap || plainText || 'Documento'; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.href = 'javascript:void(0)'
            link.onclick = async () => {
              try { const b2 = await fetchMediaBlobViaProxy(_url); const blobUrl = URL.createObjectURL(b2); window.open(blobUrl, '_blank') }
              catch { alert('Falha ao baixar documento') }
            }
            el.appendChild(link)
            const meta2 = document.createElement('small'); meta2.textContent = `${escapeHtml(who)} • ${formatTime(ts)}`; meta2.style.display = 'block'; meta2.style.marginTop = '6px'; meta2.style.opacity = '.75'; el.appendChild(meta2)
            pane.appendChild(el); pane.scrollTop = pane.scrollHeight; return
          }
          // If still no media type match, fall back to text below
        }
        // If resolution failed, remove placeholder and fall back to default text
        if (!resolvedUrl && !resolvedData) {
          if (placeholder.parentNode) placeholder.parentNode.removeChild(placeholder)
          // Continue to fallback textual rendering after this block
        }
      } catch (err) {
        if (placeholder.parentNode) placeholder.parentNode.removeChild(placeholder)
        console.error('media resolve failed', err)
      }
    }).catch(() => {
      if (placeholder.parentNode) placeholder.parentNode.removeChild(placeholder)
    })
    // We return here because the rest of the rendering will occur in the
    // resolution callback or fallback after removal of placeholder
    return
  }

  // Sticker
  if (mime && /^image\/webp$/i.test(mime) && (url || dataUrl)) {
    const img = document.createElement("img"); img.alt = "figurinha"; img.style.maxWidth = "160px"; img.style.borderRadius = "8px"
    if (top.childNodes.length) el.appendChild(top); el.appendChild(img)
    const meta = document.createElement("small"); meta.textContent = `${escapeHtml(who)} • ${formatTime(ts)}`; meta.style.display = "block"; meta.style.marginTop = "6px"; meta.style.opacity = ".75"; el.appendChild(meta)
    pane.appendChild(el); const after = () => { pane.scrollTop = pane.scrollHeight }
    if (dataUrl) { img.onload = after; img.src = dataUrl }
    else if (url) { fetchMediaBlobViaProxy(url).then((b) => { img.onload = after; img.src = URL.createObjectURL(b) }).catch(() => { img.alt = "(Falha ao carregar figurinha)"; after() }) }
    return
  }

  // IMAGEM
  if ((mime && mime.startsWith("image/")) || (!mime && url && /\.(png|jpe?g|gif|webp)(\?|$)/i.test(url))) {
    const figure = document.createElement("figure"); figure.style.maxWidth = "280px"; figure.style.margin = "0"
    const img = document.createElement("img"); img.alt = "imagem"; img.style.maxWidth = "100%"; img.style.borderRadius = "8px"; img.style.display = "block"
    const cap = document.createElement("figcaption"); cap.style.fontSize = "12px"; cap.style.opacity = ".8"; cap.style.marginTop = "6px"; cap.textContent = caption || plainText || ""
    if (top.childNodes.length) el.appendChild(top); figure.appendChild(img); if (cap.textContent) figure.appendChild(cap); el.appendChild(figure)
    const meta = document.createElement("small"); meta.textContent = `${escapeHtml(who)} • ${formatTime(ts)}`; meta.style.display = "block"; meta.style.marginTop = "6px"; meta.style.opacity = ".75"; el.appendChild(meta)
    pane.appendChild(el); const after = () => { pane.scrollTop = pane.scrollHeight }
    if (dataUrl) { img.onload = after; img.src = dataUrl }
    else if (url) {
      fetchMediaBlobViaProxy(url).then((b) => { img.onload = after; img.src = URL.createObjectURL(b) }).catch(() => { img.alt = "(Falha ao carregar imagem)"; after() })
    } else { img.alt = "(Imagem não disponível)"; after() }
    return
  }

  // VÍDEO
  if ((mime && mime.startsWith("video/")) || (!mime && url && /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url))) {
    const video = document.createElement("video"); video.controls = true; video.style.maxWidth = "320px"; video.style.borderRadius = "8px"; video.preload = "metadata"
    if (top.childNodes.length) el.appendChild(top); el.appendChild(video)
    const cap = document.createElement("div"); cap.style.fontSize = "12px"; cap.style.opacity = ".8"; cap.style.marginTop = "6px"; cap.textContent = caption || ""
    if (cap.textContent) el.appendChild(cap)
    const meta = document.createElement("small"); meta.textContent = `${escapeHtml(who)} • ${formatTime(ts)}`; meta.style.display = "block"; meta.style.marginTop = "6px"; meta.style.opacity = ".75"; el.appendChild(meta)
    pane.appendChild(el); const after = () => { pane.scrollTop = pane.scrollHeight }
    if (dataUrl) { video.onloadeddata = after; video.src = dataUrl }
    else if (url) {
      fetchMediaBlobViaProxy(url).then((b) => {
        video.onloadeddata = after; video.src = URL.createObjectURL(b)
      }).catch(() => {
        const err = document.createElement("div"); err.style.fontSize = "12px"; err.style.opacity = ".8"; err.textContent = "(Falha ao carregar vídeo)"; el.insertBefore(err, meta); after()
      })
    } else { const err = document.createElement("div"); err.style.fontSize = "12px"; err.style.opacity = ".8"; err.textContent = "(Vídeo não disponível)"; el.insertBefore(err, meta); after() }
    return
  }

  // ÁUDIO
  if ((mime && mime.startsWith("audio/")) || (!mime && url && /\.(mp3|ogg|m4a|wav)(\?|$)/i.test(url))) {
    const audio = document.createElement("audio"); audio.controls = true; audio.preload = "metadata"
    if (top.childNodes.length) el.appendChild(top); el.appendChild(audio)
    const meta = document.createElement("small"); meta.textContent = `${escapeHtml(who)} • ${formatTime(ts)}`; meta.style.display = "block"; meta.style.marginTop = "6px"; meta.style.opacity = ".75"; el.appendChild(meta)
    pane.appendChild(el); const after = () => { pane.scrollTop = pane.scrollHeight }
    if (dataUrl) { audio.onloadeddata = after; audio.src = dataUrl }
    else if (url) {
      fetchMediaBlobViaProxy(url).then((b) => { audio.onloadeddata = after; audio.src = URL.createObjectURL(b) }).catch(() => {
        const err = document.createElement("div"); err.style.fontSize = "12px"; err.style.opacity = ".8"; err.textContent = "(Falha ao carregar áudio)"; el.insertBefore(err, meta); after()
      })
    } else { const err = document.createElement("div"); err.style.fontSize = "12px"; err.style.opacity = ".8"; err.textContent = "(Áudio não disponível)"; el.insertBefore(err, meta); after() }
    return
  }

  // DOCUMENTO
  if ((mime && /^application\//.test(mime)) || (!mime && url && /\.(pdf|docx?|xlsx?|pptx?)$/i.test(url))) {
    if (top.childNodes.length) el.appendChild(top)
    const link = document.createElement("a"); link.textContent = caption || plainText || "Documento"; link.target = "_blank"; link.rel = "noopener noreferrer"; link.href = "javascript:void(0)"
    link.onclick = async () => {
      try { const b = await fetchMediaBlobViaProxy(url); const blobUrl = URL.createObjectURL(b); window.open(blobUrl, "_blank") }
      catch { alert("Falha ao baixar documento") }
    }
    el.appendChild(link)
    const meta = document.createElement("small"); meta.textContent = `${escapeHtml(who)} • ${formatTime(ts)}`; meta.style.display = "block"; meta.style.marginTop = "6px"; meta.style.opacity = ".75"; el.appendChild(meta)
    pane.appendChild(el); pane.scrollTop = pane.scrollHeight; return
  }

  // INTERATIVO sem texto
  if (hadInteractive && !plainText) {
    if (top.childNodes.length) el.appendChild(top)
    const meta = document.createElement("small"); meta.textContent = `${escapeHtml(who)} • ${formatTime(ts)}`; meta.style.display = "block"; meta.style.marginTop = "6px"; meta.style.opacity = ".75"; el.appendChild(meta)
    pane.appendChild(el); pane.scrollTop = pane.scrollHeight; return
  }

  // TEXTO
  if (top.childNodes.length) el.appendChild(top)
  el.innerHTML += `${escapeHtml(plainText)}<small>${escapeHtml(who)} • ${formatTime(ts)}</small>`
  pane.appendChild(el); pane.scrollTop = pane.scrollHeight
}

/* =========================================
 * 18) PILL DE STAGE NO HEADER
 * ======================================= */
function upsertStagePill(stage) {
  let pill = document.getElementById("ai-pill")
  if (!pill) {
    pill = document.createElement("span")
    pill.id = "ai-pill"
    pill.style.marginLeft = "8px"
    pill.style.padding = "4px 8px"
    pill.style.borderRadius = "999px"
    pill.style.fontSize = "12px"
    pill.style.background = "var(--muted)"
    pill.style.color = "var(--text)"
    const header = document.querySelector(".chatbar") || document.querySelector(".chat-title") || document.body
    header.appendChild(pill)
  }
  const label = STAGE_LABEL[normalizeStage(stage)] || stage
  pill.textContent = label; pill.title = ""
}

/* =========================================
 * 19) RENDER “CLÁSSICO”
 * ======================================= */
function renderMessages(msgs) {
  const pane = $("#messages"); if (!pane) return
  pane.innerHTML = ""
  if (msgs.length === 0) {
    pane.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">💬</div>
        <h3>Nenhuma mensagem</h3>
        <p>Esta conversa ainda não possui mensagens</p>
      </div>`; return
  }
  msgs.forEach((m) => {
    const me = isFromMe(m)
    const el = document.createElement("div"); el.className = "msg " + (me ? "me" : "you")
    const text = m.text || m.message?.text || m.caption || m?.message?.conversation || m?.body || ""
    const who = m.senderName || m.pushName || ""
    const ts = m.messageTimestamp || m.timestamp || m.t || ""
    el.innerHTML = `${escapeHtml(text)}<small>${escapeHtml(who)} • ${formatTime(ts)}</small>`
    pane.appendChild(el)
  })
  pane.scrollTop = pane.scrollHeight
}

/* =========================================
 * 20) ENVIO
 * ======================================= */
async function sendNow() {
  const number = $("#send-number")?.value?.trim()
  const text = $("#send-text")?.value?.trim()
  const btnEl = $("#btn-send")
  if (!number || !text) return
  if (btnEl) {
    btnEl.disabled = true
    btnEl.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>'
  }
  try {
    await api("/api/send-text", { method: "POST", body: JSON.stringify({ number, text }) })
    updateLastActivity(number, Date.now())
    if ($("#send-text")) $("#send-text").value = ""
    if (state.current && (state.current.wa_chatid || state.current.chatid) === number) setTimeout(() => loadMessages(number), 500)
  } catch (e) {
    alert(e.message || "Falha ao enviar mensagem")
  } finally {
    if (btnEl) {
      btnEl.disabled = false
      btnEl.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>'
    }
  }
}

/* =========================================
 * 21) BOOT
 * ======================================= */
document.addEventListener("DOMContentLoaded", () => {
  // Botões padrão
  $("#btn-login") && ($("#btn-login").onclick = doLogin)
  $("#btn-logout") && ($("#btn-logout").onclick = () => { localStorage.clear(); location.reload() })
  $("#btn-send") && ($("#btn-send").onclick = sendNow)
  $("#btn-refresh") && ($("#btn-refresh").onclick = () => { if (state.current) { const chatid = state.current.wa_chatid || state.current.chatid; loadMessages(chatid) } else { loadChats() } })

  const backBtn = document.getElementById("btn-back-mobile"); if (backBtn) backBtn.onclick = () => setMobileMode("list")

  $("#send-text") && $("#send-text").addEventListener("keypress", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendNow() } })

  // Enter no input do token
  $("#token") && $("#token").addEventListener("keypress", (e) => { if (e.key === "Enter") { e.preventDefault(); doLogin() } })
  $("#token") && $("#token").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doLogin() } })

  // ⚠️ FIX: impedir submit nativo do formulário APENAS no passo de instância
  try {
    const forms = Array.from(document.querySelectorAll('#step-instance form'))
    forms.forEach((f) => {
      f.addEventListener("submit", (ev) => { ev.preventDefault(); doLogin() })
      try { f.setAttribute("action", ""); f.setAttribute("novalidate", "novalidate") } catch {}
    })
    const btn = document.getElementById("btn-login")
    if (btn) { try { if (btn.type && btn.type.toLowerCase() === "submit") btn.type = "button" } catch {}; btn.onclick = (ev) => { ev.preventDefault(); doLogin() } }
  } catch {}

  // Login por e-mail
  $("#btn-acct-login") && ($("#btn-acct-login").onclick = acctLogin)
  $("#acct-pass") && $("#acct-pass").addEventListener("keypress", (e) => { if (e.key === "Enter") { e.preventDefault(); acctLogin() } })

  // Billing system
  $("#btn-conversas") && ($("#btn-conversas").onclick = showConversasView)
  $("#btn-pagamentos") && ($("#btn-pagamentos").onclick = showBillingView)

  // Pagamento com Stripe (AGORA com email + fallback robusto)
  $("#btn-pay-stripe") && ($("#btn-pay-stripe").onclick = async () => {
    // Antes de iniciar o checkout, garantimos que existe um billing_key atualizado.
    try {
      await checkBillingStatus({ allowModal: false })
    } catch (e) {
      // Falhas transitórias ao verificar o billing não devem impedir a cobrança
      console.warn("[billing] erro ao atualizar status antes de pagar:", e)
    }
    const plan = "luna_base";
    const tk   = (window.__BILLING_KEY__ || "").toString();
    const em   = (window.__USER_EMAIL__  || userEmail() || "").toString();
    await goToStripeCheckout({ plan, tenant_key: tk, email: em })
  })

  // Navegação mobile (se existir no HTML)
  $("#btn-mobile-conversas") && ($("#btn-mobile-conversas").onclick = showConversasView)
  $("#btn-mobile-pagamentos") && ($("#btn-mobile-pagamentos").onclick = showBillingView)

  // 👉 handler do botão do modal
  $("#btn-go-to-payments") && ($("#btn-go-to-payments").onclick = async (e) => {
    e.preventDefault();
    hideBillingModal();
    showBillingView();
    setViewInURL("billing", true);
    // Garante que o billing_key está carregado antes do checkout
    try { await checkBillingStatus({ allowModal: false }) } catch (e2) { console.warn(e2) }
    const plan = "luna_base";
    const tk   = (window.__BILLING_KEY__ || "").toString();
    const em   = (window.__USER_EMAIL__  || userEmail() || "").toString();
    await goToStripeCheckout({ plan, tenant_key: tk, email: em })
  })
  $("#btn-logout-modal") && ($("#btn-logout-modal").onclick = () => { localStorage.clear(); location.reload() })

  // Card payment modal (legado)
  $("#btn-card-cancel") && ($("#btn-card-cancel").onclick = hideCardModal)
  const cardModal = document.getElementById("card-modal")
  if (cardModal) { const overlay = cardModal.querySelector(".modal-overlay"); if (overlay) overlay.onclick = hideCardModal }
  const cardForm = document.getElementById("card-form"); if (cardForm) cardForm.addEventListener("submit", submitCardPayment)

  // Voltar para etapa de conta
  $("#btn-voltar-account") && ($("#btn-voltar-account").onclick = showStepAccount)

  // Cadastro
  $("#link-acct-register") && ($("#link-acct-register").onclick = (e) => { e.preventDefault(); showStepRegister(); $("#reg-email")?.focus() })
  $("#btn-back-to-login") && ($("#btn-back-to-login").onclick = (e) => { e.preventDefault(); showStepAccount(); $("#acct-email")?.focus() })
  $("#btn-acct-register") && ($("#btn-acct-register").onclick = acctRegister)
  $("#reg-pass") && $("#reg-pass").addEventListener("keypress", (e) => { if (e.key === "Enter") { e.preventDefault(); acctRegister() } })

  // Link "cadastrar" → mesmo fluxo do botão de pagar
  $("#link-cadastrar") && ($("#link-cadastrar").onclick = async (e) => {
    e.preventDefault();
    // Verifica/atualiza status para carregar o billing_key
    try { await checkBillingStatus({ allowModal: false }) } catch (e3) { console.warn(e3) }
    const plan = "luna_base";
    const tk   = (window.__BILLING_KEY__ || "").toString();
    const em   = (window.__USER_EMAIL__  || userEmail() || "").toString();
    await goToStripeCheckout({ plan, tenant_key: tk, email: em })
  })

  // Deep-link: abrir direto Pagamentos com ?view=billing ou #billing
  window.addEventListener("popstate", handleRoute)
  window.addEventListener("hashchange", handleRoute)

  ensureRoute()
  // Se já estiver tudo ok e vier deep-link, o ensureRoute chama handleRoute;
  // mas garantimos novamente aqui para primeira carga:
  setTimeout(() => { try { handleRoute() } catch {} }, 0)
})
