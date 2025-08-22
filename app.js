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
      const response = await fetch(`${this.getBackendUrl()}/instance/connect`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ instance_token: token }),
      })

      if (response.ok) {
        const responseData = await response.json()
        const sessionToken = responseData.token || responseData.session_token || token
        this.token = sessionToken
        localStorage.setItem("instance_token", sessionToken)
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
      const response = await fetch(`${this.getBackendUrl()}/chats`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
      })

      if (response.ok) {
        const data = await response.json()
        this.chats = Array.isArray(data) ? data : data.chats || data.items || []
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
        const name = chat.name || chat.wa_name || chat.wa_contactName || chat.contact?.name || "Contato"
        const lastMessage = chat.lastMessage?.text || chat.wa_lastMessageText || "Sem mensagens"
        const hasImage = chat.profilePic || chat.image || chat.contact?.profilePic
        const timestamp = chat.lastMessage?.timestamp || chat.wa_lastMsgTimestamp
        const unreadCount = chat.unreadCount || chat.unread || 0

        // Generate initials for fallback
        const initials = name
          .split(" ")
          .map((word) => word.charAt(0))
          .join("")
          .substring(0, 2)
          .toUpperCase()

        // Format timestamp
        const timeStr = timestamp ? this.formatTime(timestamp) : ""

        return `
                <div class="chat-item" data-chat-id="${chat.id || chat.wa_chatid || chat.chatId}">
                    <div class="chat-avatar ${hasImage ? "" : "fallback"}">
                        ${
                          hasImage
                            ? `<img src="${hasImage}" alt="${name}" onerror="this.parentElement.innerHTML='${initials}'; this.parentElement.classList.add('fallback');">`
                            : initials
                        }
                    </div>
                    <div class="chat-info">
                        <div class="chat-header">
                            <div class="chat-name">${this.escapeHtml(name)}</div>
                            ${timeStr ? `<div class="chat-time">${timeStr}</div>` : ""}
                        </div>
                        <div class="chat-footer">
                            <div class="chat-last-message">${this.escapeHtml(lastMessage)}</div>
                            ${unreadCount > 0 ? `<div class="unread-badge">${unreadCount}</div>` : ""}
                        </div>
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

  formatTime(timestamp) {
    try {
      const date = new Date(timestamp * 1000) // Convert from seconds to milliseconds if needed
      const now = new Date()
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      const messageDate = new Date(date.getFullYear(), date.getMonth(), date.getDate())

      if (messageDate.getTime() === today.getTime()) {
        // Today - show time
        return date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
      } else {
        // Other days - show date
        return date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })
      }
    } catch (error) {
      return ""
    }
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
