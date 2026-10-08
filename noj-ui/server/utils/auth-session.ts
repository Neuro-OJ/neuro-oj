/**
 * 认证代理响应中的最小用户结构。
 *
 * 该类型只描述代理写入 session Cookie 所需的字段；实际响应仍需经过
 * `parseAuthSession` 的运行时校验，不能依赖 TypeScript 类型断言。
 */
export interface AuthSessionUser {
  id: string;
  username: string;
  /** 旧版 API 的展示字段；核心 UserResponse 当前不返回该字段。 */
  role?: string;
  email: string;
  /** 用户头像存储地址；null 表示用户明确没有自定义头像。 */
  avatar_url?: string | null;
  must_change_password?: boolean;
  email_verified?: boolean;
  has_local_password?: boolean;
  tfa_enabled?: boolean;
  /** 核心 API 按 admin:full_access 权限实时计算的管理员标记。 */
  is_admin: boolean;
}

export interface AuthSession {
  token: string;
  user: AuthSessionUser;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean';
}

function isOptionalStringOrNull(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string';
}

/**
 * 校验登录/改密成功响应是否包含代理写 Cookie 所需的 token 与 user。
 * 缺失或类型不符时返回 null，让调用方按上游响应格式异常处理。
 */
export function parseAuthSession(data: unknown): AuthSession | null {
  if (!isRecord(data) || !isRecord(data.data)) return null;

  const token = data.data.token;
  const rawUser = data.data.user;
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    !isRecord(rawUser) ||
    typeof rawUser.id !== 'string' ||
    typeof rawUser.username !== 'string' ||
    typeof rawUser.email !== 'string' ||
    typeof rawUser.is_admin !== 'boolean' ||
    !isOptionalStringOrNull(rawUser.avatar_url) ||
    !isOptionalBoolean(rawUser.must_change_password) ||
    !isOptionalBoolean(rawUser.email_verified) ||
    !isOptionalBoolean(rawUser.has_local_password) ||
    !isOptionalBoolean(rawUser.tfa_enabled)
  ) {
    return null;
  }

  const rawRole = rawUser.role;
  if (rawRole !== undefined && typeof rawRole !== 'string') return null;
  const role = typeof rawRole === 'string' ? rawRole : undefined;

  return {
    token,
    user: {
      id: rawUser.id,
      username: rawUser.username,
      ...(role === undefined ? {} : { role }),
      email: rawUser.email,
      ...(rawUser.avatar_url === undefined ? {} : { avatar_url: rawUser.avatar_url }),
      must_change_password: rawUser.must_change_password,
      ...(rawUser.email_verified === undefined ? {} : { email_verified: rawUser.email_verified }),
      ...(rawUser.has_local_password === undefined ? {} : { has_local_password: rawUser.has_local_password }),
      tfa_enabled: rawUser.tfa_enabled,
      is_admin: rawUser.is_admin,
    },
  };
}

/** 无法解析 JWT exp 时的 Cookie 有效期回退值（与后端 jwt_expires_in 默认值一致）。 */
const FALLBACK_COOKIE_MAX_AGE = 60 * 60 * 24;

/**
 * 按 JWT 的 exp 计算 Cookie maxAge（秒），使 Cookie 与 token 同时过期。
 *
 * token 来自受信的 noj-core 上游响应，这里只解码 payload 读取 exp，不做签名校验
 * （鉴权仍由后端完成）。exp 缺失或解析失败时回退 24h；已过期返回 0。
 * 「记住我」登录的 token 有效期更长，Cookie 随之延长，避免 Cookie 先于 token 失效。
 */
export function cookieMaxAgeFromJwt(
  token: string,
  nowMs: number = Date.now(),
): number {
  try {
    const segment = token.split('.')[1];
    if (!segment) return FALLBACK_COOKIE_MAX_AGE;
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const payload: unknown = JSON.parse(atob(base64));
    if (!isRecord(payload) || typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
      return FALLBACK_COOKIE_MAX_AGE;
    }
    return Math.max(0, Math.floor(payload.exp - nowMs / 1000));
  } catch {
    return FALLBACK_COOKIE_MAX_AGE;
  }
}
