class LunaPainel {
  constructor() {
    this.token = localStorage.getItem("instance_token")
    this.chats = []
    this.filteredChats = []
    this.init()
  }

  init() {
    this.bindEvents()
    this.checkAuth()
  }

  getBackendUrl() {
    const BACKEND = () => (window.__BACKEND_URL__ || "").replace(/\/+$/, "")
    return BACKEND()
  }

  bindEvents() {
    // Login form
    const loginForm = document.getElementById("login-form")
    if (loginForm) {
      loginForm.addEventListener("submit", (e) => this.handleLogin(e))
    }

    // Logout button
    const logoutBtn = document.getElementById("logout-btn")
    if (logoutBtn) {
      logoutBtn.addEventListener("click", () => this.handleLogout())
    }

    // Refresh button
    const refreshBtn = document.getElementById("refresh-btn")
    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => this.loadChats())
    }

    // Search input
    const searchInput = document.getElementById("search-input")
    if (searchInput) {
      searchInput.addEventListener("input", (e) => this.handleSearch(e.target.value))
    }
  }

  checkAuth() {
    if (this.token) {
      this.showMainScreen()
      this.loadChats()
    } else {
      this.showLoginScreen()
    }
  }

  showLoginScreen() {
    document.getElementById("login-screen").style.display = "flex"
    document.getElementById("main-screen").style.display = "none"
  }

  showMainScreen() {
    document.getElementById("login-screen").style.display = "none"
    document.getElementById("main-screen").style.display = "block"
  }

  async handleLogin(e) {
    e.preventDefault()

    const tokenInput = document.getElementById("instance-token")
    const loginBtn = document.querySelector(".login-btn")
    const btnText = document.querySelector(".btn-text")
    const loadingSpinner = document.querySelector(".loading-spinner")
    const errorDiv = document.getElementById("login-error")

    const token = tokenInput.value.trim()

    if (!token) {
      this.showError("Por favor, insira o Instance Token")
      return
    }

    // Show loading state
    loginBtn.disabled = true
    btnText.style.display = "none"
    loadingSpinner.style.display = "block"
    errorDiv.style.display = "none"

    try {
      const response = await fetch(`${this.getBackendUrl()}/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token }),
      })

      if (response.ok) {
        this.token = token
        localStorage.setItem("instance_token", token)
        this.showMainScreen()
        this.loadChats()
      } else {
        const errorData = await response.json().catch(() => ({}))
        this.showError(errorData.message || "Token inválido. Verifique e tente novamente.")
      }
    } catch (error) {
      console.error("Login error:", error)
      this.showError("Erro de conexão. Verifique sua internet e tente novamente.")
    } finally {
      // Reset loading state
      loginBtn.disabled = false
      btnText.style.display = "block"
      loadingSpinner.style.display = "none"
    }
  }

  handleLogout() {
    localStorage.removeItem("instance_token")
    this.token = null
    this.chats = []
    this.showLoginScreen()

    // Clear form
    const tokenInput = document.getElementById("instance-token")
    if (tokenInput) {
      tokenInput.value = ""
    }
  }

  async loadChats() {
    if (!this.token) return

    const loadingDiv = document.getElementById("loading-chats")
    const chatsListDiv = document.getElementById("chats-list")
    const noChatsDiv = document.getElementById("no-chats")

    // Show loading
    loadingDiv.style.display = "block"
    chatsListDiv.style.display = "none"
    noChatsDiv.style.display = "none"

    try {
      const response = await fetch(`${this.getBackendUrl()}/chat/find`, {
        method: "POST",
        headers: {
          token: this.token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          operator: "AND",
          sort: "-wa_lastMsgTimestamp",
          limit: 50,
          offset: 0,
        }),
      })

      if (response.ok) {
        const data = await response.json()
        this.chats = data.items || []
        this.filteredChats = [...this.chats]
        this.renderChats()
      } else {
        if (response.status === 401) {
          this.handleLogout()
          this.showError("Sessão expirada. Faça login novamente.")
        } else {
          throw new Error("Erro ao carregar conversas")
        }
      }
    } catch (error) {
      console.error("Error loading chats:", error)
      this.showError("Erro ao carregar conversas. Tente novamente.")

      // Hide loading and show no chats
      loadingDiv.style.display = "none"
      noChatsDiv.style.display = "block"
    }
  }

  renderChats() {
    const loadingDiv = document.getElementById("loading-chats")
    const chatsListDiv = document.getElementById("chats-list")
    const noChatsDiv = document.getElementById("no-chats")

    loadingDiv.style.display = "none"

    if (this.filteredChats.length === 0) {
      chatsListDiv.style.display = "none"
      noChatsDiv.style.display = "block"
      return
    }

    chatsListDiv.style.display = "block"
    noChatsDiv.style.display = "none"

    chatsListDiv.innerHTML = this.filteredChats
      .map((chat) => {
        const name = chat.wa_name || chat.wa_contactName || "Contato"
        const lastMessage = chat.wa_lastMessageText || "Sem mensagens"
        const hasImage = chat.image || chat.profilePic

        // Generate initials for fallback
        const initials = name
          .split(" ")
          .map((word) => word.charAt(0))
          .join("")
          .substring(0, 2)
          .toUpperCase()

        return `
                <div class="chat-item" data-chat-id="${chat.wa_chatid}">
                    <div class="chat-avatar ${hasImage ? "" : "fallback"}">
                        ${
                          hasImage
                            ? `<img src="${hasImage}" alt="${name}" onerror="this.parentElement.innerHTML='${initials}'; this.parentElement.classList.add('fallback');">`
                            : initials
                        }
                    </div>
                    <div class="chat-info">
                        <div class="chat-name">${this.escapeHtml(name)}</div>
                        <div class="chat-last-message">${this.escapeHtml(lastMessage)}</div>
                    </div>
                </div>
            `
      })
      .join("")

    // Add click events to chat items
    const chatItems = chatsListDiv.querySelectorAll(".chat-item")
    chatItems.forEach((item) => {
      item.addEventListener("click", () => {
        // Remove active class from all items
        chatItems.forEach((i) => i.classList.remove("active"))
        // Add active class to clicked item
        item.classList.add("active")

        // Here you could implement chat opening logic
        console.log("Chat selected:", item.dataset.chatId)
      })
    })
  }

  handleSearch(query) {
    if (!query.trim()) {
      this.filteredChats = [...this.chats]
    } else {
      const searchTerm = query.toLowerCase()
      this.filteredChats = this.chats.filter((chat) => {
        const name = (chat.wa_name || chat.wa_contactName || "").toLowerCase()
        const lastMessage = (chat.wa_lastMessageText || "").toLowerCase()
        return name.includes(searchTerm) || lastMessage.includes(searchTerm)
      })
    }
    this.renderChats()
  }

  showError(message) {
    const errorDiv = document.getElementById("login-error")
    if (errorDiv) {
      errorDiv.textContent = message
      errorDiv.style.display = "block"

      // Auto-hide error after 5 seconds
      setTimeout(() => {
        errorDiv.style.display = "none"
      }, 5000)
    }
  }

  escapeHtml(text) {
    const div = document.createElement("div")
    div.textContent = text
    return div.innerHTML
  }
}

// Initialize the app when DOM is loaded
document.addEventListener("DOMContentLoaded", () => {
  new LunaPainel()
})
