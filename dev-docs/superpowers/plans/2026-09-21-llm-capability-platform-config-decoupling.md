# 题目 LLM 能力与平台配置解耦 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让题目只声明「需要 LLM 能力 + 预算」，Provider/模型由 noj-core 的平台级全局默认统一决定，从而使题包跨部署可移植、平台可一处切换模型。

**Architecture:** `problems.llm_config` 收缩为 `{ max_calls?, max_tokens? }`（非 null 即启用）；新增 runtime 系统设置 `llm_default_provider_id` + `llm_default_model`；`buildJudgeTaskLlm` 在签发 eval_token 时用全局默认填充 `provider_id` / `allowed_models`，**wire 契约不变**，gateway/judge/evaluator 运行时代码不动。删除 `llm_providers.model` 死列。

**Tech Stack:** Deno 2 + Hono + Drizzle ORM + PostgreSQL（noj-core）；Deno + Hono + postgres.js（noj-llm-gateway）；Nuxt 4 + Vue 3（noj-ui）；Rust 仅需编译验证（不改）。

**Spec:** `dev-docs/superpowers/specs/2026-09-21-llm-capability-platform-config-decoupling-design.md`

## Global Constraints

- 语言：注释、提交信息、文档一律中文；代码标识符英文。
- 提交信息格式：`<type>(<scope>): <中文描述>`；scope ∈ `core`/`ui`/`judge`/`root`。
- 所有提交必须 GPG 签名（本 worktree 为 git 链接工作树，用 `git commit -S`）。
- TypeScript：`deno fmt` + `deno lint` 必须通过。
- 禁止手动修改 `_journal.json`；core 本变更**不产生 SQL 迁移**（JSONB 只改应用层语义）。
- 测试必须用 `deno task` 运行，禁止手拼 `deno test`。
- 域边界：跨域只 import 域门面 `index.ts`（`deno task check:domains` 强制）。
- `llm_default_provider_id` / `llm_default_model` 均为 **runtime** 设置（DB 可热改，env 兜底）。
- 平台默认必须**两项同时配置**，无回退；缺任一项时 LLM 题提交返回 400。
- 存量 `llm_config` / 旧 manifest 中的 `provider_id` / `model`：**容忍并忽略**，不报错。
- `JudgeTaskLlm` 与 `eval_token` 的 wire 契约**不变**；`noj-tests/fixtures/judge-task.contract.json` 不改。

---

## 文件结构

| 文件 | 职责 | 动作 |
| --- | --- | --- |
| `noj-core/src/shared/config/settings-registry.ts` | 注册表项 + `SettingCategory` | 修改 |
| `noj-core/.env.example` / `.env.prod.example` / `env.e2e.template` | env 兜底登记 | 修改 |
| `noj-core/src/domains/gateway/services/llm.ts` | 平台默认解析 + gateway 客户端类型 | 修改 |
| `noj-core/src/domains/gateway/services/llm-token.ts` | eval_token 签发 | 修改 |
| `noj-core/src/domains/catalog/types/problems.ts` | `LlmConfig` / `isValidLlmConfig` | 修改 |
| `noj-core/src/domains/catalog/types/problem-bundle.ts` | manifest 校验 | 修改 |
| `noj-core/src/domains/catalog/services/problems/problems-crud.ts` | 题目 CRUD 校验 | 修改 |
| `noj-core/src/domains/admin/routes/gateway.ts` | Provider 管理路由 | 修改 |
| `noj-cli/src/problem/vendor/problems.ts` | 契约副本 | 修改 |
| `noj-cli/src/problem/vendor/problem-bundle.ts` | 契约副本 | 修改 |
| `fixtures/problem-bundle-manifest.json` | 共享 fixture | 修改 |
| `noj-llm-gateway/src/db/schema.ts` | Provider 表定义 | 修改 |
| `noj-llm-gateway/src/providers.ts` | Provider CRUD | 修改 |
| `noj-llm-gateway/src/routes/internal.ts` | 内部管理 API | 修改 |
| `noj-llm-gateway/drizzle/0003_remove_provider_model.sql` | DROP 列迁移 | 新建 |
| `noj-ui/components/editor/CodingProblemEditor.vue` | 出题编辑器 | 修改 |
| `noj-ui/pages/admin/llm/providers.vue` | Provider 管理页 | 修改 |
| `noj-ui/pages/admin/settings.vue` | 设置页分类标签 | 修改 |
| `noj-tests/e2e/cross-domain/llm_gateway.test.ts` | e2e | 修改 |
| `noj-docs/docs/problemsetters/llm-problem.md` 等 | 文档 | 修改 |
| `.agents/notes/implemented/…` | Agent Note | 新建 |

---

## Task 1: core 新增平台默认 LLM 设置项

**Files:**
- Modify: `noj-core/src/shared/config/settings-registry.ts`（`SettingCategory` 联合类型 + `CONFIG_DEFINITIONS` 数组）
- Modify: `noj-core/.env.example`、`.env.prod.example`、`env.e2e.template`
- Test: `noj-core/src/domains/system/tests/services/system-settings.test.ts`（新增用例）

**Interfaces:**
- Produces: 两个 runtime 设置键 `llm_default_provider_id`（string，envFallback `NOJ_LLM_DEFAULT_PROVIDER_ID`）、`llm_default_model`（string，envFallback `NOJ_LLM_DEFAULT_MODEL`），默认值均为 `""`，`category: "llm"`。

- [ ] **Step 1: 写失败测试**

在 `noj-core/src/domains/system/tests/services/system-settings.test.ts` 末尾追加：

```ts
Deno.test("system-settings: llm 平台默认项已注册且默认为空串", () => {
  const provider = getSetting("llm_default_provider_id");
  const model = getSetting("llm_default_model");
  assert(provider !== null, "llm_default_provider_id 应已注册");
  assert(model !== null, "llm_default_model 应已注册");
  assertEquals(provider.value, "");
  assertEquals(model.value, "");
});
```

若文件未 import `getSetting` / `assert` / `assertEquals`，在顶部补齐（该文件已有部分 import，按需追加）。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-core && deno task test:domain system`
Expected: FAIL —— `llm_default_provider_id 应已注册`（返回 null）。

- [ ] **Step 3: 注册设置项**

在 `noj-core/src/shared/config/settings-registry.ts`：

(a) `SettingCategory` 联合类型末尾加 `| "llm"`：

```ts
export type SettingCategory =
  | "auth"
  | "maintenance"
  | "email"
  | "rate_limit"
  | "storage"
  | "database"
  | "redis"
  | "cors"
  | "community"
  | "judge"
  | "review"
  | "llm"
  | "other";
```

(b) 在 `CONFIG_DEFINITIONS` 中（`community` 项之后、`storage` 注释之前）追加：

```ts
  // ── llm（题目 LLM 能力的平台全局默认）────────────────────
  {
    key: "llm_default_provider_id",
    type: "string",
    default: "",
    description: "LLM 题全局默认 Provider ID（gateway 内部 Provider UUID）",
    is_secret: false,
    envFallback: "NOJ_LLM_DEFAULT_PROVIDER_ID",
    category: "llm",
    scope: "runtime",
  },
  {
    key: "llm_default_model",
    type: "string",
    default: "",
    description: "LLM 题全局默认模型名（必须显式配置，无 Provider 级回退）",
    is_secret: false,
    envFallback: "NOJ_LLM_DEFAULT_MODEL",
    category: "llm",
    scope: "runtime",
  },
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-core && deno task test:domain system`
Expected: PASS。

- [ ] **Step 5: 登记 env 示例（check:env 要求）**

`noj-core/.env.example`：在 `# NOJ_LLM_MAX_TOKENS=50000` 附近追加：

```dotenv
# LLM 题平台全局默认（runtime 设置，可在后台热改；env 仅作启动兜底）
# 两项必须同时配置，否则 LLM 题提交返回 400
# NOJ_LLM_DEFAULT_PROVIDER_ID=
# NOJ_LLM_DEFAULT_MODEL=
```

`.env.prod.example` 与 `env.e2e.template` 同步加入同两行（保持注释示例形态）。

- [ ] **Step 6: 运行 check:env**

Run: `cd noj-core && deno task check:env`
Expected: PASS（无孤儿键、无缺失键告警）。

- [ ] **Step 7: 提交**

```bash
git add noj-core/src/shared/config/settings-registry.ts noj-core/.env.example .env.prod.example env.e2e.template noj-core/src/domains/system/tests/services/system-settings.test.ts
git commit -S -m "feat(core): 新增平台默认 LLM Provider/模型设置项"
```

---

## Task 2: core 平台默认解析函数

**Files:**
- Modify: `noj-core/src/domains/gateway/services/llm.ts`
- Test: `noj-core/src/domains/gateway/tests/services/llm-problem.test.ts`

**Interfaces:**
- Consumes: `getSetting`（来自 `../../../system/index.ts`，Task 1 的键）。
- Produces: `getLlmPlatformDefault(): { provider_id: string; model: string } | null` —— 两项 trim 后任一为空返回 `null`。

- [ ] **Step 1: 写失败测试**

在 `noj-core/src/domains/gateway/tests/services/llm-problem.test.ts` 顶部 import 区加入：

```ts
import { getLlmPlatformDefault } from "../../services/llm.ts";
import { _resetSystemSettingsForTest } from "../../../system/index.ts";
```

追加测试：

```ts
Deno.test("llm-platform-default: 未配置返回 null", async () => {
  _resetSystemSettingsForTest();
  const oldP = Deno.env.get("NOJ_LLM_DEFAULT_PROVIDER_ID");
  const oldM = Deno.env.get("NOJ_LLM_DEFAULT_MODEL");
  Deno.env.delete("NOJ_LLM_DEFAULT_PROVIDER_ID");
  Deno.env.delete("NOJ_LLM_DEFAULT_MODEL");
  try {
    assertEquals(getLlmPlatformDefault(), null);
  } finally {
    if (oldP) Deno.env.set("NOJ_LLM_DEFAULT_PROVIDER_ID", oldP);
    if (oldM) Deno.env.set("NOJ_LLM_DEFAULT_MODEL", oldM);
    _resetSystemSettingsForTest();
  }
});

Deno.test("llm-platform-default: env 兜底生效", () => {
  _resetSystemSettingsForTest();
  Deno.env.set("NOJ_LLM_DEFAULT_PROVIDER_ID", "prov-abc");
  Deno.env.set("NOJ_LLM_DEFAULT_MODEL", "qwen-plus");
  try {
    assertEquals(getLlmPlatformDefault(), {
      provider_id: "prov-abc",
      model: "qwen-plus",
    });
  } finally {
    Deno.env.delete("NOJ_LLM_DEFAULT_PROVIDER_ID");
    Deno.env.delete("NOJ_LLM_DEFAULT_MODEL");
    _resetSystemSettingsForTest();
  }
});
```

> 注：`_resetSystemSettingsForTest` 若未从 system 门面导出，改为从
> `"../../../system/services/system-settings.ts"` 深路径导入（测试允许深路径）。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-core && deno task test:domain gateway`
Expected: FAIL —— `getLlmPlatformDefault is not a function` / 模块无导出。

- [ ] **Step 3: 实现**

在 `noj-core/src/domains/gateway/services/llm.ts` 顶部加 import：

```ts
import { getSetting } from "../../system/index.ts";
```

在文件内（`listLlmProviders` 附近）新增：

```ts
/**
 * 读取平台级默认 LLM Provider 与模型。
 *
 * 两项必须同时配置（无 Provider 级 model 回退）：任一为空则返回 null，
 * 由调用方（buildJudgeTaskLlm）转成明确的 400 错误。
 */
export function getLlmPlatformDefault(): {
  provider_id: string;
  model: string;
} | null {
  const providerId = String(getSetting("llm_default_provider_id")?.value ?? "")
    .trim();
  const model = String(getSetting("llm_default_model")?.value ?? "").trim();
  if (!providerId || !model) return null;
  return { provider_id: providerId, model };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-core && deno task test:domain gateway`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add noj-core/src/domains/gateway/services/llm.ts noj-core/src/domains/gateway/tests/services/llm-problem.test.ts
git commit -S -m "feat(core): 新增平台默认 LLM Provider/模型解析"
```

---

## Task 3: LlmConfig 收缩为预算字段

**Files:**
- Modify: `noj-core/src/domains/catalog/types/problems.ts`
- Modify: `noj-core/src/domains/catalog/types/problem-bundle.ts`
- Test: `noj-core/src/domains/gateway/tests/services/llm-problem.test.ts`、`noj-core/src/domains/catalog/tests/types/problem-bundle-contract.test.ts`

**Interfaces:**
- Produces: `LlmConfig = { max_calls?: number; max_tokens?: number }`；`isValidLlmConfig` 只校验可选正整数，未知键（含 `provider_id`/`model`）忽略。

- [ ] **Step 1: 写失败测试**

替换 `llm-problem.test.ts` 中 `llm-config: isValidLlmConfig` 测试为：

```ts
Deno.test("llm-config: isValidLlmConfig", () => {
  assert(isValidLlmConfig({}));
  assert(isValidLlmConfig({ max_calls: 30 }));
  assert(isValidLlmConfig({ max_calls: 30, max_tokens: 20000 }));
  // 存量旧字段容忍并忽略
  assert(isValidLlmConfig({ provider_id: "p1", model: "qwen-plus" }));
  // 非法预算
  assert(!isValidLlmConfig({ max_calls: 0 }));
  assert(!isValidLlmConfig({ max_calls: -1 }));
  assert(!isValidLlmConfig({ max_tokens: 1.5 }));
  assert(!isValidLlmConfig({ max_tokens: "100" }));
  assert(!isValidLlmConfig(null));
});
```

并把 `llm-bundle: P 型 + 网络开启通过` 中的 manifest `llm` 改为 `{ max_calls: 30 }`，断言改为 `assertEquals(manifest.llm?.max_calls, 30);`。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-core && deno task test:domain gateway`
Expected: FAIL —— 当前 `isValidLlmConfig({})` 为 false（要求 provider_id/model）。

- [ ] **Step 3: 修改 LlmConfig 与校验**

`noj-core/src/domains/catalog/types/problems.ts`，替换：

```ts
/**
 * 题目 LLM 配置：出题人只声明预算，Provider/模型由平台全局默认决定。
 *
 * 非 null 即启用 LLM；`provider_id` / `model` 等旧字段容忍并忽略。
 */
export interface LlmConfig {
  /** 单次评测 LLM 调用上限；缺省 = 平台默认 */
  max_calls?: number;
  /** 单次评测 LLM billed token 上限；缺省 = 平台默认 */
  max_tokens?: number;
}

/**
 * 校验 LLM 配置是否合法。
 *
 * 只校验可选预算字段；未知键（含存量的 provider_id/model）忽略，保持前向兼容。
 */
export function isValidLlmConfig(value: unknown): value is LlmConfig {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  const isValidPositiveInt = (v: unknown): boolean =>
    v === undefined ||
    (typeof v === "number" && Number.isInteger(v) && v > 0);
  return isValidPositiveInt(obj.max_calls) &&
    isValidPositiveInt(obj.max_tokens);
}
```

保留 `CreateProblemInput.llm` / `UpdateProblemInput.llm` / `ProblemResponseWithTags.llm_config` 的类型引用不变（类型自动收缩）。更新其上注释「题目 LLM 配置」措辞。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-core && deno task test:domain gateway`
Expected: PASS。

- [ ] **Step 5: manifest 校验回归**

Run: `cd noj-core && deno task test:domain catalog`
Expected: PASS（`problem-bundle.test.ts` 中 `{ llm: { provider_id: "p", model: "m" } }` 仍合法，因未知键被忽略）。

> 若该测试断言了 `manifest.llm?.provider_id`，改为断言 `manifest.llm !== undefined`。

- [ ] **Step 6: 提交**

```bash
git add noj-core/src/domains/catalog/types/problems.ts noj-core/src/domains/catalog/types/problem-bundle.ts noj-core/src/domains/gateway/tests/services/llm-problem.test.ts
git commit -S -m "refactor(core): 题目 LLM 配置收缩为预算字段"
```

---

## Task 4: buildJudgeTaskLlm 改用平台默认

**Files:**
- Modify: `noj-core/src/domains/gateway/services/llm-token.ts`
- Test: `noj-core/src/domains/gateway/tests/services/llm-problem.test.ts`

**Interfaces:**
- Consumes: `getLlmPlatformDefault()`（Task 2）、`getLlmProviderById()`（既有）、`resolveLlmLimits()`（既有）。
- Produces: `buildJudgeTaskLlm(llmConfig, submissionId, problemId, userId, runtimeConfig)` 行为变更——provider/model 取自平台默认；未配置或 Provider 不可用 → 抛 `BadRequestError`。签名与返回类型 `Promise<JudgeTaskLlm>` 不变。

- [ ] **Step 1: 写失败测试**

在 `llm-problem.test.ts` 追加（沿用既有 stub fetch 模式，参考 `problems-llm-limits.test.ts` 的 `stubEnabledLlmProvider`）：

```ts
function stubProviderFetch(enabled: boolean): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((_input: Request | URL | string) =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: {
            id: "prov-default",
            name: "stub",
            base_url: "http://stub",
            cost_per_1k_tokens: 0,
            api_key_masked: "sk-****",
            enabled,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    )) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const RUNTIME: RuntimeConfig = {
  evaluator: {
    image: "noj-evaluator-python",
    command: "python3 /workspace/evaluate.py",
    time_limit_ms: 60000,
    memory_limit_mb: 512,
    network: { enabled: true },
  },
  solution: {
    image: "noj-solution-python",
    call_timeout_ms: 5000,
    memory_limit_mb: 512,
  },
};

Deno.test("llm-token: 未配置平台默认时抛错", async () => {
  _resetSystemSettingsForTest();
  Deno.env.delete("NOJ_LLM_DEFAULT_PROVIDER_ID");
  Deno.env.delete("NOJ_LLM_DEFAULT_MODEL");
  try {
    await assertRejects(
      () => buildJudgeTaskLlm({}, "sub-1", "prob-1", "user-1", RUNTIME),
      BadRequestError,
    );
  } finally {
    _resetSystemSettingsForTest();
  }
});

Deno.test("llm-token: 使用平台默认填充 provider/model 与预算", async () => {
  _resetSystemSettingsForTest();
  Deno.env.set("NOJ_LLM_DEFAULT_PROVIDER_ID", "prov-default");
  Deno.env.set("NOJ_LLM_DEFAULT_MODEL", "qwen-plus");
  const restore = stubProviderFetch(true);
  try {
    const task = await buildJudgeTaskLlm(
      { max_calls: 7 },
      "sub-1",
      "prob-1",
      "user-1",
      RUNTIME,
    );
    assertEquals(task.provider_id, "prov-default");
    assertEquals(task.allowed_models, ["qwen-plus"]);
  } finally {
    restore();
    Deno.env.delete("NOJ_LLM_DEFAULT_PROVIDER_ID");
    Deno.env.delete("NOJ_LLM_DEFAULT_MODEL");
    _resetSystemSettingsForTest();
  }
});

Deno.test("llm-token: 默认 Provider 停用时抛错", async () => {
  _resetSystemSettingsForTest();
  Deno.env.set("NOJ_LLM_DEFAULT_PROVIDER_ID", "prov-default");
  Deno.env.set("NOJ_LLM_DEFAULT_MODEL", "qwen-plus");
  const restore = stubProviderFetch(false);
  try {
    await assertRejects(
      () => buildJudgeTaskLlm({}, "sub-1", "prob-1", "user-1", RUNTIME),
      BadRequestError,
    );
  } finally {
    restore();
    Deno.env.delete("NOJ_LLM_DEFAULT_PROVIDER_ID");
    Deno.env.delete("NOJ_LLM_DEFAULT_MODEL");
    _resetSystemSettingsForTest();
  }
});
```

补齐 import：`assertRejects`（`jsr:@std/assert`）、`BadRequestError`、`RuntimeConfig`、`_resetSystemSettingsForTest`。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-core && deno task test:domain gateway`
Expected: FAIL —— 现有实现用 `llmConfig.provider_id`（undefined），且不会校验平台默认。

- [ ] **Step 3: 实现**

`noj-core/src/domains/gateway/services/llm-token.ts` 修改 `buildJudgeTaskLlm` 函数体（签名不变）：

```ts
export async function buildJudgeTaskLlm(
  llmConfig: LlmConfig,
  submissionId: string,
  problemId: string,
  userId: string,
  runtimeConfig: RuntimeConfig,
): Promise<JudgeTaskLlm> {
  const platform = getLlmPlatformDefault();
  if (!platform) {
    throw new BadRequestError(
      "平台未配置默认 LLM Provider / 模型，无法评测 LLM 题",
    );
  }
  const provider = await getLlmProviderById(platform.provider_id).catch(
    () => null,
  );
  if (!provider || !provider.enabled) {
    throw new BadRequestError("平台默认 LLM Provider 不存在或已停用");
  }

  const gatewayUrl = Deno.env.get("NOJ_LLM_GATEWAY_URL") ??
    "http://localhost:8001";
  const timeLimitMs = runtimeConfig.evaluator.time_limit_ms;
  const ttlSeconds = Math.max(60, Math.ceil((timeLimitMs * 4) / 1000));
  const now = Math.floor(Date.now() / 1000);
  const limits = resolveLlmLimits(llmConfig);
  const token = await mintEvalToken({
    jti: crypto.randomUUID(),
    submission_id: submissionId,
    problem_id: problemId,
    user_id: userId,
    provider_id: platform.provider_id,
    allowed_models: [platform.model],
    iat: now,
    exp: now + ttlSeconds,
    max_calls: limits.max_calls,
    max_tokens: limits.max_tokens,
  });
  return {
    gateway_url: gatewayUrl,
    eval_token: token,
    provider_id: platform.provider_id,
    allowed_models: [platform.model],
  };
}
```

import 区加入：

```ts
import { BadRequestError } from "../../../shared/base/errors.ts";
import { getLlmPlatformDefault, getLlmProviderById } from "./llm.ts";
```

> 注意：`llm.ts` 与 `llm-token.ts` 互相 import 吗？`llm.ts` 不 import `llm-token.ts`，无循环。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-core && deno task test:domain gateway`
Expected: PASS（含 Task 2/3 用例）。

- [ ] **Step 5: 提交**

```bash
git add noj-core/src/domains/gateway/services/llm-token.ts noj-core/src/domains/gateway/tests/services/llm-problem.test.ts
git commit -S -m "feat(core): eval_token 使用平台默认 Provider/模型签发"
```

---

## Task 5: 题目 CRUD 删除 Provider 校验

**Files:**
- Modify: `noj-core/src/domains/catalog/services/problems/problems-crud.ts`
- Test: `noj-core/src/domains/catalog/tests/services/problem-bundle.test.ts`、`noj-core/src/domains/catalog/tests/services/problems-llm-limits.test.ts`

**Interfaces:**
- Consumes: 既有 `assertLlmLimitsWithinDefault`、`isValidLlmConfig`。
- Produces: create/update 不再调用 `getLlmProviderById`；校验点仅剩「P 型 + 非客观题 + 网络开启 + 预算天花板」。

- [ ] **Step 1: 写失败测试**

在 `problems-llm-limits.test.ts` 中，删除 `stubEnabledLlmProvider` 的使用与定义（create/update 不再需要 stub provider），并把两处 `llm: { provider_id: "p-does-not-matter", model: "m", max_calls: … }` 改为 `llm: { max_calls: … }`（update 用例改为 `llm: { max_tokens: … }`）。

新增「启用 LLM 不再要求 provider」用例：

```ts
Deno.test({
  name: "problems-llm-limits: 启用 LLM 不再校验 provider 存在性",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const adminId = await createAdminUser();
    const created = await createProblem(
      {
        title: `LLM 无 provider ${Date.now()}`,
        description: "d",
        type: "P",
        runtime_config: NETWORKED_RUNTIME_CONFIG,
        llm: { max_calls: 5 },
      },
      adminId,
      "admin",
    );
    assert(created.llm_config !== undefined);
  },
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-core && deno task test:domain catalog`
Expected: FAIL —— 当前实现读 `input.llm.provider_id`（undefined）→ `getLlmProviderById` 失败 → 抛「LLM Provider 不存在或已停用」。

- [ ] **Step 3: 删除 provider 校验**

`problems-crud.ts`：

(a) 删除 import 中的 `getLlmProviderById`（保留 `assertLlmLimitsWithinDefault`）：

```ts
import { assertLlmLimitsWithinDefault } from "../../../gateway/index.ts";
```

(b) create 分支（约 184-189 行）删除：

```ts
    const provider = await getLlmProviderById(input.llm.provider_id).catch(
      () => null,
    );
    if (!provider || !provider.enabled) {
      throw new BadRequestError("LLM Provider 不存在或已停用");
    }
```

(c) update 分支（约 442-447 行）同样删除该块。

保留 `isValidLlmConfig`、`assertLlmLimitsWithinDefault`、P 型/客观题/网络校验不变。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-core && deno task test:domain catalog`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add noj-core/src/domains/catalog/services/problems/problems-crud.ts noj-core/src/domains/catalog/tests/services/problems-llm-limits.test.ts
git commit -S -m "refactor(core): 题目 CRUD 不再校验 Provider，改由提交时校验"
```

---

## Task 6: noj-cli 契约副本与共享 fixture

**Files:**
- Modify: `noj-cli/src/problem/vendor/problems.ts`、`noj-cli/src/problem/vendor/problem-bundle.ts`
- Modify: `fixtures/problem-bundle-manifest.json`
- Test: `noj-cli/src/problem/contract_test.ts`、`noj-core/src/domains/catalog/tests/types/problem-bundle-contract.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `LlmConfig` / `isValidLlmConfig` 语义。
- Produces: noj-cli 侧与 core 侧行为一致（双侧 fixture 契约测试全绿）。

- [ ] **Step 1: 更新共享 fixture**

`fixtures/problem-bundle-manifest.json`：

(a) 反例 `"LLM 未开 evaluator 网络"` 的 `llm` 改为合法预算形状：

```json
        "llm": {
          "max_calls": 1
        },
```

（使其**只**因未开网络被拒，匹配测试名。）

(b) 在 `valid` 数组追加正例（锁住旧字段容忍语义）：

```json
    {
      "name": "LLM 旧形状 provider_id/model 被容忍",
      "manifest": {
        "format_version": 1,
        "title": "x",
        "type": "P",
        "llm": {
          "provider_id": "old-provider",
          "model": "old-model",
          "max_calls": 10
        },
        "runtime_config": {
          "evaluator": {
            "image": "i",
            "command": "c",
            "time_limit_ms": 1,
            "memory_limit_mb": 1,
            "network": { "enabled": true }
          },
          "solution": {
            "image": "i",
            "call_timeout_ms": 1,
            "memory_limit_mb": 1
          }
        }
      }
    }
```

- [ ] **Step 2: 运行契约测试，确认同步前的基线**

Run: `cd noj-cli && deno test -A src/problem/contract_test.ts`
Run: `cd noj-core && deno task test:domain catalog`

Expected: 两侧仍 PASS。说明：新反例 `{ max_calls: 1 }` 在旧实现下同样因缺 `provider_id`/`model` 被拒，新正例「旧形状」在旧实现下本就合法——因此这两处 fixture 变更不会产生红灯，属**语义锁定**（把当前已成立的行为固化）。真正的红灯来自 Task 3 已经把 core 侧 `isValidLlmConfig` 改宽，此时若 noj-cli 副本未同步，两侧对同一 fixture 的判定会出现分叉；本 Task 的作用是消除该分叉。继续 Step 3。

- [ ] **Step 3: 同步 noj-cli 副本**

`noj-cli/src/problem/vendor/problems.ts`：把 `LlmConfig` 接口与 `isValidLlmConfig` 改为与 Task 3 完全一致（含注释）。文件头「刻意副本」注释保留。

`noj-cli/src/problem/vendor/problem-bundle.ts`：无需改逻辑（复用 `isValidLlmConfig`）；确认 `ProblemBundleManifest.llm` 类型随 `LlmConfig` 收缩。

- [ ] **Step 4: 双侧契约测试全绿**

Run: `cd noj-cli && deno test -A src/problem/contract_test.ts`
Expected: PASS。

Run: `cd noj-core && deno task test:domain catalog`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add noj-cli/src/problem/vendor/problems.ts noj-cli/src/problem/vendor/problem-bundle.ts fixtures/problem-bundle-manifest.json
git commit -S -m "refactor(root): 题包 manifest 校验同步预算化 LLM 配置"
```

---

## Task 7: gateway 删除 provider.model 列

**Files:**
- Modify: `noj-llm-gateway/src/db/schema.ts`、`src/providers.ts`、`src/routes/internal.ts`
- Create: `noj-llm-gateway/drizzle/0003_remove_provider_model.sql`
- Test: `noj-llm-gateway/tests/providers_test.ts`、`noj-llm-gateway/tests/helpers.ts`

**Interfaces:**
- Produces: `ProviderInput` / `ProviderRow` / `ProviderView` 不再含 `model`；`POST /internal/providers/:id/test` 接受可选 body `{ model }`。

- [ ] **Step 1: 写失败测试**

`noj-llm-gateway/tests/providers_test.ts`：

(a) `makeProvider` 断言相关：把 `{ name: "新名称", model: "新模型", … }` 改为 `{ name: "新名称", enabled: false, cost_per_1k_tokens: 2, api_key: "sk-new-test-key" }`。

(b) 删除 `assertEquals(result.model, input.model ?? "deepseek-chat");`。

`noj-llm-gateway/tests/helpers.ts`：

- `makeProvider` 返回对象删除 `model: "deepseek-chat"`。
- `makeToken` 的 `model` 参数保留（用于 eval_token `allowed_models`），与 provider 无关。

新增连通性测试（若现有 `testProviderConnection` 有用例，改造之）：

```ts
Deno.test("providers: 连通性测试必须显式指定 model", async () => {
  const provider = await makeProvider(testConfig.storeKey);
  const { db } = createFakeDb(provider);
  await assertRejects(
    () => testProviderConnection(db, provider.id, testConfig.storeKey),
    Error,
    "model_required",
  );
});
```

在 import 中加入 `testProviderConnection` 与 `assertRejects`。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-llm-gateway && deno task test`
Expected: FAIL —— 类型/断言不一致；`testProviderConnection` 仍读 `row.model`。

- [ ] **Step 3: 改 schema 与 providers.ts**

`src/db/schema.ts`：删除 `llm_providers` 的 `model` 列定义及其注释。

`src/providers.ts`：

- `ProviderInput`、`ProviderRow`、`ProviderView` 删除 `model` 字段。
- `toView` 删除 `model: row.model`。
- `createProvider` 的 INSERT 去掉 `model` 列与 `${input.model}` 参数：

```ts
  await db`
    INSERT INTO llm_providers (id, name, base_url, cost_per_1k_tokens, encrypted_api_key, enabled, created_at, updated_at)
    VALUES (${id}, ${input.name}, ${input.base_url}, ${
    input.cost_per_1k_tokens ?? 0
  }, ${encrypted}, ${input.enabled ?? true}, ${createdAt}, ${createdAt})
  `;
```

- `updateProvider` 的 `Pick<...>` 去掉 `"model"`，删除 `if (input.model !== undefined) { … }` 分支。
- `testProviderConnection` 签名加 `model: string`：

```ts
export async function testProviderConnection(
  db: Db,
  id: string,
  storeKey: string,
  model: string,
): Promise<void> {
  if (!model.trim()) {
    throw new Error("model_required");
  }
  const row = await getProviderById(db, id);
  if (!row) {
    throw new Error("provider_not_found");
  }
  const baseUrl = row.base_url;
  const { apiKey } = await getProviderSecret(db, id, storeKey);
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("provider_unavailable");
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error("provider_auth_failed");
  }
  if (response.status === 429) throw new Error("provider_rate_limited");
  if (!response.ok) throw new Error("provider_error");
}
```

- [ ] **Step 4: 改 internal 路由**

`src/routes/internal.ts`：

- `GET /internal/providers/:id` 的 SELECT 去掉 `model`：

```ts
    const rows = await deps
      .db`SELECT id, name, base_url, cost_per_1k_tokens, enabled, created_at, updated_at FROM llm_providers WHERE id = ${id}`;
```

- `POST /internal/providers` 必填校验去掉 `body.model`：

```ts
    if (!body.name || !body.base_url || !body.api_key) {
      return c.json({ error: "missing_required_fields" }, 400);
    }
```

- `POST /internal/providers/:id/test` 读取 body.model：

```ts
  app.post("/internal/providers/:id/test", async (c) => {
    const body = await c.req.json<{ model?: string }>().catch(() => ({}));
    try {
      await testProviderConnection(
        deps.db,
        c.req.param("id"),
        deps.config.storeKey,
        body.model ?? "",
      );
      return c.json({ data: { status: "ok" } });
    } catch (err) {
      const code = err instanceof Error ? err.message : "provider_error";
      const status = code === "provider_not_found"
        ? 404
        : code === "model_required"
        ? 400
        : 502;
      return c.json({ error: code }, status);
    }
  });
```

- [ ] **Step 5: 新增迁移**

`noj-llm-gateway/drizzle/0003_remove_provider_model.sql`：

```sql
-- 移除 Provider 级默认模型：默认模型改由 noj-core 平台设置（llm_default_model）统一决定。
-- 运行时转发本就不读 provider.model；此列为死列。破坏性变更，升级前须备份。
ALTER TABLE llm_providers DROP COLUMN IF EXISTS model;
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd noj-llm-gateway && deno task test`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add noj-llm-gateway/src/db/schema.ts noj-llm-gateway/src/providers.ts noj-llm-gateway/src/routes/internal.ts noj-llm-gateway/drizzle/0003_remove_provider_model.sql noj-llm-gateway/tests/providers_test.ts noj-llm-gateway/tests/helpers.ts
git commit -S -m "refactor(gateway): 移除 Provider 级 model 死列"
```

---

## Task 8: core gateway 客户端与 admin 路由去 model

**Files:**
- Modify: `noj-core/src/domains/gateway/services/llm.ts`、`noj-core/src/domains/admin/routes/gateway.ts`
- Test: 依赖 `deno task check:types`

**Interfaces:**
- Consumes: gateway 内部 API 不再返回 `model`（Task 7）。
- Produces: `LlmProviderInput` / `LlmProviderView` 无 `model`；admin 创建 Provider 不再要求 `model`。

- [ ] **Step 1: 改客户端类型**

`noj-core/src/domains/gateway/services/llm.ts`：

- `LlmProviderInput` 删除 `model: string;` 及其注释。
- `LlmProviderView` 删除 `model: string;` 及其注释。

- [ ] **Step 2: 改 admin 路由**

`noj-core/src/domains/admin/routes/gateway.ts`：

- `POST /llm/providers` 必填校验改为：

```ts
  if (!body.name || !body.base_url || !body.api_key) {
    return c.json({ error: "缺少必填字段" }, 400);
  }
```

- 更新路由注释 `body: { name, base_url, api_key, cost_per_1k_tokens?, enabled? }`。

- [ ] **Step 3: 类型检查**

Run: `cd noj-core && deno task check:types`
Expected: PASS（若 `problems-crud` 等仍有 `provider.model` 引用会在此暴露，同步清理）。

- [ ] **Step 4: 运行受影响测试**

Run: `cd noj-core && deno task test:domain gateway`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add noj-core/src/domains/gateway/services/llm.ts noj-core/src/domains/admin/routes/gateway.ts
git commit -S -m "refactor(core): Provider 客户端与 admin 路由移除 model 字段"
```

---

## Task 9: noj-ui 出题编辑器与 Provider 管理页

**Files:**
- Modify: `noj-ui/components/editor/CodingProblemEditor.vue`
- Modify: `noj-ui/pages/admin/llm/providers.vue`
- Modify: `noj-ui/pages/admin/settings.vue`

**Interfaces:**
- Consumes: core 题目 API 的 `llm` 只含预算字段；admin Provider API 无 `model`。
- Produces: 编辑器 payload `llm = {}` 或 `{ max_calls?, max_tokens? }`；Provider 页无「默认模型」。

- [ ] **Step 1: 改出题编辑器**

`CodingProblemEditor.vue`：

(a) 删除 `llmProviderId` / `llmModel` / `llmProviders` 三个 ref 与 `loadLlmProviders()` 函数、`onMounted(() => loadLlmProviders())` 调用。

(b) 回填逻辑（编辑模式）删除 `llmProviderId.value = llmConfig.provider_id` 与 `llmModel.value = llmConfig.model`，只保留 `llmEnabled` / `llmMaxCalls` / `llmMaxTokens`。

(c) 校验逻辑删除 `if (!llmProviderId.value.trim()) errors.llm_provider = …` 与 `if (!llmModel.value.trim()) errors.llm_model = …`，保留网络开启校验与预算正整数校验。

(d) payload 构造改为：

```ts
    const llmPayload = llmEnabled.value
      ? {
          ...(llmMaxCallsNum !== null ? { max_calls: llmMaxCallsNum } : {}),
          ...(llmMaxTokensNum !== null ? { max_tokens: llmMaxTokensNum } : {}),
        }
      : null
```

(e) template 删除 Provider 下拉（`USelect`）与模型输入（`llmModel` input）及其 fieldErrors；文案改为：

```html
                  <span class="block text-xs text-text-muted">启用后必须开启 Evaluator 联网；模型与供应商由平台统一配置</span>
```

- [ ] **Step 2: 改 Provider 管理页**

`noj-ui/pages/admin/llm/providers.vue`：

- 删除接口字段 `model: string`（类型定义第 19 行附近）。
- 删除表格列 `{ key: "model", label: "默认模型" }`。
- 删除 `formModel` ref 及其在 `openCreate` / `openEdit` / 校验 / payload 中的所有引用。
- 删除表单中的「默认模型」输入块。

- [ ] **Step 3: 设置页分类标签**

`noj-ui/pages/admin/settings.vue` 的 `CATEGORY_LABEL` 增加：

```ts
  llm: "LLM",
```

- [ ] **Step 4: 类型检查**

Run: `cd noj-ui && deno task check:types`（若该 task 不存在，用 `deno check` 或项目既有 ui 类型检查命令）
Expected: PASS。

- [ ] **Step 5: 运行前端检查**

Run: `cd noj-ui && deno lint && deno fmt --check`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add noj-ui/components/editor/CodingProblemEditor.vue noj-ui/pages/admin/llm/providers.vue noj-ui/pages/admin/settings.vue
git commit -S -m "refactor(ui): 出题编辑器与 Provider 管理页移除模型选择"
```

---

## Task 10: e2e 与文档

**Files:**
- Modify: `noj-tests/e2e/cross-domain/llm_gateway.test.ts`
- Modify: `noj-docs/docs/problemsetters/llm-problem.md`、`noj-docs/docs/standards/problem-bundle.md`、`noj-docs/docs/operators/llm-call-capability.md`
- Create: `.agents/notes/implemented/<分类>/2026-09-21-llm-capability-platform-config-decoupling.md`

**Interfaces:**
- Consumes: Task 1 的设置键与 admin 设置 API `PUT /api/v1/admin/system/settings/:key`。
- Produces: e2e 在 Setup 阶段写入平台默认；题包 manifest 用新形状。

- [ ] **Step 1: 更新 e2e manifest 构造**

`llm_gateway.test.ts` 的 `llmManifest()`：把

```ts
    ...(includeLlm
      ? { llm: { provider_id: providerId, model: MOCK_MODEL } }
      : {}),
```

改为：

```ts
    ...(includeLlm ? { llm: { max_calls: 30 } } : {}),
```

- [ ] **Step 2: e2e Setup 写入平台默认**

在 Setup 用例创建 Provider 成功后（拿到 `providerId` 之后）追加：

```ts
  // 平台默认：题目不再携带 provider/model，改由平台设置提供
  const setProvider = await apiPut(
    "/api/v1/admin/system/settings/llm_default_provider_id",
    { value: providerId },
    adminToken,
  );
  if (setProvider.status !== 200) {
    throw new Error(
      `写入默认 Provider 失败: ${setProvider.status} ${
        JSON.stringify(setProvider.body)
      }`,
    );
  }
  const setModel = await apiPut(
    "/api/v1/admin/system/settings/llm_default_model",
    { value: MOCK_MODEL },
    adminToken,
  );
  if (setModel.status !== 200) {
    throw new Error(
      `写入默认模型失败: ${setModel.status} ${JSON.stringify(setModel.body)}`,
    );
  }
```

- [ ] **Step 3: 运行 e2e（需完整栈）**

Run: `cd noj-tests && deno task test:domain cross-domain`
Expected: PASS（无完整栈时按既有 `isE2E` 守卫跳过）。

- [ ] **Step 4: 更新文档**

- `noj-docs/docs/problemsetters/llm-problem.md`：题目配置段落改为 `llm` 只含预算，说明「Provider/模型由平台统一配置」；删除 `provider_id`/`model` 说明与示例。
- `noj-docs/docs/standards/problem-bundle.md`：`llm` 字段行改为 `{ max_calls?, max_tokens? }`；示例同步。
- `noj-docs/docs/operators/llm-call-capability.md`：新增「配置平台默认 Provider 与模型」步骤（后台 系统设置 → LLM；部署者必须同时配置两项，env 兜底 `NOJ_LLM_DEFAULT_PROVIDER_ID` / `NOJ_LLM_DEFAULT_MODEL`）。

- [ ] **Step 5: 新增 Agent Note**

`.agents/notes/implemented/architecture/2026-09-21-llm-capability-platform-config-decoupling.md`（按 `.agents/notes/README.md` 格式：`# Agent Note: <标题>` + `Status: implemented` + Problem / Decision / Alternatives considered / Consequences）。

- [ ] **Step 6: 校验 Agent Note 与文档**

Run: `deno run -A scripts/verify-agent-note-format.ts`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add noj-tests/e2e/cross-domain/llm_gateway.test.ts noj-docs .agents/notes
git commit -S -m "docs(root): LLM 能力解耦的 e2e 与文档更新"
```

---

## Task 11: 全链路门禁

**Files:** 无（仅校验）

- [ ] **Step 1: 格式与静态检查**

```bash
cd noj-core && deno fmt --check && deno lint
cd noj-cli && deno fmt --check && deno lint
cd noj-llm-gateway && deno fmt --check && deno lint
cd noj-ui && deno fmt --check && deno lint
```

Expected: 全部 PASS。

- [ ] **Step 2: 域边界与配置一致性**

```bash
cd noj-core && deno task check:domains
cd noj-core && deno task check:env
cd noj-core && deno task check:config-usage
```

Expected: 全部 PASS（新 runtime 键有真实读取点 `getLlmPlatformDefault`）。

- [ ] **Step 3: 契约与类型**

```bash
cd noj-core && deno task check:types
cd noj-cli && deno test -A src/problem/contract_test.ts
```

Expected: PASS。

- [ ] **Step 4: 域测试**

Run: `cd noj-core && deno task test:domain gateway && deno task test:domain catalog && deno task test:domain system`
Expected: PASS。

Run: `cd noj-llm-gateway && deno task test`
Expected: PASS。

- [ ] **Step 5: Rust 编译验证（未改代码，确认契约未破）**

Run: `cd noj-judge && cargo fmt --check && cargo clippy --all-targets`
Expected: PASS。

> `JudgeTaskLlm` 未变更，Rust 侧无需改动；此步仅确认无意外影响。

- [ ] **Step 6: 最终提交（如有格式修复）**

```bash
git add -A
git commit -S -m "chore(root): LLM 能力解耦门禁修复"
```

---

## 自检记录

**Spec 覆盖：**

| Spec 章节 | 对应 Task |
| --- | --- |
| §3.1 llm_config 收缩 | Task 3 |
| §3.2 平台默认设置项 | Task 1、2 |
| §4 解析与签发 | Task 2、4 |
| §4.4 CRUD 校验变化 | Task 5 |
| §5 删除 provider.model | Task 7、8 |
| §6 manifest | Task 3、6 |
| §7 noj-ui 编辑器 | Task 9 |
| §8 noj-cli 副本 | Task 6 |
| §9 文档 | Task 10 |
| §11 测试计划 | 各 Task + Task 11 |
| §12 执行顺序 | Task 1→11 顺序一致 |
| §13 验证 | Task 11 |

**占位符扫描：** 无 TBD/TODO；所有代码步骤含实际代码。

**类型一致性：** `getLlmPlatformDefault()`（Task 2 定义，Task 4 消费）、`testProviderConnection(db, id, storeKey, model)`（Task 7 定义并消费）、`LlmConfig = { max_calls?, max_tokens? }`（Task 3 定义，Task 4/5/6 消费）在计划内命名一致。
