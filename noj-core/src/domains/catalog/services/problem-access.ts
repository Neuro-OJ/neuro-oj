/**
 * 统一题目访问解析器（2026-09-05 竞赛防作弊整改）。
 *
 * 读路径与提交路径共用的单一判定点：
 * - admin → 放行（mode="admin"）
 * - 题目 owner → 放行（mode="owner"）
 * - 携带竞赛上下文（contestAccess 非 null）→ 只信上下文判定，
 *   不回退 public 判定（防伪造 contestId 或赛前/非参赛状态穿越）
 * - 关联到**尚未结束的公开赛**（secrecy 非空）→ 拒绝（mode="contest-secret"），
 *   赛前与赛中对非 owner/管理员按"不存在"处理，`end_time` 过后自动失效
 * - 无上下文 → 仅 public 题放行（mode="public"），否则拒绝
 *
 * 纯函数，无 DB 依赖；竞赛窗口/成员判定由 contest 域
 * `verifyContestAccess` 完成后以 `ContestAccessInfo` 传入，
 * 公开赛保密事实由 contest 域 `loadPublicContestSecrecy` 取得
 * （取数+判定入口见 `problem-access-check.ts`）。
 */

import type { ContestAccessInfo } from "./contest-access-info.ts";

export type { ContestAccessInfo };

/** 访问判定结果：allowed=false 时 mode 说明拒绝原因。 */
export type ProblemAccessResult = {
  allowed: boolean;
  mode: "admin" | "owner" | "contest" | "public" | "contest-secret" | "denied";
};

/** resolver 输入的题目最小字段集。 */
export type ProblemAccessInput = {
  id: string;
  visibility: string;
  owner_id: string;
};

/**
 * 公开赛保密事实（由 contest 域 `loadPublicContestSecrecy` 产出）。
 *
 * `contestIds` 非空表示该题目被至少一场**尚未结束的公开赛**收编；
 * 空数组/未传表示不受保密约束（判定退回 visibility）。
 */
export type ProblemSecrecyInfo = {
  /** 关联的、尚未结束的公开赛竞赛 id */
  contestIds: readonly string[];
};

/** resolver 输入的查看者上下文。 */
export type ProblemAccessContext = {
  /** 查看者用户 ID；匿名传 null */
  viewerId: string | null;
  /** 是否管理员（admin:full_access） */
  isAdmin: boolean;
  /** 竞赛上下文判定结果；无竞赛场景传 null/缺省 */
  contestAccess?: ContestAccessInfo | null;
  /** 公开赛保密事实；无关联场景传 null/缺省 */
  secrecy?: ProblemSecrecyInfo | null;
};

/**
 * 判定查看者可否访问某题目。
 *
 * 判定顺序：admin → owner → 竞赛上下文（不回退）→ 公开赛保密 → visibility。
 *
 * 保密判定置于竞赛上下文**之后**：`contestAccess.allowed` 已由 contest 域证明
 * "该用户是这场竞赛的参赛者、这道题属于这场竞赛、且窗口为 running/ended"，
 * 因此持有有效上下文的参赛者仍可从竞赛路径访问（客观题套卷的
 * `GET /:id/questions?contest_id=` 依赖这一点）；独立路径不携带上下文，
 * 因而对参赛者也返回"不存在"。
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
  if (ctx.secrecy && ctx.secrecy.contestIds.length > 0) {
    // 关联到尚未结束的公开赛：对外一律"不存在"（404），保护题面/评测数据等内容。
    // 注：题库列表不排除该题，故存在性本身不保密，遮蔽的是内容与访问能力。
    return { allowed: false, mode: "contest-secret" };
  }
  return problem.visibility === "public"
    ? { allowed: true, mode: "public" }
    : { allowed: false, mode: "denied" };
}
