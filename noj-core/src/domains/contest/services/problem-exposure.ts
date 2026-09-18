/**
 * 题目暴露判定：题目当前是否处于「进行中竞赛」的题目集内。
 *
 * 供读路径门控复用：
 * - 题解赛期隐藏（community 域读路径与 search 域索引查询）；
 * - 通过率赛中隐藏（catalog 域公开统计）。
 *
 * **设计取舍（有意为之）**：**不使用缓存、不引入调度任务**。时间窗口实时比较，
 * 竞赛开始/结束无需任何状态翻转动作，因此不新增进程内可变状态
 * （见 `dev-docs/engineering/domain-boundaries.md` 的多副本约束表）。
 *
 * 取数口径与 `contests.ts` 的 `computeContestStatus` 保持一致：
 * `start_time <= now < end_time` 即为 running。
 *
 * **时间比较按「时刻」而非「文本」**：`contests.start_time` / `end_time` 虽为
 * ISO 8601 文本列，但此前按字典序与 `new Date().toISOString()` 比较，对 `+08:00`
 * 形态的合法 ISO 8601 会静默 fail-open（2026-09-14 评审 C1）。现统一改用
 * {@link runningWindowCondition}（`::timestamptz` 比较 + 形态守卫），四处调用点
 * 共用同一份实现。
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./../../../shared/db/connection.ts";
import { contestProblems, contests } from "./../../../shared/db/schema.ts";
import { runningWindowCondition } from "./contest-window.ts";

/**
 * 返回给定题目中，处于进行中竞赛的题目 id 集合。
 *
 * @param problemIds 待判定的题目 id 列表；空列表直接返回空集合（避免空 IN 查询）。
 * @returns 命中"进行中竞赛"的题目 id 集合。
 */
export async function filterProblemsInRunningContest(
  problemIds: string[],
): Promise<Set<string>> {
  if (problemIds.length === 0) return new Set();
  const rows = await getDb()
    .selectDistinct({ problem_id: contestProblems.problem_id })
    .from(contestProblems)
    .innerJoin(contests, eq(contestProblems.contest_id, contests.id))
    .where(and(
      inArray(contestProblems.problem_id, problemIds),
      runningWindowCondition(contests.start_time, contests.end_time),
    ));
  return new Set(rows.map((row) => row.problem_id));
}

/**
 * 单题版本：该题当前是否处于进行中竞赛的题目集内。
 *
 * @param problemId 题目 id。
 * @returns 处于进行中竞赛时为 true。
 */
export async function isProblemInRunningContest(
  problemId: string,
): Promise<boolean> {
  const result = await filterProblemsInRunningContest([problemId]);
  return result.has(problemId);
}
