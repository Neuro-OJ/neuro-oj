/**
 * 有效版本策略的纯判定函数（Handbook §1.2、§4.5）。
 *
 * 这些函数决定「默认作答版本」与「策略/固定版本是否自洽」，被题库读取、
 * 竞赛作答与提交校验共用。它们不碰数据库，便于表驱动测试。
 */

import type { EffectiveVersionMode } from "./types.ts";

/** 策略宿主的策略列（题库 `problems` 与「竞赛×题目」`contest_problems` 同构）。 */
export interface PolicyHostRow {
  effective_version_mode: string;
  required_version_id: string | null;
}

/**
 * 题库默认作答版本（Handbook §1.2）：
 * - `exact` 使用要求版本；
 * - `any` 使用最新版。
 *
 * 返回 `null` 表示该题尚未发布任何版本（普通访问者应视为 404）。
 */
export function resolveDefaultAnswerVersion(host: {
  latest_version_id: string | null;
  effective_version_mode: string;
  required_version_id: string | null;
}): string | null {
  if (host.effective_version_mode === "exact") {
    return host.required_version_id;
  }
  return host.latest_version_id;
}

/**
 * 竞赛默认作答版本：**永远使用该竞赛固定的题目版本**，与有效策略无关
 * （`exact(X)` 时固定版本必须同时为 X，由 CHECK 与服务层共同保证）。
 */
export function resolveContestAnswerVersion(host: {
  pinned_version_id: string | null;
}): string | null {
  return host.pinned_version_id;
}

/** 判断策略列是否需要规范化（`exact` 缺要求版本属于非法形态）。 */
export function isPolicyCoherent(
  mode: EffectiveVersionMode | string,
  requiredVersionId: string | null | undefined,
): boolean {
  if (mode === "any") return requiredVersionId == null;
  if (mode === "exact") return requiredVersionId != null;
  return false;
}
