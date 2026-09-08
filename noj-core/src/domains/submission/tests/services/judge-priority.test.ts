import { assertEquals } from "jsr:@std/assert@^1";
import { resolveJudgeTaskPriority } from "../../services/submissions/judge-priority.ts";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { contests } from "../../../../shared/db/schema.ts";

const hasDb = true;
const TS = Date.now();

Deno.test({
  name: "judge-priority: rejudge 恒为 low",
  ignore: !hasDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    assertEquals(await resolveJudgeTaskPriority("any", "rejudge"), "low");
  },
});

Deno.test({
  name: "judge-priority: self_test 恒为 medium",
  ignore: !hasDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    assertEquals(await resolveJudgeTaskPriority(null, "self_test"), "medium");
  },
});

Deno.test({
  name: "judge-priority: 无竞赛提交为 medium",
  ignore: !hasDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    assertEquals(await resolveJudgeTaskPriority(null, "submission"), "medium");
  },
});

Deno.test({
  name: "judge-priority: 进行中竞赛为 high，已结束为 medium",
  ignore: !hasDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const runningId = `contest-running-${TS}`;
    const endedId = `contest-ended-${TS}`;
    const now = Date.now();
    await db.insert(contests).values([
      {
        id: runningId,
        public_id: `run-${TS}`,
        title: "running",
        start_time: new Date(now - 1000).toISOString(),
        end_time: new Date(now + 3600000).toISOString(),
        type: "kaggle",
        kind: "public",
        is_public: true,
        created_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString(),
      },
      {
        id: endedId,
        public_id: `end-${TS}`,
        title: "ended",
        start_time: new Date(now - 7200000).toISOString(),
        end_time: new Date(now - 3600000).toISOString(),
        type: "kaggle",
        kind: "public",
        is_public: true,
        created_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString(),
      },
    ]);

    assertEquals(
      await resolveJudgeTaskPriority(runningId, "submission"),
      "high",
    );
    assertEquals(
      await resolveJudgeTaskPriority(endedId, "submission"),
      "medium",
    );
  },
});
