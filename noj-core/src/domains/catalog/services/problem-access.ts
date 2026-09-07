/**
 * 统一题目访问解析器（2026-09-05 竞赛防作弊整改）。
 *
 * 读路径与提交路径共用的单一判定点：
 * - admin → 放行（mode="admin"）
 * - 题目 owner → 放行（mode="owner"）
 * - 携带竞赛上下文（contestAccess 非 null）→ 只信上下文判定，
 *   不回退 public 判定（防伪造 contestId 或赛前/非参赛状态穿越）
 * - 无上下文 → 仅 public 题放行（mode="public"），否则拒绝
 *
 * 纯函数，无 DB 依赖；竞赛窗口/成员判定由 contest 域
 * `verifyContestAccess` 完成后以 `ContestAccessInfo` 传入。
 */

import type { ContestAccessInfo } from "./contest-access-info.ts";

export type { ContestAccessInfo };

/** 访问判定结果：allowed=false 时 mode 说明拒绝原因。 */
export type ProblemAccessResult = {
  allowed: boolean;
  mode: "admin" | "owner" | "contest" | "public" | "denied";
};

/** resolver 输入的题目最小字段集。 */
export type ProblemAccessInput = {
  id: string;
  visibility: string;
  owner_id: string;
};

/** resolver 输入的查看者上下文。 */
export type ProblemAccessContext = {
  /** 查看者用户 ID；匿名传 null */
  viewerId: string | null;
  /** 是否管理员（admin:full_access） */
  isAdmin: boolean;
  /** 竞赛上下文判定结果；无竞赛场景传 null/缺省 */
  contestAccess?: ContestAccessInfo | null;
};

/**
 * 判定查看者可否访问某题目。
 *
 * 判定顺序：admin → owner → 竞赛上下文（不回退）→ visibility。
 */
export function resolveProblemAccess(
  problem: ProblemAccessInput,
  ctx: ProblemAccessContext,
): ProblemAccessResult {
  if (ctx.isAdmin) return { allowed: true, mode: "admin" };
  if (ctx.viewerId !== null && ctx.viewerId === problem.owner_id) {
    return { allowed: true, mode: "owner" };
  }
  if (ctx.contestAccess) {
    // 携带竞赛上下文：只认上下文判定，不回退 public（防伪造 context）
    return ctx.contestAccess.allowed
      ? { allowed: true, mode: "contest" }
      : { allowed: false, mode: "denied" };
  }
  return problem.visibility === "public"
    ? { allowed: true, mode: "public" }
    : { allowed: false, mode: "denied" };
}
