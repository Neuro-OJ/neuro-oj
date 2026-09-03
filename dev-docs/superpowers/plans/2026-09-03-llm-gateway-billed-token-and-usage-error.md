# llm-gateway 精确 billed-token 计费与 out_of_usage 错误实施计划

> **给 agentic worker:** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实施本计划。步骤使用复选框（`- [ ]`）语法跟踪。

**Goal:** 让 noj-llm-gateway 按“缓存未命中输入 + 输出”的 billed token 进行单次评测限额/配额/成本核算，并在超限时返回 OpenAI 兼容的 `out_of_usage` 错误结构。

**Architecture:** 新增纯函数 `src/billing.ts` 负责从上游 usage 提取缓存命中并计算 billed token；`routes/llm.ts` 在上游响应后使用 billed token 计算实际成本并调用 `settleUsage`；`limits.ts` 的 `settleUsage` 增加 `actualBilledTotalTokens` 以按 billed 数量调整 submission token 计数；`llm_usage` 表增加缓存/billed 审计列；超限错误统一为 OpenAI 兼容结构。

**Tech Stack:** Deno 2 + Hono + postgres.js + ioredis；测试用 Deno 标准断言。

**Spec:** `dev-docs/superpowers/specs/2026-09-03-snowy-manor-trial-agent-design.md`（§6、§8.1）

## 全局约束

- Deno 代码：`deno fmt` + `deno lint`（CI 强制）；中文注释 + 英文标识符；
- 测试通过 `cd noj-llm-gateway && deno task test` 运行；不要手拼 `deno test` 之外的执行方式；
- 迁移文件命名：`drizzle/0001_*.sql`，追加不改旧文件；
- 禁止手动修改 `deno.lock`；新 import 通过 `deno task`/deno.json imports 管理；
- 提交：`feat(gateway): 中文描述`，GPG 签名；本地优先 `jj describe` + `jj git push`，若仓库实际用 git 则 `git commit -S`；
- 涉及 `llm_usage` 的改动要同步更新 `src/db/schema.ts`（Drizzle schema）与 SQL 迁移；
- 非平凡变更需 Agent Note（`.agents/notes/implemented/`，格式见 AGENTS.md）。

---

### Task 1: 新增 billing 纯函数与单测

**Files:**
- Create: `noj-llm-gateway/src/billing.ts`
- Test: `noj-llm-gateway/tests/billing_test.ts`

**Interfaces:**
- Produces:
  - `interface UpstreamUsage { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }`
  - `interface BilledUsage { promptTokens: number; completionTokens: number; totalTokens: number; cachedPromptTokens: number; billedPromptTokens: number; billedTotalTokens: number }`
  - `function calcBilledUsage(usage: UpstreamUsage | undefined, fallbackPromptTokens: number, fallbackCompletionTokens: number): BilledUsage`

- [ ] **Step 1: 写失败测试**

Create `noj-llm-gateway/tests/billing_test.ts`:

```ts
import { assertEquals } from "jsr:@std/assert@^1";
import { calcBilledUsage } from "../src/billing.ts";

Deno.test("billing: 无 usage 时回退估算值，不产生缓存扣除", () => {
  const r = calcBilledUsage(undefined, 100, 50);
  assertEquals(r.promptTokens, 100);
  assertEquals(r.completionTokens, 50);
  assertEquals(r.cachedPromptTokens, 0);
  assertEquals(r.billedPromptTokens, 100);
  assertEquals(r.billedTotalTokens, 150);
});

Deno.test("billing: 有 cached_tokens 时 billedPrompt = prompt - cached", () => {
  const r = calcBilledUsage(
    {
      prompt_tokens: 200,
      completion_tokens: 30,
      total_tokens: 230,
      prompt_tokens_details: { cached_tokens: 180 },
    },
    300,
    100,
  );
  assertEquals(r.promptTokens, 200);
  assertEquals(r.completionTokens, 30);
  assertEquals(r.cachedPromptTokens, 180);
  assertEquals(r.billedPromptTokens, 20);
  assertEquals(r.billedTotalTokens, 50);
});

Deno.test("billing: cached 超过 prompt 时按 0 处理", () => {
  const r = calcBilledUsage(
    {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 99 },
    },
    10,
    5,
  );
  assertEquals(r.billedPromptTokens, 0);
  assertEquals(r.billedTotalTokens, 5);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-llm-gateway && deno task test tests/billing_test.ts`
Expected: FAIL——`Cannot resolve "../src/billing.ts"` 或函数不存在。

- [ ] **Step 3: 实现 billing.ts**

Create `noj-llm-gateway/src/billing.ts`:

```ts
/**
 * LLM 用量 billed-token 计算。
 *
 * OpenAI 兼容上游可能在 usage.prompt_tokens_details.cached_tokens 返回缓存命中
 * 的 prompt token；真实计费/限额应按 billed = (prompt - cached) + completion。
 */
export interface UpstreamUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
}

export interface BilledUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens: number;
  billedPromptTokens: number;
  billedTotalTokens: number;
}

/** 计算 billed usage；无上游 usage 时回退到估算值。 */
export function calcBilledUsage(
  usage: UpstreamUsage | undefined,
  fallbackPromptTokens: number,
  fallbackCompletionTokens: number,
): BilledUsage {
  const promptTokens = Math.floor(usage?.prompt_tokens ?? fallbackPromptTokens);
  const completionTokens = Math.floor(
    usage?.completion_tokens ?? fallbackCompletionTokens,
  );
  const cachedPromptTokens = Math.max(
    0,
    Math.floor(usage?.prompt_tokens_details?.cached_tokens ?? 0),
  );
  const billedPromptTokens = Math.max(0, promptTokens - cachedPromptTokens);
  const totalTokens = Math.floor(
    usage?.total_tokens ?? (promptTokens + completionTokens),
  );
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedPromptTokens,
    billedPromptTokens,
    billedTotalTokens: billedPromptTokens + completionTokens,
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-llm-gateway && deno task test tests/billing_test.ts`
Expected: PASS

- [ ] **Step 5: fmt/lint + 提交**

Run: `cd noj-llm-gateway && deno task fmt && deno task lint`
Commit: `feat(gateway): 新增 billed-token 用量计算纯函数`

---

### Task 2: llm_usage 表增加缓存/billed 审计列

**Files:**
- Create: `noj-llm-gateway/drizzle/0001_llm_usage_billed_tokens.sql`
- Modify: `noj-llm-gateway/src/db/schema.ts`（`llmUsage` 表定义）

**Interfaces:**
- Consumes: 无
- Produces:
  - DB 新列：`cached_prompt_tokens integer NOT NULL DEFAULT 0`
  - DB 新列：`billed_prompt_tokens integer NOT NULL DEFAULT 0`
  - DB 新列：`billed_total_tokens integer NOT NULL DEFAULT 0`
  - `src/db/schema.ts` 中 `llmUsage` 增加对应 Drizzle 列

- [ ] **Step 1: 写迁移 SQL**

Create `noj-llm-gateway/drizzle/0001_llm_usage_billed_tokens.sql`:

```sql
ALTER TABLE "llm_usage" ADD COLUMN IF NOT EXISTS "cached_prompt_tokens" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN IF NOT EXISTS "billed_prompt_tokens" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN IF NOT EXISTS "billed_total_tokens" integer NOT NULL DEFAULT 0;
```

- [ ] **Step 2: 更新 Drizzle schema**

Modify `noj-llm-gateway/src/db/schema.ts` in `llmUsage` table, after `total_tokens`:

```ts
    /** 上游返回的缓存命中 prompt token 数 */
    cached_prompt_tokens: integer("cached_prompt_tokens").notNull().default(0),
    /** 实际计费 prompt token：prompt_tokens - cached_tokens */
    billed_prompt_tokens: integer("billed_prompt_tokens").notNull().default(0),
    /** 实际计费总 token：billed_prompt_tokens + completion_tokens */
    billed_total_tokens: integer("billed_total_tokens").notNull().default(0),
```

- [ ] **Step 3: 运行现有测试/迁移可执行性**

Run: `cd noj-llm-gateway && deno task fmt && deno task lint && deno task test`
Expected: PASS（无需真实 DB；若本地有 DB 可 `deno task db:migrate` 验证迁移）

- [ ] **Step 4: 提交**

Commit: `feat(gateway): llm_usage 增加 billed-token 审计列`

---

### Task 3: usage 记录写入 billed 字段

**Files:**
- Modify: `noj-llm-gateway/src/usage.ts`

**Interfaces:**
- Consumes: `UsageEntry` 现有字段
- Produces: `UsageEntry` 增加可选字段 `cached_prompt_tokens? / billed_prompt_tokens? / billed_total_tokens?`，INSERT 语句包含三列默认 0

- [ ] **Step 1: 更新 UsageEntry 与 recordUsage**

Modify `src/usage.ts`:

在 `UsageEntry` 现有字段列表末尾追加三行（不删除任何现有字段）：

```ts
  cached_prompt_tokens?: number;
  billed_prompt_tokens?: number;
  billed_total_tokens?: number;
```

在 `recordUsage` 的 INSERT 列与值中追加：

```ts
      cached_prompt_tokens, billed_prompt_tokens, billed_total_tokens,
```
```ts
      ${entry.cached_prompt_tokens ?? 0}, ${entry.billed_prompt_tokens ?? 0},
      ${entry.billed_total_tokens ?? 0},
```

具体位置：在 `completion_tokens`/`total_tokens` 列之后插入，保持顺序与 SQL 一致。

- [ ] **Step 2: fmt/lint/测试**

Run: `cd noj-llm-gateway && deno task fmt && deno task lint && deno task test`
Expected: PASS

- [ ] **Step 3: 提交**

Commit: `feat(gateway): usage 审计记录写入 billed-token 明细`

---

### Task 4: settleUsage 支持 billed total token 结算

**Files:**
- Modify: `noj-llm-gateway/src/limits.ts`

**Interfaces:**
- Consumes: 现有 `settleUsage` 调用
- Produces: `settleUsage` opts 增加 `actualBilledTotalTokens: number`；token 增量改为 `actualBilledTotalTokens - (promptTokens + completionTokens)`；其余成本/配额增量使用基于 billed 的 `actualCost`

- [ ] **Step 1: 修改 settleUsage 签名与增量计算**

In `src/limits.ts`, change `settleUsage` opts:

```ts
  opts: {
    promptTokens: number;
    completionTokens: number;
    estimatedCost: number;
    actualPromptTokens: number;
    actualCompletionTokens: number;
    actualBilledTotalTokens: number;
    actualCost: number;
    ip: string;
    ttlSeconds: number;
  },
```

Replace:

```ts
  const deltaTokens = (opts.actualPromptTokens + opts.actualCompletionTokens) -
    (opts.promptTokens + opts.completionTokens);
```

with:

```ts
  const deltaTokens = opts.actualBilledTotalTokens -
    (opts.promptTokens + opts.completionTokens);
```

> `actualPromptTokens`/`actualCompletionTokens` 仍保留用于调用方审计；若后续需要按实际 total 审计可在调用方另行使用。

- [ ] **Step 2: 运行现有测试**

Run: `cd noj-llm-gateway && deno task test`
Expected: PASS（现有测试未直接断言 settleUsage 内部 delta；类型检查会暴露调用方缺字段）

- [ ] **Step 3: fmt/lint**

Run: `cd noj-llm-gateway && deno task fmt && deno task lint`
Expected: PASS

- [ ] **Step 4: 提交**

Commit: `feat(gateway): settleUsage 按 billed-token 调整单次提交计数`

---

### Task 5: 路由层计算 billed token 并传参；超限返回 OpenAI 兼容错误

**Files:**
- Modify: `noj-llm-gateway/src/routes/llm.ts`

**Interfaces:**
- Consumes: `calcBilledUsage`、`settleUsage` 新签名
- Produces: 上游响应后实际用量以 billed 为准；所有超限/额度错误返回 OpenAI 兼容结构

- [ ] **Step 1: 导入 billing 模块并增加错误响应 helper**

在 `src/routes/llm.ts` import 区加入：

```ts
import { calcBilledUsage } from "../billing.ts";
```

在 `createLlmRouter` 外新增：

```ts
function openAiLimitError(message: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: "Out of usage for this evaluation",
        type: "invalid_request_error",
        code: "out_of_usage",
      },
    }),
    {
      status: 429,
      headers: { "content-type": "application/json" },
    },
  );
}
```

- [ ] **Step 2: 替换 enforceAndCount 超限返回**

将当前 catch 块中的返回行：

```ts
      return c.json({ error: message }, 429);
```

改为：

```ts
      return openAiLimitError(message);
```

`recordUsage` 调用参数保持不变（Task 3 已让可选 billed 字段默认为 0）。

- [ ] **Step 3: 替换 settleUsage 超限返回与 billed 计算**

将上游响应后的解析块从：

```ts
    const actualPromptTokens = Math.floor(usage?.prompt_tokens ?? promptTokens);
    const actualCompletionTokens = Math.floor(
      usage?.completion_tokens ?? 0,
    );
    const actualTotalTokens = Math.floor(
      usage?.total_tokens ?? (actualPromptTokens + actualCompletionTokens),
    );
    const actualCost = estimateCost(
      actualTotalTokens,
      providerSecret.provider.cost_per_1k_tokens,
    );
```

改为：

```ts
    const billedUsage = calcBilledUsage(usage, promptTokens, 0);
    const actualPromptTokens = billedUsage.promptTokens;
    const actualCompletionTokens = billedUsage.completionTokens;
    const actualTotalTokens = billedUsage.totalTokens;
    const actualBilledTotalTokens = billedUsage.billedTotalTokens;
    const actualCost = estimateCost(
      actualBilledTotalTokens,
      providerSecret.provider.cost_per_1k_tokens,
    );
```

在调用 `settleUsage` 时传入新字段：

```ts
      await settleUsage(deps.db, deps.redis, payload, {
        promptTokens,
        completionTokens,
        estimatedCost,
        actualPromptTokens,
        actualCompletionTokens,
        actualBilledTotalTokens,
        actualCost,
        ip: c.req.header("x-forwarded-for") ?? "unknown",
        ttlSeconds,
      });
```

替换 settleUsage catch 返回为 `openAiLimitError(message)`。

- [ ] **Step 4: 成功记录 usage 时写入 billed 字段**

在成功/失败 `recordUsage` 中，将 actual 相关调用追加：

```ts
        cached_prompt_tokens: billedUsage.cachedPromptTokens,
        billed_prompt_tokens: billedUsage.billedPromptTokens,
        billed_total_tokens: billedUsage.billedTotalTokens,
```

注意：`recordUsage` 失败分支可能未定义 `billedUsage`（如 enforce 拒绝、upstream error）。只在解析到 `billedUsage` 后的分支（settleUsage catch、正常记录）添加；前面的分支不传这三个可选字段即可（默认 0）。

- [ ] **Step 5: fmt/lint/测试**

Run: `cd noj-llm-gateway && deno task fmt && deno task lint && deno task test`
Expected: PASS（若类型检查指出 `settleUsage` 调用处漏字段则修正）

- [ ] **Step 6: 提交**

Commit: `feat(gateway): 超限返回 OpenAI 兼容 out_of_usage 并按 billed token 结算`

---

### Task 6: 补充端到端/集成验证（可选但有 DB/Redis 时执行）

**Files:**
- Modify: `noj-llm-gateway/tests/limits_test.ts`（补充 settleUsage billed 行为测试，需要 FakeRedis 支持 eval 返回 ok 并记录 args）

**Interfaces:**
- Consumes: `settleUsage`、`EvalTokenPayload`
- Produces: 验证 billed delta 正确性

- [ ] **Step 1: 写失败测试**

在 `noj-llm-gateway/tests/limits_test.ts` 增加：

```ts
import { settleUsage } from "../src/limits.ts";

Deno.test("limits: settleUsage 按 billedTotal 计算 delta", async () => {
  const redis = new FakeRedis();
  // 先 enforce 预占：估算 prompt=100, completion=50 => 预占 150
  await enforceAndCount(emptyDb, redis, { ...payload, max_tokens: 1000 }, {
    model: "model-1",
    promptTokens: 100,
    completionTokens: 50,
    estimatedCost: 1,
    ip: "127.0.0.1",
    ttlSeconds: 60,
    userRateLimitPerMinute: 120,
    ipRateLimitPerMinute: 30,
  });

  // 实际上游 billed total=30（prompt 20 未命中 + completion 10），应把 token 计数调低
  await settleUsage(emptyDb, redis, { ...payload, max_tokens: 1000 }, {
    promptTokens: 100,
    completionTokens: 50,
    estimatedCost: 1,
    actualPromptTokens: 200,
    actualCompletionTokens: 10,
    actualBilledTotalTokens: 30,
    actualCost: 0,
    ip: "127.0.0.1",
    ttlSeconds: 60,
  });

  const meta = JSON.parse(String(redis.lastEvalArgs[0])) as {
    incs: number[];
  };
  // SETTLE_SCRIPT 的 ARGV[0] 是 meta；第一个 token counter inc = -120
  assertEquals(meta.incs[0], -120);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd noj-llm-gateway && deno task test tests/limits_test.ts`
Expected: FAIL——`settleUsage` 尚不接受 `actualBilledTotalTokens` 或 meta 索引不符。

- [ ] **Step 3: 实现/修正后运行**

Run: `cd noj-llm-gateway && deno task test tests/limits_test.ts`
Expected: PASS

- [ ] **Step 4: fmt/lint/提交**

Run: `cd noj-llm-gateway && deno task fmt && deno task lint`
Commit: `test(gateway): settleUsage 按 billed total 结算用例`

---

## 验证清单

- [ ] `deno task test` 全绿；
- [ ] `deno fmt --check` / `deno lint` 通过；
- [ ] mock 上游返回 `prompt_tokens_details.cached_tokens` 时，单次提交 token 计数按 billed 计算；
- [ ] 超限响应体为 `{ error: { message: "Out of usage for this evaluation", type: "invalid_request_error", code: "out_of_usage" } }`；
- [ ] `llm_usage` 新列有值（真实 DB 迁移后可查）。
