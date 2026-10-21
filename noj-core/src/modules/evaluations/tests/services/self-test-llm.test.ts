import { assert, assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import {
  domainLlmSettings,
  llmTokenRevocations,
  problems,
  selfTests,
  users,
} from "../../../../shared/db/schema.ts";
import {
  getRedis,
  resetRedisForTest,
} from "../../../../shared/mq/connection.ts";
import { _resetSystemSettingsForTest } from "../../../platform/system/index.ts";
import { publishBaselineVersionForTest } from "../../../../../tests/helper.ts";
import {
  addDomainMember,
  DEFAULT_DOMAIN_ID,
  ensureDefaultWorkspace,
} from "../../../access/workspace/index.ts";
import { startFakeRedis } from "../mq/_setup.ts";
import { rebuildPendingTask } from "../../mq/pending-recovery.ts";
import { recoverPendingSelfTests } from "../../mq/sweeper.ts";
import {
  cancelSelfTest,
  createSelfTest,
  saveSelfTestResult,
} from "../../services/self-tests.ts";
import type { JudgeResult } from "../../types/index.ts";

await resetDbForTest();

Deno.test({
  name: "LLM 自测：首次派发携带凭据、恢复冻结配置、终态持久化吊销",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fake = startFakeRedis();
    const names = [
      "REDIS_URL",
      "NOJ_LLM_DEFAULT_PROVIDER_ID",
      "NOJ_LLM_DEFAULT_MODEL",
      "NOJ_LLM_SERVICE_TOKEN",
      "NOJ_LLM_GATEWAY_URL",
    ];
    const previous = names.map((key) => [key, Deno.env.get(key)] as const);
    const originalFetch = globalThis.fetch;
    const now = new Date().toISOString();
    const userId = crypto.randomUUID();
    const problemId = crypto.randomUUID();
    const db = getDb();
    try {
      resetRedisForTest();
      Deno.env.set("REDIS_URL", fake.url);
      Deno.env.set("NOJ_LLM_DEFAULT_PROVIDER_ID", "self-test-provider");
      Deno.env.set("NOJ_LLM_DEFAULT_MODEL", "self-test-model");
      Deno.env.set(
        "NOJ_LLM_SERVICE_TOKEN",
        "test-service-token-0123456789abcdef",
      );
      Deno.env.set("NOJ_LLM_GATEWAY_URL", "http://llm-gateway.test");
      _resetSystemSettingsForTest();
      globalThis.fetch = ((input: Request | URL | string) => {
        const path = new URL(String(input)).pathname;
        const data = path.endsWith("/internal/execution-config")
          ? {
            provider_id: "self-test-provider",
            models: [{ alias: "default", model: "self-test-model" }],
          }
          : {
            domain_id: DEFAULT_DOMAIN_ID,
            revision: 1,
            id: "self-test-provider",
            name: "test",
            base_url: "http://provider.test",
            cost_per_1k_tokens: 0,
            api_key_masked: "sk-****",
            enabled: true,
            created_at: now,
            updated_at: now,
          };
        return Promise.resolve(
          new Response(JSON.stringify({ data }), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      }) as typeof fetch;
      await getRedis().connect();
      await db.insert(users).values({
        id: userId,
        username: `self-test-llm-${userId}`,
        email: `${userId}@test.noj`,
        password_hash: "hash",
        created_at: now,
        updated_at: now,
      });
      await ensureDefaultWorkspace(db);
      await addDomainMember(db, DEFAULT_DOMAIN_ID, userId);
      await db.insert(domainLlmSettings).values({
        domain_id: DEFAULT_DOMAIN_ID,
        provider_id: "self-test-provider",
        model: "self-test-model",
        revision: 1,
        updated_at: now,
      })
        .onConflictDoUpdate({
          target: domainLlmSettings.domain_id,
          set: {
            provider_id: "self-test-provider",
            model: "self-test-model",
            revision: 1,
          },
        });
      const runtime = {
        evaluator: {
          image: "noj-evaluator-python",
          command: "python3 /workspace/evaluate.py",
          time_limit_ms: 5000,
          memory_limit_mb: 512,
          network: { enabled: true },
        },
        solution: {
          image: "noj-solution-python",
          call_timeout_ms: 2000,
          memory_limit_mb: 512,
        },
      };
      await db.insert(problems).values({
        domain_id: DEFAULT_DOMAIN_ID,
        id: problemId,
        number: 98999,
        title: "LLM 自测回归",
        description: "test",
        difficulty: "easy",
        owner_id: userId,
        runtime_config: runtime,
        llm_config: { max_calls: 3, max_tokens: 500 },
        created_at: now,
        updated_at: now,
      });
      const versionId = await publishBaselineVersionForTest(problemId);
      const created = await createSelfTest(userId, problemId, {
        language: "python3",
        code: "def solve(): return 1",
        version_id: versionId,
      });
      const messages = fake.getMessages("noj:judge:queue:ai:medium");
      assertEquals(messages.length, 1);
      const task = JSON.parse(messages[0]);
      assert(task.llm.eval_token.length > 0);
      assertEquals(task.llm.gateway_url, "http://llm-gateway.test");
      assertEquals(task.llm.provider_id, "self-test-provider");
      const [row] = await db.select().from(selfTests).where(
        eq(selfTests.id, created.id),
      );
      assertEquals(row.judge_run_id, task.run_id);
      assertEquals(row.domain_id, DEFAULT_DOMAIN_ID);
      assertEquals(
        (row.task_snapshot as { llm_execution: { domain_id: string } })
          .llm_execution.domain_id,
        DEFAULT_DOMAIN_ID,
      );
      const snapshot = row.task_snapshot as Record<string, unknown>;
      assertEquals(
        (snapshot.llm_execution as Record<string, unknown>).max_calls,
        3,
      );
      assert(!JSON.stringify(snapshot).includes(task.llm.eval_token));

      // 平台默认模型变化不能改写同一次自测的执行事实。
      Deno.env.set("NOJ_LLM_DEFAULT_MODEL", "changed-default-model");
      await db.update(domainLlmSettings).set({
        model: "changed-default-model",
        revision: 2,
      }).where(eq(domainLlmSettings.domain_id, DEFAULT_DOMAIN_ID));
      _resetSystemSettingsForTest();
      const recovered = await rebuildPendingTask({
        domain_id: row.domain_id,
        id: row.id,
        language: row.language,
        code: row.code,
        file_name: row.file_name,
        problem_id: problemId,
        user_id: userId,
        problem_version_id: row.problem_version_id,
        judge_run_id: row.judge_run_id,
        task_snapshot: snapshot,
        runtime_config: runtime,
        support_package_storage_url: null,
      }, "self_test");
      assertEquals(recovered.run_id, task.run_id);
      assertEquals(recovered.llm?.allowed_models, ["self-test-model"]);
      assert(recovered.llm?.eval_token !== task.llm.eval_token);

      const result: JudgeResult = {
        evaluation_protocol_version: 3,
        task_kind: "self_test",
        self_test_run_id: task.run_id!,
        submission_id: created.id,
        problem_version_id: versionId,
        run_id: task.run_id,
        rejudge_seq: 0,
        result_kind: "graded" as const,
        status: "finished",
        score: 10000,
        output: "ok",
        details: {},
      };
      assertEquals(
        await saveSelfTestResult({ ...result, run_id: "wrong-run" }),
        false,
      );
      assertEquals(await saveSelfTestResult(result), true);
      assertEquals(await saveSelfTestResult(result), false);
      const revocations = await db.select().from(llmTokenRevocations).where(
        eq(llmTokenRevocations.attempt_id, task.run_id),
      );
      assertEquals(revocations.length, 1);
      assertEquals(revocations[0].submission_id, created.id);
      assertEquals(revocations[0].state, "done");

      const cancelled = await createSelfTest(userId, problemId, {
        language: "python3",
        code: "def solve(): return 1",
        version_id: versionId,
      });
      const app = new Hono<{ Variables: { userId: string } }>();
      app.post("/cancel", async (c) => {
        c.set("userId", userId);
        await cancelSelfTest(cancelled.id, c);
        return c.json({ ok: true });
      });
      assertEquals(
        (await app.request("/cancel", { method: "POST" })).status,
        200,
      );
      const [cancelledRow] = await db.select().from(selfTests).where(
        eq(selfTests.id, cancelled.id),
      );
      assertEquals(cancelledRow.status, "cancelled");
      const [cancelRevocation] = await db.select().from(llmTokenRevocations)
        .where(
          eq(llmTokenRevocations.attempt_id, cancelledRow.judge_run_id!),
        );
      assertEquals(cancelRevocation.state, "done");

      const failed = await createSelfTest(userId, problemId, {
        language: "python3",
        code: "def solve(): return 1",
        version_id: versionId,
      });
      await db.update(selfTests).set({
        status: "pending",
        created_at: new Date(Date.now() - 180_000).toISOString(),
      }).where(eq(selfTests.id, failed.id));
      // 冻结的 Provider 退役时恢复必须终结并吊销，不能改用新默认 Provider。
      globalThis.fetch = (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              data: { id: "self-test-provider", enabled: false },
            }),
            { headers: { "Content-Type": "application/json" } },
          ),
        )) as typeof fetch;
      await recoverPendingSelfTests(Date.now());
      const [failedRow] = await db.select().from(selfTests).where(
        eq(selfTests.id, failed.id),
      );
      assertEquals(failedRow.status, "error");
      const [failureRevocation] = await db.select().from(llmTokenRevocations)
        .where(
          eq(llmTokenRevocations.attempt_id, failedRow.judge_run_id!),
        );
      assertEquals(failureRevocation.state, "done");
    } finally {
      globalThis.fetch = originalFetch;
      resetRedisForTest();
      await fake.stop();
      for (const [key, value] of previous) {
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
      _resetSystemSettingsForTest();
    }
  },
});
