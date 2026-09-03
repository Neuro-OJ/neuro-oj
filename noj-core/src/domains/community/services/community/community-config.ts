import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "../../../../db/connection.ts";
import { communitySanctions, userBans } from "../../../../db/schema.ts";
import { ForbiddenError } from "./../../../../shared/base/errors.ts";
import { nowIso } from "./../../../../shared/base/dates.ts";
import { getSetting } from "../../../system/index.ts";
import type { CommunityConfig } from "../../../../types/community.ts";

/**
 * 读取布尔型系统设置。
 * @param key 设置键名。
 * @returns 设置值是否为 true。
 */
function settingBoolean(key: string): boolean {
  return getSetting(key)?.value === true;
}

/**
 * 读取数值型系统设置。
 * @param key 设置键名。
 * @returns 数值设置；非有限数值时返回 0。
 */
function settingNumber(key: string): number {
  const value = Number(getSetting(key)?.value);
  return Number.isFinite(value) ? value : 0;
}

/**
 * 汇总读取社区全部配置项，返回 CommunityConfig。
 * @returns 社区配置对象（各功能开关与长度/间隔等数值限制）。
 */
export function getCommunityConfig(): CommunityConfig {
  return {
    enabled: settingBoolean("community_enabled"),
    guest_read_enabled: settingBoolean("community_guest_read_enabled"),
    read_only: settingBoolean("community_read_only"),
    solutions_enabled: settingBoolean("community_solutions_enabled"),
    discussions_enabled: settingBoolean("community_discussions_enabled"),
    moments_enabled: settingBoolean("community_moments_enabled"),
    activities_enabled: settingBoolean("community_activities_enabled"),
    comments_enabled: settingBoolean("community_comments_enabled"),
    reactions_enabled: settingBoolean("community_reactions_enabled"),
    bookmarks_enabled: settingBoolean("community_bookmarks_enabled"),
    follows_enabled: settingBoolean("community_follows_enabled"),
    private_messaging_enabled: settingBoolean("private_messaging_enabled"),
    external_images_enabled: settingBoolean(
      "community_external_images_enabled",
    ),
    solution_requires_accepted: settingBoolean(
      "community_solution_requires_accepted",
    ),
    new_user_review_hours: settingNumber("community_new_user_review_hours"),
    post_max_length: settingNumber("community_post_max_length"),
    moment_max_length: settingNumber("community_moment_max_length"),
    comment_max_length: settingNumber("community_comment_max_length"),
    post_interval_seconds: settingNumber("community_post_interval_seconds"),
  };
}

/**
 * 断言社区（或指定功能）已启用，未启用时抛出 ForbiddenError。
 * @param feature 可选，需要检查的具体功能开关（如 discussions_enabled）。
 * @throws {ForbiddenError} 社区或指定功能关闭时抛出（FEATURE_DISABLED）。
 */
export function assertCommunityEnabled(feature?: keyof CommunityConfig): void {
  const config = getCommunityConfig();
  if (!config.enabled || (feature && config[feature] === false)) {
    throw new ForbiddenError("该社区功能已关闭", "FEATURE_DISABLED");
  }
}

/**
 * 断言当前用户可进行社区写操作：只读模式、平台/社交封禁、社区禁言均会拦截。
 * @param userId 用户 UUID。
 * @param isModerator 是否为审核员（审核员不受只读与封禁限制）。
 * @param opts 可选配置：allowSocialBan 为 true 时放行社交封禁（允许删除/管理自己的内容）。
 * @throws {ForbiddenError} 只读模式、被封禁或被社区禁言时抛出。
 */
export async function assertCommunityWritable(
  userId: string,
  isModerator: boolean,
  opts: { allowSocialBan?: boolean } = {},
): Promise<void> {
  const config = getCommunityConfig();
  if (config.read_only && !isModerator) {
    throw new ForbiddenError("社区当前为只读模式", "COMMUNITY_READ_ONLY");
  }
  if (isModerator) return;
  const db = getDb();
  // 平台封禁或社交封禁都限制社区发布（social 不限制登录/评测，仅在此处拦截社区写操作）
  const banRows = await db.select({
    reason: userBans.reason,
    scope: userBans.scope,
    banned_until: userBans.banned_until,
  }).from(userBans).where(and(
    eq(userBans.user_id, userId),
    isNull(userBans.unbanned_at),
  )).orderBy(desc(userBans.banned_at)).limit(1);
  const ban = banRows[0];
  if (ban && (!ban.banned_until || ban.banned_until > nowIso())) {
    // 社交封禁只限制发布；删除/管理自己的内容仍应允许
    if (ban.scope === "social" && opts.allowSocialBan) {
      // 放行
    } else {
      throw new ForbiddenError(
        ban.scope === "social" ? "你已被限制社区发布" : "账号已被封禁",
        "USER_BANNED",
        { reason: ban.reason, until: ban.banned_until },
      );
    }
  }
  const rows = await db.select().from(communitySanctions).where(and(
    eq(communitySanctions.user_id, userId),
    isNull(communitySanctions.revoked_at),
  )).orderBy(desc(communitySanctions.created_at)).limit(1);
  const sanction = rows[0];
  if (sanction && (!sanction.expires_at || sanction.expires_at > nowIso())) {
    throw new ForbiddenError("你已被限制社区互动", "COMMUNITY_SANCTIONED", {
      reason: sanction.reason,
      until: sanction.expires_at,
    });
  }
}
