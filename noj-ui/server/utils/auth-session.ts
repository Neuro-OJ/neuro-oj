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
