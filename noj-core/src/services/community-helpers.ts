/**
 * community 跨子域共享工具与常量。
 *
 * 当前所有跨子域 helper 已归属此处（详见 docs/superpowers/specs/
 * 2026-08-09-community-service-split-design.md §3 决策 4）。本文件保留为未来
 * 跨子域共享常量与工具函数的归属位，避免新 helper 出现时反复决策子域归属。
 */

import type { CommunityConfig, CommunityPostType } from "../types/community.ts";

/**
 * 将帖子类型映射到对应的功能开关键。被 config 与 content 子域共同调用。
 */
export function featureForType(
  type: CommunityPostType,
): keyof CommunityConfig {
  return type === "solution"
    ? "solutions_enabled"
    : type === "discussion"
    ? "discussions_enabled"
    : "moments_enabled";
}
