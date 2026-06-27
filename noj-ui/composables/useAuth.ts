interface UserResponse {
  id: string;
  username: string;
  email: string;
  role: string;
  must_change_password: boolean;
  created_at: string;
  updated_at: string;
}

interface SessionData {
  userId: string;
  username: string;
  role: string;
  email: string;
  must_change_password: boolean;
}

function sessionToUser(session: SessionData): UserResponse {
  return {
    id: session.userId,
    username: session.username,
    role: session.role,
    email: session.email,
    must_change_password: session.must_change_password ?? false,
    created_at: '',
    updated_at: '',
  };
}

export function useAuth() {
  const user = useState<UserResponse | null>('auth:user', () => null);
  const loading = useState<boolean>('auth:loading', () => true);

  // 可读 cookie：SSR 时服务端注入、水合后客户端读取（与 HTTP-only token cookie 配合）
  // 不含敏感凭证，仅含基础用户信息
  const session = useCookie<SessionData | null>('noj:session', {
    default: () => null,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24,
  });

  // `token` 不再由客户端管理，Nitro 代理从 HTTP-only cookie 自动注入
  // 保留 isLoggedIn 计算属性简化其他页面的访问
  const isLoggedIn = computed(() => !!user.value);

  // ── SSR 初始化 ──
  if (import.meta.server) {
    if (session.value) {
      user.value = sessionToUser(session.value);
    }
    loading.value = false;
  }

  // ── 客户端初始化 ──
  if (import.meta.client) {
    if (session.value && !user.value) {
      // SSR 未执行（SPA 导航或水合延迟），从 cookie 恢复
      user.value = sessionToUser(session.value);
    }
    loading.value = false;
  }

  async function login(login: string, password: string) {
    const res = await $fetch<{ data: { user: UserResponse } }>(
      '/api/v1/auth/login',
      {
        method: 'POST',
        body: { login, password },
      },
    );
    // token 已由 Nitro 代理设置为 HTTP-only cookie，客户端不接收 token 字段
    const userData = res.data.user;
    user.value = userData;
    return { user: userData };
  }

  async function register(username: string, email: string, password: string) {
    await $fetch('/api/v1/auth/register', {
      method: 'POST',
      body: { username, email, password },
    });
  }

  async function fetchUser() {
    if (!isLoggedIn.value) return null;
    try {
      // Cookie 由浏览器自动携带，Nitro 代理注入 Authorization 头
      // 代理同时会同步更新 noj:session cookie（含 must_change_password）
      const res = await $fetch<{ data: UserResponse }>('/api/v1/auth/me');
      user.value = res.data;
      return res.data;
    } catch {
      await logout();
      return null;
    }
  }

  async function changePassword(oldPassword: string, newPassword: string) {
    // 后端返回更新后的 UserResponse（must_change_password=false）
    const res = await $fetch<{ data: UserResponse }>(
      '/api/v1/auth/change-password',
      {
        method: 'POST',
        body: { old_password: oldPassword, new_password: newPassword },
      },
    );
    // 关键：改密成功后必须清 Cookie（issue #75 评审 H2/H3）
    // 后端旧 JWT 在 24h 内仍带 must_change_password=true，
    // 前端路由守卫看到 JWT 仍会跳回 /change-password 形成死循环。
    // 通过 logout() 清除 noj:token + noj:session，前端守卫将放行到 /login。
    // 调用方（ChangePassword.vue）应负责 navigateTo('/login?reason=password_changed')。
    await logout();
    return res.data;
  }

  async function logout() {
    try {
      await $fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // 即使网络错误也要清除本地状态
    }
    user.value = null;
  }

  return {
    user,
    isLoggedIn,
    loading,
    login,
    register,
    fetchUser,
    changePassword,
    logout,
  };
}
