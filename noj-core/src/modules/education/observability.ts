/** 教学投影观测 provider；projection delay 以已到期但未完成的教学任务等待时长表示。 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { ObservabilityRegistry } from "../../shared/observability/contracts.ts";
import { getDb } from "../../shared/db/connection.ts";
import { backgroundTasks } from "../../shared/db/schema.ts";
import { EDUCATION_TASK_TYPE } from "./contracts/facts.ts";

export function registerEducationObservability(
  registry: ObservabilityRegistry,
): void {
  registry.registerSnapshotProvider({
    name: "education.projection",
    timeoutMs: 500,
    collect: async () => {
      const [row] = await getDb().select({
        pending: sql<number>`count(*)::int`,
        oldest: sql<string | null>`min(${backgroundTasks.available_at})`,
      }).from(backgroundTasks).where(and(
        eq(backgroundTasks.task_type, EDUCATION_TASK_TYPE),
        inArray(backgroundTasks.status, ["pending", "leased"]),
        // 比赛结束前延迟的事件尚未到期，不计入投影延迟。
        sql`${backgroundTasks.available_at} <= ${new Date().toISOString()}`,
      ));
      const oldestMs = row?.oldest ? Date.parse(row.oldest) : NaN;
      return {
        education_projection: {
          pending: Number(row?.pending ?? 0),
          oldest_age_seconds: Number.isFinite(oldestMs)
            ? Math.max(0, (Date.now() - oldestMs) / 1000)
            : 0,
        },
      };
    },
  });
}
