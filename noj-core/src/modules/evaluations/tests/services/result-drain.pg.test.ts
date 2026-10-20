/** 真实 PostgreSQL 锁屏障验证：已提交结果的派生刷新必须纳入在途排空。 */
import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import { problemExecutionForTest } from "../../../../../tests/helper.ts";
import { createRawClient } from "../../../../../tests/helper/pg-raw-connection.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  problems,
  problemVersions,
  submissions,
} from "../../../../shared/db/schema.ts";
import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import { createAttempt } from "../../services/versioning/attempts.ts";
import { saveEvaluationResult } from "../../services/submissions/submissions-result.ts";

Deno.test({
  name: "result drain: 正式结果提交后仍等待真实榜单刷新完成",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const problemId = "result-drain-problem";
    const versionId = "result-drain-version";
    const submissionId = "result-drain-submission";
    const now = new Date().toISOString();
    await db.insert(problems).values({
      id: problemId,
      domain_id: DEFAULT_DOMAIN_ID,
      owner_id: "0",
      number: 998901,
      title: "结果排空",
      description: "",
      judge_type: "dual",
      created_at: now,
      updated_at: now,
    });
    await db.insert(problemVersions).values({
      id: versionId,
      problem_id: problemId,
      version: 1,
      origin: "published",
      content: { kind: "ai", title: "结果排空" },
      published_at: now,
    });
    await db.update(problems).set({ latest_version_id: versionId }).where(
      eq(problems.id, problemId),
    );
    await db.insert(submissions).values({
      ...await problemExecutionForTest(problemId),
      id: submissionId,
      user_id: "0",
      problem_id: problemId,
      language: "python",
      code: "print(1)",
      submitted_version_id: versionId,
      version_origin: "known",
      status: "pending",
      created_at: now,
    });
    const attempt = await createAttempt({
      source: { kind: "submission", id: submissionId, problem_id: problemId },
      problemVersionId: versionId,
      source_kind: "initial",
    });
    const barrier = createRawClient();
    const observer = createRawClient();
    let processing: ReturnType<typeof saveEvaluationResult> | undefined;
    let settled = false;
    try {
      await barrier`BEGIN`;
      const [owner] = await barrier`SELECT pg_backend_pid() AS pid`;
      // 非并发刷新取得视图排他锁；正式结果事务不访问此视图，仍可正常提交。
      await barrier`REFRESH MATERIALIZED VIEW user_rankings`;
      processing = saveEvaluationResult(
        { kind: "system", purpose: "background_task" },
        {
          evaluation_protocol_version: 2,
          submission_id: submissionId,
          attempt_id: attempt.id,
          problem_version_id: versionId,
          run_id: attempt.id,
          rejudge_seq: attempt.sequence,
          result_kind: "graded",
          status: "finished",
          score: 10000,
          output: "ok",
          details: { cases: [] },
        },
      );
      processing.then(() => settled = true, () => settled = true);
      const deadline = Date.now() + 10_000;
      for (;;) {
        const blocked = await observer`
          SELECT pid FROM pg_stat_activity
          WHERE datname = current_database()
            AND query LIKE 'REFRESH MATERIALIZED VIEW CONCURRENTLY user_rankings%'
            AND wait_event_type = 'Lock'
            AND ${owner.pid} = ANY(pg_blocking_pids(pid))
        `;
        if (blocked.length > 0) break;
        if (Date.now() >= deadline) {
          throw new Error("未观察到榜单刷新进入真实数据库锁等待");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const [committed] = await observer`
        SELECT state, score FROM evaluation_attempts WHERE id = ${attempt.id}
      `;
      assertEquals(
        committed.state,
        "finished",
        "正式判定应已提交并对另一连接可见",
      );
      assertEquals(committed.score, 10000);
      assertEquals(
        settled,
        false,
        "结果处理不得遗漏仍被数据库锁阻塞的派生刷新",
      );
      await barrier`ROLLBACK`;
      assertEquals((await processing).applied, true);
      assertEquals(settled, true);
    } finally {
      await barrier`ROLLBACK`;
      try {
        await processing;
      } finally {
        await Promise.all([barrier.end(), observer.end()]);
      }
    }
  },
});
