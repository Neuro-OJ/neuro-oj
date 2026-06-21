interface UserResponse {
  id: string
  username: string
  email: string
  role: string
  created_at: string
  updated_at: string
}

interface AuthResponse {
  data: {
    user: UserResponse
    token: string
  }
}

export function useAuth() {
  const user = useState<UserResponse | null>("auth:user", () => null)
  const token = useState<string | null>("auth:token", () => null)
  const loading = useState<boolean>("auth:loading", () => true)

  const isLoggedIn = computed(() => !!token.value && !!user.value)

  if (import.meta.client) {
    const saved = localStorage.getItem("noj:token")
    if (saved) {
      token.value = saved
      fetchUser().finally(() => {
        loading.value = false
      })
    } else {
      loading.value = false
    }
  } else {
    // SSR — 标记为就绪
    loading.value = false
  }

  async function login(login: string, password: string) {
    const res = await $fetch<AuthResponse>("/api/v1/auth/login", {
      method: "POST",
      body: { login, password },
    })
    const { user: userData, token: tokenValue } = res.data
    token.value = tokenValue
    user.value = userData
    if (import.meta.client) {
      localStorage.setItem("noj:token", tokenValue)
    }
    return res.data
  }

  async function register(username: string, email: string, password: string) {
    await $fetch("/api/v1/auth/register", {
      method: "POST",
      body: { username, email, password },
    })
  }

  async function fetchUser() {
    if (!token.value) return null
    try {
      const res = await $fetch<{ data: UserResponse }>("/api/v1/auth/me", {
        headers: { Authorization: `Bearer ${token.value}` },
      })
      user.value = res.data
      return res.data
    } catch {
      logout()
      return null
    }
  }

  function logout() {
    user.value = null
    token.value = null
    if (import.meta.client) {
      localStorage.removeItem("noj:token")
    }
  }

  return { user, token, isLoggedIn, loading, login, register, fetchUser, logout }
}
