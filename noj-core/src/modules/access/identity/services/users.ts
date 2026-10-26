/**
 * 用户服务 barrel 入口。
 *
 * 原单文件 users.ts 已拆分为 users/ 目录：
 * - users-avatar.ts            头像（上传/清理/读取）
 * - users-bans.ts              封禁/解封/封禁历史
 * - users-profile-edit.ts      资料编辑（bio / 管理员改 email+bio）
 * - users-search.ts            用户名搜索
 */
export {
  clearUserAvatar,
  deleteAvatarIfUnreferenced,
  getUserAvatarBytes,
  MAX_AVATAR_SIZE,
  sameStorageObject,
  updateUserAvatar,
} from "./users/users-avatar.ts";
export {
  banUser,
  getLatestActiveBanId,
  getUserBanHistory,
  unbanUser,
} from "./users/users-bans.ts";
export type { BanRecord } from "./users/users-bans.ts";
export { resolveUserId } from "./users/users-id.ts";
export {
  adminUpdateUserProfile,
  updateUserProfile,
} from "./users/users-profile-edit.ts";
export { searchUsers } from "./users/users-search.ts";
