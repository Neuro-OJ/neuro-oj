/**
 * auth 服务模块（barrel 兼容入口）。
 * 拆分自原 services/auth.ts，实现见 ./auth/ 目录：
 * - auth-register.ts  registerUser / validatePasswordStrength / toUserResponse
 * - auth-login.ts     loginUser
 * - auth-password.ts  changePassword
 * - auth-root.ts      ensureRootUser
 * - users.ts          getUserProfile / listUsers
 */
export {
  changePassword,
  ensureRootUser,
  getUserProfile,
  listUsers,
  loginUser,
  MIN_PASSWORD_LENGTH,
  registerUser,
  setPassword,
  toUserResponse,
  validatePasswordStrength,
} from "./auth/auth.ts";
