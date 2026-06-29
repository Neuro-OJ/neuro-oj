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
 */
export interface UserResponse {
  id: string;
  username: string;
  email: string;
  role: string;
  must_change_password: boolean;
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
