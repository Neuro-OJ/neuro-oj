/**
 * 用户服务 barrel 入口。
 *
 * 原单文件 users.ts 已拆分为 users/ 目录：
 * - users-avatar.ts            头像（上传/清理/读取）
 * - users-bans.ts              封禁/解封/封禁历史
 * - users-profile.ts           用户主页聚合 + UserProfileResponse
 * - users-profile-queries.ts   主页聚合查询（内部使用）
 * - users-profile-edit.ts      资料编辑（bio / 管理员改 email+bio）
 * - users-profile-types.ts     主页类型定义
 * - users-search.ts            用户名搜索
 */
export * from "./users/users-avatar.ts";
export * from "./users/users-bans.ts";
export * from "./users/users-profile.ts";
export * from "./users/users-profile-edit.ts";
export * from "./users/users-search.ts";
