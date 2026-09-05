# 题目级 LLM 调用/token 预算实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让题目可声明 `llm.max_calls` / `llm.max_tokens`，经现有 `eval_token` 由 noj-llm-gateway 强制；同时移除 trial-snowy-manor 本地 LLM 预算与效率分。

**Architecture:** `LlmConfig` 增加可选上限字段并做两层校验（纯值域校验 + 服务层平台默认天花板）；上限只通过 `eval_token` 流向 gateway，不新增 MQ 字段、不向 evaluator 注入预算环境变量；gateway 超限返回 `429 out_of_usage`，SDK 结构化该错误供题包判 0 分；trial 移除本地计数与 LLM 效率分并调整主谋分。

**Tech Stack:** Deno 2 + Hono + TypeScript（noj-core/noj-ui）、Python 3（noj-judge SDK / noj-problems）、Vue 3 + Nuxt 4（noj-ui）。

**Spec:** `dev-docs/superpowers/specs/2026-09-05-llm-problem-budget-design.md`

## 全局约束

- 不新增数据库列 / SQL 迁移；`problems.llm_config` 仍为 JSONB。
- 不改变 noj-llm-gateway 代码；gateway 已从 `eval_token` 读 `max_calls/max_tokens`。
- 不新增 `JudgeTaskLlm` 字段；不向 evaluator 注入题目预算环境变量。
- 纯校验 `isValidLlmConfig` / `validateBundleManifest` 不得读取 `Deno.env`。
- 平台默认 `NOJ_LLM_MAX_CALLS`（默认 100）/ `NOJ_LLM_MAX_TOKENS`（默认 50000）同时是安全天花板；题目声明值只能 ≤ 平台默认。
- 服务层写库前必须执行天花板校验，包括 bundle `createViaCrud` 与 `updateExisting`（后者要在删除旧支持包前校验）。
- 提交规范：`feat(core)` / `feat(judge)` / `feat(ui)` / `feat(problems)` 中文描述，GPG 签名；主仓库与 `noj-problems` 均使用 jj。
- Python SDK 测试命令：`cd noj-judge/sdk/evaluator && PYTHONPATH=.:../common python3 -m unittest noj_evaluator_sdk.tests.test_llm -v`
- trial 测试命令：`cd noj-problems/trial-snowy-manor && PYTHONPATH=. python3 -m unittest discover -s tests -v`
- 主仓库 noj-core 测试命令：`cd noj-core && deno task test <测试文件>`；noj-ui 验证命令：`cd noj-ui && deno task check`。

---

### Task 1: noj-core `LlmConfig` 可选上限 + 纯值域校验

**Files:**
- Modify: `noj-core/src/domains/catalog/types/problems.ts`
- Test: `noj-core/src/domains/gateway/tests/services/llm-problem.test.ts`

**Interfaces:**
- Produces:
  - `interface LlmConfig { provider_id: string; model: string; max_calls?: number; max_tokens?: number }`
  - `function isValidLlmConfig(value: unknown): value is LlmConfig`（`max_calls`/`max_tokens` 若存在必须是正整数）

- [ ] **Step 1: 写失败测试**

在 `noj-core/src/domains/gateway/tests/services/llm-problem.test.ts` 中追加：

```ts
Deno.test("llm-config: isValidLlmConfig 接受可选 max 字段", () => {
  assert(isValidLlmConfig({
    provider_id: "p1",
    model: "qwen-plus",
    max_calls: 10,
    max_tokens: 1000,
  }));
  assert(isValidLlmConfig({ provider_id: "p1", model: "qwen-plus" }));
});

Deno.test("llm-config: isValidLlmConfig 拒绝 0/负数/非整数/字符串/null max", () => {
  assert(!isValidLlmConfig({ provider_id: "p1", model: "m", max_calls: 0 }));
  assert(!isValidLlmConfig({ provider_id: "p1", model: "m", max_calls: -1 }));
  assert(!isValidLlmConfig({ provider_id: "p1", model: "m", max_calls: 1.5 }));
  assert(!isValidLlmConfig({ provider_id: "p1", model: "m", max_tokens: "100" }));
  assert(!isValidLlmConfig({ provider_id: "p1", model: "m", max_tokens: null }));
});

Deno.test("llm-bundle: P 型携带合法 max 字段通过", () => {
  const manifest = validateBundleManifest({
    format_version: 1,
    title: "LLM 题",
    type: "P",
    runtime_config: {
      evaluator: {
        image: "noj-evaluator-python",
        time_limit_ms: 60000,
        memory_limit_mb: 512,
        network: { enabled: true },
      },
      solution: {
        image: "noj-solution-python",
        call_timeout_ms: 5000,
        memory_limit_mb: 512,
      },
    },
    llm: { provider_id: "p1", model: "qwen-plus", max_calls: 10, max_tokens: 1000 },
  });
  assertEquals(manifest.llm?.max_calls, 10);
  assertEquals(manifest.llm?.max_tokens, 1000);
});

Deno.test("llm-bundle: 非法 max 字段被拒", () => {
  assertThrows(() =>
    validateBundleManifest({
      format_version: 1,
      title: "LLM 题",
      type: "P",
      runtime_config: {
        evaluator: {
          image: "noj-evaluator-python",
          time_limit_ms: 60000,
          memory_limit_mb: 512,
          network: { enabled: true },
        },
        solution: {
          image: "noj-solution-python",
          call_timeout_ms: 5000,
          memory_limit_mb: 512,
        },
      },
      llm: { provider_id: "p1", model: "m", max_calls: 0 },
    })
  );
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /home/xyber-nova/Github/neuro-oj/noj-core && deno task test src/domains/gateway/tests/services/llm-problem.test.ts`
Expected: FAIL——当前 `isValidLlmConfig` 对多余字段的 0/负值仍返回 true，或 `validateBundleManifest` 未保留 max 字段。

- [ ] **Step 3: 实现类型与纯校验**

修改 `noj-core/src/domains/catalog/types/problems.ts`：

```ts
export interface LlmConfig {
  provider_id: string;
  model: string;
  /** 单次评测 LLM 调用上限；缺省 = 平台默认 */
  max_calls?: number;
  /** 单次评测 LLM billed token 上限；缺省 = 平台默认 */
  max_tokens?: number;
}

export function isValidLlmConfig(value: unknown): value is LlmConfig {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  const isValidPositiveInt = (v: unknown): boolean =>
    v === undefined ||
    (typeof v === "number" && Number.isInteger(v) && v > 0);
  return typeof obj.provider_id === "string" && obj.provider_id.length > 0 &&
    typeof obj.model === "string" && obj.model.length > 0 &&
    isValidPositiveInt(obj.max_calls) && isValidPositiveInt(obj.max_tokens);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /home/xyber-nova/Github/neuro-oj/noj-core && deno task test src/domains/gateway/tests/services/llm-problem.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj describe -m "feat(core): LlmConfig 支持题目级 max_calls/max_tokens 纯校验" && jj new
```

---

### Task 2: noj-core 集中 limits helper + eval_token 签发使用题目上限

**Files:**
- Create: `noj-core/src/domains/gateway/services/llm-limits.ts`
- Modify: `noj-core/src/domains/gateway/index.ts`
- Modify: `noj-core/src/domains/gateway/services/llm-token.ts`
- Test: `noj-core/src/domains/gateway/tests/services/llm-problem.test.ts`

**Interfaces:**
- Produces:
  - `function getDefaultLlmLimits(): { max_calls: number; max_tokens: number }`
  - `function resolveLlmLimits(llm: Pick<LlmConfig, "max_calls" | "max_tokens">): { max_calls: number; max_tokens: number }`
  - `function assertLlmLimitsWithinDefault(llm: Pick<LlmConfig, "max_calls" | "max_tokens">): void`（超过平台默认抛 `BadRequestError`）
  - `buildJudgeTaskLlmForProvider` 增加可选参数 `limits?: { max_calls: number; max_tokens: number }`（放在参数列表末尾，现有调用点不破坏）
- Consumes: Task 1 的 `LlmConfig` 类型。

- [ ] **Step 1: 写失败测试**

在 `noj-core/src/domains/gateway/tests/services/llm-problem.test.ts` 顶部 import 增加：

```ts
import { BadRequestError } from "../../../../shared/base/errors.ts";
import {
  assertLlmLimitsWithinDefault,
  getDefaultLlmLimits,
  resolveLlmLimits,
} from "../../services/llm-limits.ts";
```

并追加：

```ts
Deno.test("llm-limits: getDefaultLlmLimits 读取环境变量", () => {
  const oldCalls = Deno.env.get("NOJ_LLM_MAX_CALLS");
  const oldTokens = Deno.env.get("NOJ_LLM_MAX_TOKENS");
  Deno.env.set("NOJ_LLM_MAX_CALLS", "123");
  Deno.env.set("NOJ_LLM_MAX_TOKENS", "456");
  try {
    assertEquals(getDefaultLlmLimits(), { max_calls: 123, max_tokens: 456 });
  } finally {
    if (oldCalls === undefined) Deno.env.delete("NOJ_LLM_MAX_CALLS");
    else Deno.env.set("NOJ_LLM_MAX_CALLS", oldCalls);
    if (oldTokens === undefined) Deno.env.delete("NOJ_LLM_MAX_TOKENS");
    else Deno.env.set("NOJ_LLM_MAX_TOKENS", oldTokens);
  }
});

Deno.test("llm-limits: resolveLlmLimits 缺省用默认、题目值截断到默认", () => {
  const oldCalls = Deno.env.get("NOJ_LLM_MAX_CALLS");
  const oldTokens = Deno.env.get("NOJ_LLM_MAX_TOKENS");
  Deno.env.set("NOJ_LLM_MAX_CALLS", "100");
  Deno.env.set("NOJ_LLM_MAX_TOKENS", "50000");
  try {
    assertEquals(resolveLlmLimits({}), { max_calls: 100, max_tokens: 50000 });
    assertEquals(
      resolveLlmLimits({ max_calls: 30, max_tokens: 20000 }),
      { max_calls: 30, max_tokens: 20000 },
    );
    assertEquals(
      resolveLlmLimits({ max_calls: 999, max_tokens: 999999 }),
      { max_calls: 100, max_tokens: 50000 },
    );
  } finally {
    if (oldCalls === undefined) Deno.env.delete("NOJ_LLM_MAX_CALLS");
    else Deno.env.set("NOJ_LLM_MAX_CALLS", oldCalls);
    if (oldTokens === undefined) Deno.env.delete("NOJ_LLM_MAX_TOKENS");
    else Deno.env.set("NOJ_LLM_MAX_TOKENS", oldTokens);
  }
});

Deno.test("llm-limits: assertLlmLimitsWithinDefault 超默认抛 BadRequestError", () => {
  const oldCalls = Deno.env.get("NOJ_LLM_MAX_CALLS");
  const oldTokens = Deno.env.get("NOJ_LLM_MAX_TOKENS");
  Deno.env.set("NOJ_LLM_MAX_CALLS", "100");
  Deno.env.set("NOJ_LLM_MAX_TOKENS", "50000");
  try {
    assertLlmLimitsWithinDefault({ max_calls: 30, max_tokens: 20000 });
    assertThrows(
      () => assertLlmLimitsWithinDefault({ max_calls: 101 }),
      BadRequestError,
      "max_calls",
    );
    assertThrows(
      () => assertLlmLimitsWithinDefault({ max_tokens: 50001 }),
      BadRequestError,
      "max_tokens",
    );
  } finally {
    if (oldCalls === undefined) Deno.env.delete("NOJ_LLM_MAX_CALLS");
    else Deno.env.set("NOJ_LLM_MAX_CALLS", oldCalls);
    if (oldTokens === undefined) Deno.env.delete("NOJ_LLM_MAX_TOKENS");
    else Deno.env.set("NOJ_LLM_MAX_TOKENS", oldTokens);
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /home/xyber-nova/Github/neuro-oj/noj-core && deno task test src/domains/gateway/tests/services/llm-problem.test.ts`
Expected: FAIL——`llm-limits.ts` 不存在。

- [ ] **Step 3: 创建 `llm-limits.ts`**

Create `noj-core/src/domains/gateway/services/llm-limits.ts`：

```ts
/**
 * 题目级 LLM 预算的默认值与解析/校验。
 *
 * 平台默认值同时是安全天花板：
 * - CRUD / bundle 导入在写库前调用 assertLlmLimitsWithinDefault 拒绝超限声明；
 * - eval_token 签发调用 resolveLlmLimits 做 Math.min 防御。
 */
import { BadRequestError } from "../../../shared/base/errors.ts";
import type { LlmConfig } from "../../catalog/index.ts";

/** 读取平台默认单次评测 LLM 预算。 */
export function getDefaultLlmLimits(): { max_calls: number; max_tokens: number } {
  return {
    max_calls: Number(Deno.env.get("NOJ_LLM_MAX_CALLS") ?? "100"),
    max_tokens: Number(Deno.env.get("NOJ_LLM_MAX_TOKENS") ?? "50000"),
  };
}

/** 解析题目声明值；缺省用平台默认，声明值超过默认时截断到默认（防御）。 */
export function resolveLlmLimits(
  llm: Pick<LlmConfig, "max_calls" | "max_tokens">,
): { max_calls: number; max_tokens: number } {
  const defaults = getDefaultLlmLimits();
  return {
    max_calls: Math.min(llm.max_calls ?? defaults.max_calls, defaults.max_calls),
    max_tokens: Math.min(llm.max_tokens ?? defaults.max_tokens, defaults.max_tokens),
  };
}

/** 服务层写库前校验：题目声明值不得超过平台默认。 */
export function assertLlmLimitsWithinDefault(
  llm: Pick<LlmConfig, "max_calls" | "max_tokens">,
): void {
  const defaults = getDefaultLlmLimits();
  if (llm.max_calls !== undefined && llm.max_calls > defaults.max_calls) {
    throw new BadRequestError("llm.max_calls 超过平台默认上限");
  }
  if (llm.max_tokens !== undefined && llm.max_tokens > defaults.max_tokens) {
    throw new BadRequestError("llm.max_tokens 超过平台默认上限");
  }
}
```

- [ ] **Step 4: 导出并在 token 签发中复用**

修改 `noj-core/src/domains/gateway/index.ts`：

```ts
export * from "./services/llm.ts";
export * from "./services/llm-limits.ts";
export * from "./services/llm-token.ts";
```

修改 `noj-core/src/domains/gateway/services/llm-token.ts`：

```ts
import { getDefaultLlmLimits, resolveLlmLimits } from "./llm-limits.ts";
```

将 `buildJudgeTaskLlm` 改为：

```ts
export function buildJudgeTaskLlm(
  llmConfig: LlmConfig,
  submissionId: string,
  problemId: string,
  userId: string,
  runtimeConfig: RuntimeConfig,
): Promise<JudgeTaskLlm> {
  return buildJudgeTaskLlmForProvider(
    llmConfig.provider_id,
    llmConfig.model,
    submissionId,
    problemId,
    userId,
    runtimeConfig,
    resolveLlmLimits(llmConfig),
  );
}
```

将 `buildJudgeTaskLlmForProvider` 签名与 `max_calls`/`max_tokens` 改为：

```ts
export async function buildJudgeTaskLlmForProvider(
  providerId: string,
  model: string,
  submissionId: string,
  problemId: string,
  userId: string,
  runtimeConfig: RuntimeConfig,
  limits?: { max_calls: number; max_tokens: number },
): Promise<JudgeTaskLlm> {
  const gatewayUrl = Deno.env.get("NOJ_LLM_GATEWAY_URL") ??
    "http://localhost:8001";
  const timeLimitMs = runtimeConfig.evaluator.time_limit_ms;
  const ttlSeconds = Math.max(60, Math.ceil((timeLimitMs * 4) / 1000));
  const now = Math.floor(Date.now() / 1000);
  const resolved = limits ?? getDefaultLlmLimits();
  const token = await mintEvalToken({
    jti: crypto.randomUUID(),
    submission_id: submissionId,
    problem_id: problemId,
    user_id: userId,
    provider_id: providerId,
    allowed_models: [model],
    iat: now,
    exp: now + ttlSeconds,
    max_calls: resolved.max_calls,
    max_tokens: resolved.max_tokens,
  });
  return {
    gateway_url: gatewayUrl,
    eval_token: token,
    provider_id: providerId,
    allowed_models: [model],
  };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd /home/xyber-nova/Github/neuro-oj/noj-core && deno task test src/domains/gateway/tests/services/llm-problem.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
jj describe -m "feat(core): 集中 LLM 预算 helper 并让 eval_token 使用题目上限" && jj new
```

---

### Task 3: noj-core CRUD / bundle 导入写库前天花板校验

**Files:**
- Modify: `noj-core/src/domains/catalog/services/problems/problems-crud.ts`
- Modify: `noj-core/src/domains/catalog/services/problems/problem-bundle.ts`
- Create: `noj-core/src/domains/catalog/tests/services/problems-llm-limits.test.ts`
- Modify: `noj-core/src/domains/catalog/tests/routes/problem-bundle.test.ts`

**Interfaces:**
- Consumes: `assertLlmLimitsWithinDefault` from Task 2。
- Produces: 无新导出；行为变更——`createProblem` / `updateProblem` / `createViaCrud` / `updateExisting` 在写库/删旧包前拒绝超过平台默认的 `llm.max_*`。

- [ ] **Step 1: 写失败测试（服务层）**

Create `noj-core/src/domains/catalog/tests/services/problems-llm-limits.test.ts`：

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
cd /home/xyber-nova/Github/neuro-oj/noj-core && NOJ_LLM_SERVICE_TOKEN=test-service-token-0123456789abcdef deno task test src/domains/catalog/tests/services/problems-llm-limits.test.ts
```
Expected: FAIL——当前 CRUD 未拒绝超限值；在 stub gateway 下 `createProblem`/`updateProblem` 会成功，`assertRejects(BadRequestError)` 因 promise resolve 而失败。

- [ ] **Step 3: 修改 `problems-crud.ts`**

在 import 区把 `getLlmProviderById` 的导入扩展为：

```ts
import {
  assertLlmLimitsWithinDefault,
  getLlmProviderById,
} from "../../../gateway/index.ts";
```

在 `createProblem` 的 LLM 准入校验中，`type !== "P"` 判断之后、provider 查询之前插入：

```ts
    assertLlmLimitsWithinDefault(input.llm);
```

在 `updateProblem` 的 LLM 变更校验中，`isObjective` 判断之后、provider 查询之前插入：

```ts
      assertLlmLimitsWithinDefault(input.llm);
```

- [ ] **Step 4: 修改 `problem-bundle.ts`**

在 import 区增加：

```ts
import { assertLlmLimitsWithinDefault } from "../../../gateway/index.ts";
```

在 `updateExisting` 中，`enforceResourceLimits(manifest.runtime_config!)` 之后、删除旧支持包之前插入：

```ts
  if (manifest.llm) {
    assertLlmLimitsWithinDefault(manifest.llm);
  }
```

在 `createViaCrud` 中，`enforceResourceLimits(manifest.runtime_config!)` 之后、`const db = getDb();` 之前插入：

```ts
  if (manifest.llm) {
    assertLlmLimitsWithinDefault(manifest.llm);
  }
```

- [ ] **Step 5: 增加 bundle 导入路由测试**

修改 `noj-core/src/domains/catalog/tests/routes/problem-bundle.test.ts`：在 import 区增加

```ts
import { getDefaultLlmLimits } from "../../../gateway/index.ts";
```

在文件末尾追加：

```ts
Deno.test({
  name: "import-bundle: LLM max_calls 超过平台默认被拒（400）",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const token = await createUserToken("admin");
    const defaults = getDefaultLlmLimits();
    const formData = new FormData();
    formData.append(
      "file",
      makeZipBlob({
        type: "P",
        runtime_config: {
          evaluator: {
            image: "noj-evaluator-python",
            time_limit_ms: 60000,
            memory_limit_mb: 512,
            network: { enabled: true },
          },
          solution: {
            image: "noj-solution-python",
            call_timeout_ms: 5000,
            memory_limit_mb: 512,
          },
        },
        llm: {
          provider_id: "p1",
          model: "m",
          max_calls: defaults.max_calls + 1,
        },
      }),
      "llm-over.zip",
    );
    const res = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    assertEquals(res.status, 400);
  },
});
```

- [ ] **Step 6: 运行相关测试确认通过**

Run:
```bash
# service 层：PGlite 内存库始终可跑；token 仅为与红测命令保持一致（实现后不访问 gateway）
cd /home/xyber-nova/Github/neuro-oj/noj-core && NOJ_LLM_SERVICE_TOKEN=test-service-token-0123456789abcdef deno task test src/domains/catalog/tests/services/problems-llm-limits.test.ts
# route 层：需要 JWT_SECRET/DATABASE_URL；无环境时该测试文件自身 skipEnv
cd /home/xyber-nova/Github/neuro-oj/noj-core && deno task test:pg src/domains/catalog/tests/routes/problem-bundle.test.ts
```
Expected: service 层 PASS；route 层在有 env 时 PASS，无 env 时该文件按仓库约定 skip。

- [ ] **Step 7: 提交**

```bash
jj describe -m "feat(core): CRUD 与 bundle 导入写库前拒绝超默认 LLM 上限" && jj new
```

---

### Task 4: noj-judge evaluator SDK 结构化 429 out_of_usage

**Files:**
- Modify: `noj-judge/sdk/evaluator/noj_evaluator_sdk/llm.py`
- Test: `noj-judge/sdk/evaluator/noj_evaluator_sdk/tests/test_llm.py`

**Interfaces:**
- Produces:
  - `class LLMError(Exception)` 增加 `status_code: int | None` 与 `error_code: str | None`
  - `llm.complete()` 对 HTTP 错误解析响应体 `error.code`，填入 `LLMError.error_code`

- [ ] **Step 1: 写失败测试**

在 `noj-judge/sdk/evaluator/noj_evaluator_sdk/tests/test_llm.py` 中追加：

```python
    def test_out_of_usage_error_raises_structured(self):
        server = _start_server()
        old_status = _Handler.status
        old_response = _Handler.response
        _Handler.status = 429
        _Handler.response = {"error": {"code": "out_of_usage"}}
        try:
            os.environ["NOJ_LLM_GATEWAY_URL"] = f"http://127.0.0.1:{server.server_port}"
            os.environ["NOJ_LLM_TOKEN"] = "test-token"
            os.environ["NOJ_LLM_ALLOWED_MODELS"] = "qwen-plus"
            with self.assertRaises(llm.LLMError) as ctx:
                llm.complete(model="qwen-plus", messages=[{"role": "user", "content": "hi"}])
            self.assertEqual(ctx.exception.status_code, 429)
            self.assertEqual(ctx.exception.error_code, "out_of_usage")
        finally:
            _Handler.status = old_status
            _Handler.response = old_response
            server.shutdown()
            server.server_close()
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /home/xyber-nova/Github/neuro-oj/noj-judge/sdk/evaluator && PYTHONPATH=.:../common python3 -m unittest noj_evaluator_sdk.tests.test_llm -v`
Expected: FAIL——`LLMError` 没有 `status_code` / `error_code` 属性。

- [ ] **Step 3: 实现结构化错误**

修改 `noj-judge/sdk/evaluator/noj_evaluator_sdk/llm.py`：

```python
class LLMError(Exception):
    """LLM 调用失败（配置缺失、token 失效、上游错误等）。"""

    def __init__(
        self,
        message: str,
        status_code: int | None = None,
        error_code: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.error_code = error_code
```

将 `HTTPError` 分支替换为：

```python
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        error_code = None
        try:
            body = json.loads(detail)
            error_code = body.get("error", {}).get("code")
        except Exception:
            error_code = None
        raise LLMError(
            f"LLM gateway 返回 {e.code}: {detail}",
            status_code=e.code,
            error_code=error_code,
        ) from e
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /home/xyber-nova/Github/neuro-oj/noj-judge/sdk/evaluator && PYTHONPATH=.:../common python3 -m unittest noj_evaluator_sdk.tests.test_llm -v`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj describe -m "feat(judge): evaluator SDK 解析 gateway out_of_usage 错误结构" && jj new
```

---

### Task 5: noj-ui 题目编辑器增加可选上限输入

**Files:**
- Modify: `noj-ui/components/editor/CodingProblemEditor.vue`

**Interfaces:**
- Consumes: `LlmConfig.max_calls` / `max_tokens`（来自 API `llm_config`）。
- Produces: 创建/更新请求 `llm` payload 中可选的 `max_calls` / `max_tokens`；留空不发送键。

- [ ] **Step 1: 在 script 中增加状态与逻辑**

在 `noj-ui/components/editor/CodingProblemEditor.vue` 的 LLM 状态区，`const llmModel = ref("")` 之后增加：

```ts
const llmMaxCalls = ref("")
const llmMaxTokens = ref("")
```

编辑模式加载处，将 LLM 回填改为：

```ts
    const llmConfig = (p as {
      llm_config?: {
        provider_id: string
        model: string
        max_calls?: number | null
        max_tokens?: number | null
      } | null
    }).llm_config
    if (llmConfig) {
      llmEnabled.value = true
      llmProviderId.value = llmConfig.provider_id
      llmModel.value = llmConfig.model
      llmMaxCalls.value = llmConfig.max_calls != null ? String(llmConfig.max_calls) : ""
      llmMaxTokens.value = llmConfig.max_tokens != null ? String(llmConfig.max_tokens) : ""
    }
```

`validate()` 的 `llmEnabled` 分支增加校验：

```ts
  if (llmEnabled.value) {
    if (!llmProviderId.value.trim()) errors.llm_provider = "请选择 LLM Provider"
    if (!llmModel.value.trim()) errors.llm_model = "请输入模型名"
    if (!evaluatorNetworkEnabled.value) errors.evaluator_network = "启用 LLM 必须开启 Evaluator 联网"
    const maxCalls = llmMaxCalls.value === "" ? null : Number(llmMaxCalls.value)
    const maxTokens = llmMaxTokens.value === "" ? null : Number(llmMaxTokens.value)
    if (maxCalls !== null && (!Number.isInteger(maxCalls) || maxCalls <= 0)) {
      errors.llm_max_calls = "调用上限必须是正整数"
    }
    if (maxTokens !== null && (!Number.isInteger(maxTokens) || maxTokens <= 0)) {
      errors.llm_max_tokens = "token 上限必须是正整数"
    }
  }
```

`handleSubmit()` 中 `llmPayload` 构造改为：

```ts
    const llmMaxCallsNum = llmMaxCalls.value === "" ? null : Number(llmMaxCalls.value)
    const llmMaxTokensNum = llmMaxTokens.value === "" ? null : Number(llmMaxTokens.value)
    const llmPayload = llmEnabled.value
      ? {
          provider_id: llmProviderId.value.trim(),
          model: llmModel.value.trim(),
          ...(llmMaxCallsNum !== null ? { max_calls: llmMaxCallsNum } : {}),
          ...(llmMaxTokensNum !== null ? { max_tokens: llmMaxTokensNum } : {}),
        }
      : null
```

- [ ] **Step 2: 在模板中增加输入**

在 `CodingProblemEditor.vue` 的 LLM 区块中，`llmModel` 的 `fieldErrors.llm_model` 段落之后、琥珀色提示块之前插入：

```html
                <div class="grid grid-cols-2 gap-2">
                  <div class="flex flex-col gap-1">
                    <label class="text-xs font-semibold text-text">调用上限</label>
                    <input
                      v-model="llmMaxCalls"
                      type="number"
                      min="1"
                      class="px-2.5 py-1.5 text-sm border border-border rounded-md bg-white"
                      placeholder="留空使用平台默认"
                    />
                    <p v-if="fieldErrors.llm_max_calls" class="text-xs text-red-600">{{ fieldErrors.llm_max_calls }}</p>
                  </div>
                  <div class="flex flex-col gap-1">
                    <label class="text-xs font-semibold text-text">Token 上限</label>
                    <input
                      v-model="llmMaxTokens"
                      type="number"
                      min="1"
                      class="px-2.5 py-1.5 text-sm border border-border rounded-md bg-white"
                      placeholder="留空使用平台默认"
                    />
                    <p v-if="fieldErrors.llm_max_tokens" class="text-xs text-red-600">{{ fieldErrors.llm_max_tokens }}</p>
                  </div>
                </div>
```

- [ ] **Step 3: 验证 noj-ui 检查**

Run: `cd /home/xyber-nova/Github/neuro-oj/noj-ui && deno task check`
Expected: PASS（fmt/lint/type-check）。

- [ ] **Step 4: 提交**

```bash
jj describe -m "feat(ui): 题目编辑器支持声明 LLM 调用/token 上限" && jj new
```

---

### Task 6: trial-snowy-manor 移除本地 LLM 预算与效率分（独立 noj-problems 仓库）

**Repo boundary:** 以下文件属于独立仓库 `/home/xyber-nova/Github/neuro-oj/noj-problems`（主仓库 `.gitignore` 忽略 `noj-problems/`）。提交在 `noj-problems` 仓库内执行。

**Files:**
- Modify: `trial-snowy-manor/scenario_runner.py`
- Modify: `trial-snowy-manor/sdk_evaluate.py`
- Modify: `trial-snowy-manor/evaluate_offline.py`
- Modify: `trial-snowy-manor/README.e2e.md`
- Modify: `trial-snowy-manor/tests/test_scenario_runner.py`
- Modify: `trial-snowy-manor/tests/test_offline_e2e.py`（如断言依赖旧满分结构则同步）

**Interfaces:**
- Produces:
  - `TrialRunner.__init__(scenario, max_evidence_queries, max_wrong_rebuttals=3, seed="default")`（移除 `max_llm_calls` / `max_llm_tokens`）
  - 移除 `TrialRunner.llm_called()`、`used_llm_calls`、`used_llm_tokens`
  - `scoring()` 返回值不再含 `efficiency_score`；`MASTERMIND_SCORE = 250`；满分仍 1000
  - `sdk_evaluate.cap_llm_complete` 捕获 `llm.LLMError` 中 `error_code == "out_of_usage"` 后置失败并抛 `RuntimeError`

**机制说明（capability 异常传播）：** `cap_llm_complete` 是 evaluator capability handler。
它在 handler 内抛出的 `RuntimeError` 不会冒泡到 `sdk_evaluate.main()` 的 try/except；
SDK `SolutionRunner._handle_capability` 会把它编码为 error 帧回传给 solution 侧调用者。
真正使评测判 0 分的路径是 `runner._is_failed = True` → 最终 `runner.scoring()` 返回
`score: 0` → `sdk_evaluate.main()` 调用 `result.wrong_answer(score=0, ...)`。因此实现时
不要依赖 `main()` 捕获 capability 异常；只需保证捕获 `out_of_usage` 后置失败并继续抛出
`RuntimeError`（用于让 solution 收到错误并停止调用）。

- [ ] **Step 1: 修改 `scenario_runner.py`**

将常量区改为：

```python
# spec §7 分值（无 LLM 效率分）
REBUTTAL_PER_ROUND = 100
MASTERMIND_SCORE = 250
EVIDENCE_SCORE = 200
```

将 `__init__` 改为：

```python
    def __init__(
        self,
        scenario: Scenario,
        max_evidence_queries: int,
        max_wrong_rebuttals: int = 3,
        seed: str = "default",
    ) -> None:
        self._scenario = scenario
        self._max_evidence_queries = max_evidence_queries
        self._max_wrong_rebuttals = max_wrong_rebuttals
        self._seed = seed
        self.current_round_index = 0
        self.used_evidence_queries = 0
        self.used_wrong_rebuttals = 0
        self.queried_evidence_ids: set[str] = set()
        self._is_failed = False
        self._is_finished = False
        self._final: dict[str, Any] | None = None
```

删除整个 `llm_called` 方法：

```python
    def llm_called(self, billed_tokens: int = 0) -> None:
        ...
```

将 `scoring()` 改为：

```python
    def scoring(self, reason_score: int = 0) -> dict[str, int]:
        if self._is_failed:
            return {
                "max_score": 1000,
                "score": 0,
                "rebuttal_score": 0,
                "mastermind_score": 0,
                "evidence_score": 0,
                "reason_score": 0,
            }
        if self._final is None:
            # 未调用 final_verdict：只保留已正确反驳分
            rebuttal = self.current_round_index * REBUTTAL_PER_ROUND
            return {
                "max_score": 1000,
                "score": rebuttal,
                "rebuttal_score": rebuttal,
                "mastermind_score": 0,
                "evidence_score": 0,
                "reason_score": 0,
            }

        rebuttal = self.current_round_index * REBUTTAL_PER_ROUND
        mastermind = MASTERMIND_SCORE if self._final["person_id"] == self._scenario.mastermind_id else 0
        # 只有 final_verdict 中引用且确实 get_evidence 查询过的关键证据才计证据分
        queried_key = set(self._scenario.key_evidence_ids) & self.queried_evidence_ids
        matched = set(self._final["evidence_ids"]) & queried_key
        evidence = round(EVIDENCE_SCORE * len(matched) / len(self._scenario.key_evidence_ids)) if self._scenario.key_evidence_ids else 0

        score = rebuttal + mastermind + evidence + reason_score
        return {
            "max_score": 1000,
            "score": score,
            "rebuttal_score": rebuttal,
            "mastermind_score": mastermind,
            "evidence_score": evidence,
            "reason_score": reason_score,
        }
```

- [ ] **Step 2: 修改 `sdk_evaluate.py`**

`_load_runner()` 改为：

```python
    return TrialRunner(
        scenario,
        max_evidence_queries=max_evidence,
        max_wrong_rebuttals=int(os.environ.get("NOJ_TRIAL_MAX_WRONG", "3")),
        seed=seed,
    )
```

`cap_llm_complete` 改为：

```python
    def cap_llm_complete(
        messages: list[dict[str, str]],
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        from noj_evaluator_sdk import llm
        opts = dict(params or {})
        try:
            return llm.complete(messages=messages, **opts)
        except llm.LLMError as exc:
            if exc.status_code == 429 and exc.error_code == "out_of_usage":
                runner._is_failed = True
                raise RuntimeError("out_of_usage") from exc
            raise
```

- [ ] **Step 3: 修改 `evaluate_offline.py`**

`TrialRunner(...)` 调用改为：

```python
    runner = TrialRunner(
        sc,
        max_evidence_queries=max_evidence_queries,
        max_wrong_rebuttals=max_wrong_rebuttals,
        seed=seed,
    )
```

`Api.llm` 改为：

```python
            def llm(self, messages, **params):
                return {"choices": [{"message": {"content": "stub"}}]}
```

返回值移除 `"used_llm_calls": runner.used_llm_calls,`。

- [ ] **Step 4: 修改 `README.e2e.md`**

删除以下两行：

```text
- `NOJ_TRIAL_MAX_LLM=30`（Agent 本地 LLM 轮次上限）
- `NOJ_TRIAL_MAX_TOKENS=20000`（Agent 本地 billed token 上限）
```

将说明块中的“并固定选择 `manor_001`。若需要这些环境变量真正生效……”改为：

```text
`NOJ_TRIAL_MAX_WRONG` / `NOJ_TRIAL_SOLVE_TIMEOUT_MS` / `NOJ_SUBMISSION_ID` / `NOJ_REJUDGE_SEQ` 目前 judge 不会自动注入 evaluator 容器；若未注入，`sdk_evaluate.py` 使用代码内默认值（3/240000/default），并固定选择 `manor_001`。题目级 LLM 预算由平台 `NOJ_LLM_MAX_CALLS` / `NOJ_LLM_MAX_TOKENS` 与题目声明的 `llm.max_calls` / `llm.max_tokens` 经 gateway 强制，不再由 trial 本地预检。
```

- [ ] **Step 5: 同步单测断言**

在 `trial-snowy-manor/tests/test_scenario_runner.py` 的 `test_final_verdict_scoring` 中，将：

```python
        self.assertEqual(breakdown["mastermind_score"], 200)
```

改为：

```python
        self.assertEqual(breakdown["mastermind_score"], 250)
```

并在该测试末尾增加：

```python
        self.assertNotIn("efficiency_score", breakdown)
        self.assertEqual(breakdown["score"], 600)
```

说明：该测试场景 1 轮反驳（100）+ 主谋（250）+ 2/2 关键证据（200）+ reason（50）= 600。

若 `test_offline_e2e.py` 的 `test_reference_agent_scores_high_without_llm` 仍断言 `score >= 750`，无需改动（新满分 1000 下参考 Agent 仍满足）。

- [ ] **Step 6: 运行 trial 测试**

Run: `cd /home/xyber-nova/Github/neuro-oj/noj-problems/trial-snowy-manor && PYTHONPATH=. python3 -m unittest discover -s tests -v`
Expected: PASS（19+ 用例，无 `used_llm_calls` / `efficiency_score` 依赖）。

- [ ] **Step 7: 提交（在 noj-problems 仓库内）**

```bash
cd /home/xyber-nova/Github/neuro-oj/noj-problems
jj describe -m "feat(problems): trial-snowy-manor 移除本地 LLM 预算与效率分" && jj new
```

---

### 自审核对

- Spec §5.1（数据模型）：Task 1 实现 `LlmConfig` 可选字段。
- Spec §5.2（两层校验）：Task 1 纯校验；Task 3 服务层天花板校验。
- Spec §5.3（集中 helper / token 签发）：Task 2。
- Spec §5.4 / §5.5（gateway 不改 / SDK 错误增强）：Task 4；gateway 无改动。
- Spec §5.6（UI）：Task 5。
- Spec §5.7（trial 适配与评分）：Task 6。
- Spec §5.8（测试计划）：各任务均含失败→实现→通过的测试步骤。
- 兼容性：不新增 DB 列/迁移、不新增 MQ 字段、不注入 evaluator 预算环境变量。
