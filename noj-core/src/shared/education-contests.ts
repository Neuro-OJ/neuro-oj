import { and, isNull, sql } from "drizzle-orm";
import type { Executor } from "./db/executor.ts";
import { educationOutbox } from "./db/schema.ts";
import { unwrapRows } from "./base/sql-rows.ts";
import { recordEducationEvent } from "./education-events.ts";

/** 比赛时间调整重排未消费的到期事件，并使已派生的本域题目进度重新计算。 */
export async function rescheduleContestEducation(
  executor: Executor,
  contestId: string,
  endTime: string,
) {
  await executor.update(educationOutbox).set({ available_at: endTime }).where(
    and(
      isNull(educationOutbox.processed_at),
      sql`${educationOutbox.payload}->>'contest_id' = ${contestId}`,
      sql`${educationOutbox.payload}->>'_invalidate_on_claim' = 'true'`,
    ),
  );
  const rows = unwrapRows<{ domain_id: string; problem_id: string }>(
    await executor.execute(sql`
    SELECT DISTINCT domain_id, problem_id FROM (
      SELECT domain_id, problem_id FROM submissions WHERE contest_id = ${contestId}
      UNION ALL SELECT domain_id, paper_id FROM objective_submissions WHERE contest_id = ${contestId}
    ) affected WHERE domain_id IS NOT NULL ORDER BY domain_id, problem_id`) as never,
  );
  for (const row of rows) {
    const event = {
      ...row,
      event_type: "problem.changed" as const,
      payload: { contest_id: contestId },
    };
    await recordEducationEvent(executor, event);
    if (endTime > new Date().toISOString()) {
      await recordEducationEvent(executor, event, { availableAt: endTime });
    }
  }
}
