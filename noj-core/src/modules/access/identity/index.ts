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
} from "./services/auth.ts";
export {
  adminUpdateUserProfile,
  banUser,
  clearUserAvatar,
  deleteAvatarIfUnreferenced,
  getLatestActiveBanId,
  getUserAvatarBytes,
  getUserBanHistory,
  MAX_AVATAR_SIZE,
  resolveUserId,
  sameStorageObject,
  searchUsers,
  unbanUser,
  updateUserAvatar,
  updateUserProfile,
} from "./services/users.ts";
export type { BanRecord } from "./services/users.ts";
export {
  callbackUrl,
  consumeOAuthState,
  createOAuthAuthorization,
  fetchOAuthIdentity,
  linkPasswordMatches,
  listLinkedOAuthAccounts,
  listOAuthProviders,
  oauthFrontendRedirect,
  oauthStateCookieName,
  resolveOAuthIdentity,
  unlinkOAuthAccount,
} from "./services/oauth.ts";
export type {
  LinkedOAuthAccount,
  OAuthIdentity,
  OAuthIntent,
  OAuthProviderId,
  OAuthProviderInfo,
} from "./services/oauth.ts";
export {
  confirmTfa,
  disableTfa,
  getTfaStatus,
  regenerateRecoveryCodes,
  setupTfa,
  verifyTfaCodeForUser,
} from "./services/tfa.ts";
export { requestReset, resetPassword } from "./services/passwordReset.ts";
export {
  EMAIL_VERIFICATION_TTL_MINUTES,
  sendEmailVerification,
  verifyEmailToken,
} from "./services/email-verification.ts";
export type { EmailVerificationDispatch } from "./services/email-verification.ts";
export {
  adminDeleteAccount,
  deleteOwnAccount,
} from "./services/account-deletion.ts";
export {
  _resetBanlistForTest,
  addIpBan,
  getBannedIpDetail,
  getBannedRanges,
  initBanlist,
  listIpBans,
  removeIpBan,
} from "./services/banlist.ts";
export type {
  AddIpBanInput,
  IpBan,
  ListIpBansOpts,
  Pagination,
} from "./services/banlist.ts";
export {
  checkIn,
  getCheckinHistory,
  getCheckinLeaderboard,
  getCheckinStats,
  getTodayCheckIn,
} from "./services/checkin.ts";
export type {
  CheckinHistory,
  CheckinLeaderboard,
  CheckinLeaderboardRow,
  CheckInResponse,
  CheckinStats,
} from "./services/checkin.ts";
export {
  ADMIN_FULL_ACCESS,
  assertPermission,
  checkPermission,
  getAdminUserIds,
  getUserPermissions,
  isUserAdmin,
  requireAdmin,
  requirePermission,
  resolvePermissions,
} from "./services/security/permissions.ts";
export {
  assertActiveInstanceAccount,
  assertInstanceAccountNotBanned,
} from "./services/security/account-access.ts";
export { signToken, verifyToken } from "./services/security/jwt.ts";
export type {
  SignTokenOptions,
  TokenPayload,
} from "./services/security/jwt.ts";
export { comparePassword, hashPassword } from "./services/security/password.ts";
export {
  decryptTfaSecret,
  encryptTfaSecret,
  generateRecoveryCodes,
  generateTfaSecret,
  hashRecoveryCode,
  RECOVERY_CODE_COUNT,
  verifyTfaCode,
} from "./services/security/tfa.ts";
export type { TfaSecretResult } from "./services/security/tfa.ts";
export {
  generateResetToken,
  hashResetToken,
} from "./services/security/resetToken.ts";
export {
  isJtiRevoked,
  remainingTtlFromExp,
  revocationTtl,
  revokeJti,
} from "./services/security/revokedTokens.ts";
export {
  _resetLoginBackoffForTest,
  applyLoginBackoff,
  clearLoginFailure,
  isLoginLocked,
  recordLoginBackoff,
  recordLoginFailure,
} from "./services/security/loginThrottle.ts";
export {
  _resetBanCacheForTest,
  getCached,
  invalidateBanCache,
} from "./services/security/banCache.ts";
export {
  adminMiddleware,
  authMiddleware,
  BAN_WHITELIST,
  getUserBanState,
  optionalAuthMiddleware,
  PASSWORD_CHANGE_WHITELIST,
} from "./middleware/auth.ts";
export type {
  AuthEnv,
  OptionalAuthEnv,
  UserBanState,
} from "./middleware/auth.ts";
export {
  checkLoginAccountRateLimit,
  LOGIN_LIMITS,
  loginIpRateLimit,
  resolveLoginAccountKey,
  throwRateLimited,
} from "./middleware/login-rate-limit.ts";
export { banlistMiddleware } from "./middleware/banlist.ts";
export { ROLES } from "./types/auth.ts";
export type {
  AuthTokenResponse,
  ChangePasswordInput,
  ForgotPasswordInput,
  LoginInput,
  RegisterInput,
  ResetPasswordInput,
  Role,
  UserResponse,
} from "./types/auth.ts";
export { PERMISSION_DEFS } from "./types/permissions.ts";
export type { PermissionName } from "./types/permissions.ts";

export {
  initializeFirstAdmin,
  sealExistingSiteAdminInitialization,
} from "./services/auth/admin-initialization.ts";
