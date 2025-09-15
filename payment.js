// getnet-payment.js
(function(){
  function $(sel){ return document.querySelector(sel); }
  function showCardModal(){
    const modal = document.getElementById("card-modal");
    if(!modal){ alert("Tela de pagamento indisponível."); return; }
    modal.classList.remove("hidden");
    const err = document.getElementById("card-error");
    if (err) err.textContent = "";
    try{
      const t = localStorage.getItem("luna_jwt")||localStorage.getItem("luna_acct_jwt")||"";
      if (t && t.indexOf(".")>0){
        let b64=t.split(".")[1].replace(/-/g,"+").replace(/_/g,"/"); b64 += "=".repeat((4-(b64.length%4))%4);
        const p = JSON.parse(atob(b64));
        const emailInput = document.getElementById("card-email");
        if (emailInput && !emailInput.value) emailInput.value = p.email || p.sub || "";
        const nameInput = document.getElementById("card-name");
        if (nameInput && !nameInput.value) nameInput.value = p.name || "";
      }
    }catch{}
  }
  function hideCardModal(){
    const modal = document.getElementById("card-modal");
    if (modal) modal.classList.add("hidden");
  }
  async function submitCardPayment(ev){
    ev.preventDefault();
    const btn = document.getElementById("btn-card-submit");
    const err = document.getElementById("card-error");
    if (err) err.textContent = "";
    if (btn){ btn.disabled = true; btn.textContent = "Processando..."; }

    try{
      const name = document.getElementById("card-name").value.trim();
      const email = document.getElementById("card-email").value.trim();
      const documentNumber = document.getElementById("card-document").value.trim() || undefined;
      const phoneNumber = document.getElementById("card-phone").value.trim() || undefined;
      const cardholderName = document.getElementById("cardholder-name").value.trim();
      const cardNumber = document.getElementById("card-number").value.replace(/\s+/g,"");
      const expMonth = document.getElementById("card-exp-month").value.trim();
      const expYear = document.getElementById("card-exp-year").value.trim();
      const securityCode = document.getElementById("card-cvv").value.trim();
      const brand = document.getElementById("card-brand").value;
      const installments = parseInt(document.getElementById("card-installments").value, 10) || 1;
      const amountCents = 34990;

      if(!name || !email || !cardholderName || !cardNumber || !expMonth || !expYear || !securityCode || !brand){
        throw new Error("Preencha todos os campos obrigatórios.");
      }

      const base = (window.__GETNET_ENV__ === "production" ? "https://api.getnet.com.br" : "https://api-homologacao.getnet.com.br");
      const clientId = window.__GETNET_CLIENT_ID__, clientSecret = window.__GETNET_CLIENT_SECRET__, sellerId = window.__GETNET_SELLER_ID__;
      if (!clientId || !clientSecret || !sellerId) throw new Error("Credenciais da GetNet não configuradas.");

      // 1) OAuth
      const tokenResp = await fetch(base + "/auth/oauth/v2/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Authorization": "Basic " + btoa(clientId + ":" + clientSecret)
        },
        body: new URLSearchParams({ grant_type: "client_credentials", scope: "oob" }).toString(),
      });
      if (!tokenResp.ok) throw new Error("Erro ao obter token ("+tokenResp.status+")");
      const tokenData = await tokenResp.json();
      const accessToken = tokenData.access_token;
      if (!accessToken) throw new Error("Token de acesso não recebido.");

      // 2) Tokenização do cartão
      const tknResp = await fetch(base + "/v1/tokens/card", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + accessToken
        },
        body: JSON.stringify({ card_number: cardNumber, customer_id: email }),
      });
      if (!tknResp.ok) { const tx = await tknResp.text(); throw new Error("Erro ao tokenizar cartão: " + (tx || tknResp.status)); }
      const tknData = await tknResp.json();
      const numberToken = tknData.number_token || tknData.numberToken;
      if (!numberToken) throw new Error("Token do cartão não recebido.");

      // 3) Pagamento
      const orderId = "order_" + Date.now();
      const payload = {
        seller_id: sellerId,
        amount: amountCents,
        currency: "BRL",
        order: { order_id: orderId, sales_tax: 0, product_type: "digital_content" },
        customer: {
          customer_id: email, name, email,
          document_type: (documentNumber && documentNumber.length > 11) ? "CNPJ" : "CPF",
          document_number: documentNumber || undefined,
          phone_number: phoneNumber || undefined,
        },
        credit: {
          delayed: false, authenticated: false, pre_authorization: false, save_card_data: false,
          transaction_type: "FULL", number_installments: installments, soft_descriptor: "LunaAI", dynamic_mcc: 52106184,
          card: {
            number_token: numberToken, cardholder_name: cardholderName, expiration_month: expMonth, expiration_year: expYear,
            brand: brand, security_code: securityCode
          }
        }
      };
      const payResp = await fetch(base + "/v1/payments/credit", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + accessToken },
        body: JSON.stringify(payload),
      });
      if (!payResp.ok) { const tx = await payResp.text(); throw new Error("Erro no pagamento: " + (tx || payResp.status)); }
      const payData = await payResp.json();
      const statusRaw = payData.status || (payData.payment||{}).status || payData.transaction_status;
      const status = String(statusRaw||"").toLowerCase();
      const isPaid = ["approved","authorized","confirmed"].some(s=>status.includes(s));
      hideCardModal();
      alert(isPaid ? "Pagamento aprovado!" : "Pagamento em processamento. Aguarde a confirmação.");
    }catch(e){
      console.error("[getnet] payment failed", e);
      if (err) err.textContent = e?.message || "Erro desconhecido";
    }finally{
      if (btn){ btn.disabled=false; btn.textContent="Pagar"; }
    }
  }

  // Wiring
  document.addEventListener("DOMContentLoaded", function(){
    // Intercepta o clique no botão "Assinar agora" antes do roteador
    const btn = document.getElementById("btn-pay-getnet");
    if (btn){
      // capturar antes do handler de rota
      btn.addEventListener("click", function(e){}, true);
      // impede a navegação e abre o modal
      btn.addEventListener("click", function(e){
        e.preventDefault(); e.stopPropagation();
        showCardModal();
      });
    }
    // Fechar modal
    document.getElementById("btn-card-cancel") && (document.getElementById("btn-card-cancel").onclick = hideCardModal);
    const ov = document.querySelector("#card-modal .modal-overlay");
    if (ov) ov.addEventListener("click", hideCardModal);
    // Submit
    document.getElementById("card-form") && document.getElementById("card-form").addEventListener("submit", submitCardPayment);
  });

  // Expor (opcional)
  window.showCardModal = showCardModal;
})();
