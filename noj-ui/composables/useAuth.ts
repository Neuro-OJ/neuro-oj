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
    // 5s 超时（评审修复 L2，与 fetchUser 一致）
    const res = await Promise.race([
      $fetch<{ data: { user: UserResponse } }>(
        '/api/v1/auth/login',
        {
          method: 'POST',
          body: { login, password },
        },
      ),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('login timeout')), 5000)),
    ]);
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

  /**
   * 发起密码重置请求（issue #49）。
   * 邮箱是否存在对前端透明：服务端统一返 200 + 同一消息（防枚举）。
   */
  async function forgotPassword(email: string) {
    await $fetch('/api/v1/auth/forgot-password', {
      method: 'POST',
      body: { email },
    });
  }

  /**
   * 执行密码重置（issue #49）。
   * @throws 令牌无效/过期/已用/弱密码时抛出错误（含后端 error 消息）
   */
  async function resetPassword(token: string, newPassword: string) {
    await $fetch('/api/v1/auth/reset-password', {
      method: 'POST',
      body: { token, new_password: newPassword },
    });
  }

  async function fetchUser() {
    if (!isLoggedIn.value) return null;
    try {
      // 5s 超时（评审修复 L2，与 middleware/auth.ts fetchUser 一致）
      const res = await Promise.race([
        $fetch<{ data: UserResponse }>('/api/v1/auth/me'),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('fetchUser timeout')), 5000)),
      ]);
      user.value = res.data;
      return res.data;
    } catch {
      await logout();
      return null;
    }
  }

  async function changePassword(oldPassword: string, newPassword: string) {
    // 后端在改密成功后：
    //   1. 撤销旧 token 的 jti（写入 Redis 黑名单）
    //   2. 签发新 token
    //   3. 返回 { user, token }
    // Nitro 代理同步用新 token 替换 noj:token Cookie（user.must_change_password=false）。
    // 因此前端**不再需要** logout()+重登——直接更新本地 user 状态即可。
    const res = await $fetch<{ data: { user: UserResponse } }>(
      '/api/v1/auth/change-password',
      {
        method: 'POST',
        body: { old_password: oldPassword, new_password: newPassword },
      },
    );
    // 同步本地状态：must_change_password 现在是 false，前端路由守卫放行。
    user.value = res.data.user;
    return res.data.user;
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
    forgotPassword,
    resetPassword,
  };
}
