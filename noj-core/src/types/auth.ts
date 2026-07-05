/**
 * 用户注册请求体。
 */
export interface RegisterInput {
  username: string;
  email: string;
  password: string;
}

/**
 * 用户登录请求体。
 * login 可以是用户名或邮箱地址。
 */
export interface LoginInput {
  login: string;
  password: string;
}

/**
 * 公开的用户信息响应。
 * 不包含 password_hash，用于 API 返回。
 *
 * 包含 must_change_password 字段（issue #75）：前端在登录后据此
 * 决定是否强制跳转 `/change-password` 页面。
 *
 * active_ban 字段（user-ban-table）：当前活跃封禁的 reason/until，
 * 从 user_bans 表计算（unbanned_at IS NULL）。null = 未封禁。
 */
export interface UserResponse {
  id: string;
  username: string;
  email: string;
  role: string;
  must_change_password: boolean;
  active_ban: { reason: string; banned_until: string | null } | null;
  created_at: string;
  updated_at: string;
}

/**
 * 修改密码请求体（issue #75）。
 */
export interface ChangePasswordInput {
  old_password: string;
  new_password: string;
}

/**
 * 登录成功后返回的认证令牌响应。
 */
export interface AuthTokenResponse {
  user: UserResponse;
  token: string;
}

/**
 * 密码重置请求体（issue #49）。
 * 用户输入注册邮箱以发起密码重置流程。
 *
 * 防枚举说明：服务端不区分邮箱是否存在，统一返 200。
 */
export interface ForgotPasswordInput {
  email: string;
}

/**
 * 密码重置执行请求体（issue #49）。
 * token 来自邮件 URL 中的查询参数，new_password 是新密码。
 */
export interface ResetPasswordInput {
  token: string;
  new_password: string;
}
