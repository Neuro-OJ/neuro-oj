/**
 * 题目 LLM 上限服务层校验（需要 DB）。
 */
import { assertRejects } from "jsr:@std/assert@^1";
import { createProblem, updateProblem } from "../../index.ts";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { users } from "../../../../shared/db/schema.ts";
import { BadRequestError } from "../../../../shared/base/errors.ts";
import { getDefaultLlmLimits } from "../../../gateway/index.ts";

// 与 problems.test.ts 一致：PGlite 内存库始终可用
const dbAvailable = true;
const skip = !dbAvailable;
const ts = Date.now();

const NETWORKED_RUNTIME_CONFIG = {
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

async function createAdminUser(): Promise<string> {
  const db = getDb();
  const id = `llm-admin-${ts}`;
  const now = new Date().toISOString();
  await db.insert(users).values({
    id,
    username: `llm-admin-${ts}`,
    email: `llm-admin-${ts}@test.com`,
    password_hash: "",
    created_at: now,
    updated_at: now,
  });
  return id;
}

/** stub gateway /internal/providers/:id，返回 enabled provider，避免测试依赖真实网络。 */
function stubEnabledLlmProvider(): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_input: Request | URL | string) => {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          data: {
            id: "p-does-not-matter",
            name: "stub",
            base_url: "http://stub",
            model: "m",
            cost_per_1k_tokens: 0,
            api_key_masked: "sk-****",
            enabled: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

Deno.test({
  name: "problems-llm-limits: createProblem 拒绝 max_calls 超过平台默认",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const restore = stubEnabledLlmProvider();
    try {
      const adminId = await createAdminUser();
      const defaults = getDefaultLlmLimits();
      await assertRejects(
        () =>
          createProblem(
            {
              title: `LLM 超限 ${Date.now()}`,
              description: "d",
              type: "P",
              runtime_config: NETWORKED_RUNTIME_CONFIG,
              llm: {
                provider_id: "p-does-not-matter",
                model: "m",
                max_calls: defaults.max_calls + 1,
              },
            },
            adminId,
            "admin",
          ),
        BadRequestError,
        "max_calls",
      );
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "problems-llm-limits: updateProblem 拒绝 max_tokens 超过平台默认",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const restore = stubEnabledLlmProvider();
    try {
      const adminId = await createAdminUser();
      const created = await createProblem(
        {
          title: `LLM 更新超限 ${Date.now()}`,
          description: "d",
          type: "P",
          runtime_config: NETWORKED_RUNTIME_CONFIG,
        },
        adminId,
        "admin",
      );
      const defaults = getDefaultLlmLimits();
      await assertRejects(
        () =>
          updateProblem(
            created.id,
            {
              llm: {
                provider_id: "p-does-not-matter",
                model: "m",
                max_tokens: defaults.max_tokens + 1,
              },
            },
            adminId,
            "admin",
          ),
        BadRequestError,
        "max_tokens",
      );
    } finally {
      restore();
    }
  },
});
