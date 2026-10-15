import { eq, type SQL, sql } from "drizzle-orm";
import { unwrapRows } from "../../../../shared/base/sql-rows.ts";
import { communityPosts, users } from "./../../../../shared/db/schema.ts";
import {
  ForbiddenError,
  NotFoundError,
} from "./../../../../shared/base/errors.ts";
import { resolveProblemIdOrNull } from "./../../../catalog/index.ts";
import {
  endedWindowCondition,
  hasUnendedPublicContest,
  unendedPublicContestForProblem,
} from "./../../../contest/index.ts";
import type {
  CommunityConfig,
  CommunityPostStatus,
  CommunityPostType,
} from "./../../types/community.ts";
import { getCommunityConfig } from "./community-config.ts";
import {
  communityDb,
  communityDomainId,
  type CommunityScope,
} from "./community-scope.ts";

/**
 * 赛时社区全局静默（决策 1 · 方案 A · N-01）的单一入口。
 *
 * 公开赛未结束（含 pending 筹备期）时，普通用户禁止一切可向全场广播文本的社区写入：
 * 新建与编辑讨论/动态/题解、发表评论、编辑评论。此前只拦了新建讨论/动态，
 * 评论与编辑旧帖仍可向全场广播完整解法。审核员免静默，用于官方说明与治理。
 *
 * @param moderator 是否为审核员。
 * @throws {ForbiddenError} 存在未结束公开赛且非审核员时抛出（code=CONTEST_SILENCE）。
 */
export async function assertNotContestSilenced(
  moderator: boolean,
  scope?: CommunityScope,
): Promise<void> {
  if (moderator) return;
  if (
    await hasUnendedPublicContest(communityDomainId(scope), communityDb(scope))
  ) {
    throw new ForbiddenError(
      "比赛期间当前域暂停公开发布讨论、动态、题解与评论，参赛提问请使用赛中答疑",
      "CONTEST_SILENCE",
    );
  }
}

/**
 * 根据帖子类型返回对应的功能开关配置项。
 * @param type 帖子类型：solution / discussion / moment。
 * @returns 对应的 CommunityConfig 功能开关键。
 */
export function featureForType(type: CommunityPostType): keyof CommunityConfig {
  return type === "solution"
    ? "solutions_enabled"
    : type === "discussion"
    ? "discussions_enabled"
    : "moments_enabled";
}

/**
 * 计算用户的发布状态：新用户审核期（new_user_review_hours）内返回 pending，否则 published。
 * @param authorId 作者用户 UUID。
 * @returns 发布状态：pending 或 published。
 * @throws {NotFoundError} 用户不存在时抛出。
 */
export async function publicationStatus(
  authorId: string,
  scope?: CommunityScope,
): Promise<CommunityPostStatus> {
  const reviewHours = getCommunityConfig().new_user_review_hours;
  if (reviewHours <= 0) return "published";
  const db = communityDb(scope);
  const row = await db.select({ created_at: users.created_at }).from(users)
    .where(eq(users.id, authorId)).limit(1);
  if (!row[0]) throw new NotFoundError("用户不存在");
  return Date.parse(row[0].created_at) + reviewHours * 3600_000 > Date.now()
    ? "pending"
    : "published";
}

/**
 * 解析题目引用为 problems.id（UUID）。
 * 支持 UUID、display_id（P1001 / U42）、纯数字（兼容旧 seed 数据 1001/1002/1003）。
 * 题目不存在时返回 null。
 */
export function resolveProblemId(
  reference: string,
): Promise<string | null> {
  return resolveProblemIdOrNull(reference);
}

/**
 * 查询用户是否已通过指定题目（题解门槛与发布入口共用）。
 *
 * 版本化后读**有效成绩投影** `is_accepted`：它由唯一投影服务按当前
 * 有效版本策略维护，覆盖历史版本、精确版本策略与升级提交；存量由迁移 0103 回填，
 * 口径与旧「finished 且 score>0」一致（OI 仍按 verdict=AC）。
 *
 * **两类正式提交统一**（Handbook §3.4/§6.6，缺陷 #51）：代码提交与**客观题**
 * 提交共用同一通过口径（客观题满分即通过）。修复前只查 `submissions`，仅通过
 * 客观题的用户无法满足题解门槛，与个人资料/全局排行的口径不一致。
 */
export async function hasAcceptedSolution(
  authorId: string,
  problemId: string,
  scope?: CommunityScope,
): Promise<boolean> {
  const db = communityDb(scope);
  const rows = await db.execute(sql`SELECT 1 FROM (
      SELECT id FROM submissions WHERE user_id = ${authorId} AND problem_id = ${problemId}
        AND coalesce(domain_id, ${communityDomainId()}) = ${
    communityDomainId(scope)
  } AND is_accepted = true
        AND (contest_id IS NULL OR EXISTS (SELECT 1 FROM contests visible_contest
          WHERE visible_contest.id = submissions.contest_id AND ${
    endedWindowCondition(sql`visible_contest.end_time`)
  }))
      UNION ALL
      SELECT id FROM objective_submissions WHERE user_id = ${authorId} AND paper_id = ${problemId}
        AND coalesce(domain_id, ${communityDomainId()}) = ${
    communityDomainId(scope)
  } AND is_accepted = true
        AND (contest_id IS NULL OR EXISTS (SELECT 1 FROM contests visible_contest
          WHERE visible_contest.id = objective_submissions.contest_id AND ${
    endedWindowCondition(sql`visible_contest.end_time`)
  }))
    ) accepted LIMIT 1`);
  return unwrapRows(rows as never).length > 0;
}

/**
 * 公开赛保密读取门控谓词：排除「所属题目归属于尚未结束的公开赛」的**题解与讨论帖**。
 *
 * 采用**相关子查询**而非「先查题目 id 再拼 IN 列表」：
 * - 不产生应用侧扫描，不受题量规模影响（IN 列表方案必须设上限，
 *   上限一旦被超出就会**静默漏掉**应门控的题目——对安全门控这是不可接受的失效模式）；
 * - 时间窗口在 SQL 内实时比较，竞赛结束后自动放行，无需调度任务。
 *
 * 判定**不在本文件内手写**：委托 contest 域的权威谓词
 * `unendedPublicContestForProblem`（审计 §4.1 单一真相源）。此前的实现在两处发生
 * 口径漂移（2026-09-28 审计 VULN-02）：
 * 1. 只覆盖 `type = 'solution'`，**漏掉 `discussion`**；
 * 2. 只查 `running` 窗口（`start <= now < end`），于是公开赛**赛前筹备期
 *    （pending，已挂题但未开赛）完全放行**——正是最需要保密的阶段。
 *
 * @returns 可直接 push 进 drizzle conditions 数组的 SQL 片段。
 */
export function notGatedContestContent(scope?: CommunityScope): SQL {
  return sql`NOT (
    ${communityPosts.type} IN ('solution', 'discussion')
    AND ${communityPosts.problem_id} IS NOT NULL
    AND ${
    unendedPublicContestForProblem(
      communityPosts.problem_id,
      sql`${communityDomainId(scope)}`,
    )
  }
  )`;
}
