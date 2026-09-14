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
 * 注意 `contests.start_time` / `end_time` 是 ISO 8601 **文本**列，
 * 与 `new Date().toISOString()` 同格式，故字典序比较等价于时间先后比较。
 */
import { and, eq, gt, inArray, lte } from "drizzle-orm";
import { getDb } from "./../../../shared/db/connection.ts";
import { contestProblems, contests } from "./../../../shared/db/schema.ts";

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
  const nowIso = new Date().toISOString();
  const rows = await getDb()
    .selectDistinct({ problem_id: contestProblems.problem_id })
    .from(contestProblems)
    .innerJoin(contests, eq(contestProblems.contest_id, contests.id))
    .where(and(
      inArray(contestProblems.problem_id, problemIds),
      lte(contests.start_time, nowIso),
      gt(contests.end_time, nowIso),
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
