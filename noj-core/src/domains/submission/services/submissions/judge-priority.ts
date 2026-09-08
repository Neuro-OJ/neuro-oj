import { eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import { contests } from "../../../../shared/db/schema.ts";
import { computeContestStatus } from "../../../contest/index.ts";
import type { JudgeTaskPriority } from "../../types/index.ts";

/** 评测任务来源，用于服务端推导优先级。 */
export type JudgeTaskSource = "submission" | "self_test" | "rejudge";

/**
 * 服务端推导评测任务优先级。
 *
 * - rejudge 恒为 low；
 * - self_test 恒为 medium；
 * - submission 无竞赛或竞赛非进行中为 medium，属于进行中竞赛为 high。
 */
export async function resolveJudgeTaskPriority(
  contestId: string | null,
  source: JudgeTaskSource,
): Promise<JudgeTaskPriority> {
  if (source === "rejudge") return "low";
  if (source === "self_test") return "medium";
  if (!contestId) return "medium";

  const [contest] = await getDb()
    .select({ start_time: contests.start_time, end_time: contests.end_time })
    .from(contests)
    .where(eq(contests.id, contestId))
    .limit(1);
  if (!contest) return "medium";

  return computeContestStatus(contest.start_time, contest.end_time) ===
      "running"
    ? "high"
    : "medium";
}
