/** 教学投影观测 provider；projection delay 以未处理教学事实的年龄表示。 */
import { isNull, sql } from "drizzle-orm";
import type { ObservabilityRegistry } from "../../shared/observability/contracts.ts";
import { getDb } from "../../shared/db/connection.ts";
import { educationOutbox } from "../../shared/db/schema.ts";

export function registerEducationObservability(
  registry: ObservabilityRegistry,
): void {
  registry.registerSnapshotProvider({
    name: "education.projection",
    timeoutMs: 500,
    collect: async () => {
      const [row] = await getDb().select({
        pending: sql<number>`count(*)::int`,
        oldest: sql<string | null>`min(${educationOutbox.created_at})`,
      }).from(educationOutbox).where(isNull(educationOutbox.processed_at));
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
