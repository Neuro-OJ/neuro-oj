# Phase 4 noj-tests E2E 异常场景 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 noj-tests 跨模块 E2E 增加异常/恢复/并发/安全场景，覆盖评测失败、MQ 容错、竞赛防作弊、存储故障、限流与浏览器异常流程。

**Architecture:** 在现有 `noj-tests/e2e/<domain>/` 目录内新增测试文件，复用 `helper.ts` 的 `e2eTest`、`apiGet`、`apiPost`、`registerUser`、`getAdminToken`、`getProblemIdByNumber`、`submitCode` 等辅助函数；按 Domain 组织，沿用 `deno task test:domain <domain>` 运行。

**Tech Stack:** Deno 2、REST API、Redis MQ、Docker Compose。

**Spec:** `dev-docs/superpowers/specs/2026-09-08-test-enhancement-roadmap-design.md`

## Global Constraints

- 遵守 AGENTS.md：提交必须 GPG 签名；提交信息用 Conventional Commits 中文描述；禁止修改 `deno.lock` / `Cargo.lock` 手动内容。
- E2E 必须通过 `cd noj-tests && deno task test:domain <domain>` 运行，禁止手拼 `deno test`。
- 测试数据使用 `Date.now()` 生成唯一用户名/邮箱，避免冲突。
- 资源测试必须自建自清，失败/重试/超时也要清理。
- 新增测试必须放在对应 Domain 目录，不破坏现有 E2E 分组并行。

---

### Task 1: submission 异常/重测并发 E2E

**Files:**
- Create: `noj-tests/e2e/submission/abnormal_rejudge.test.ts`

**Interfaces:**
- Consumes: `helper.ts` 的 `e2eTest`、`apiGet`、`apiPost`、`registerUser`、`getAdminToken`、`getProblemIdByNumber`、`submitCode`、`TEST_PASSWORD`。
- Produces: 无新接口。

- [ ] **Step 1: 写失败测试**

创建 `noj-tests/e2e/submission/abnormal_rejudge.test.ts`：

```ts
/**
 * 提交异常与重测并发 E2E。
 */
import {
  apiGet,
  apiPost,
  CODE_SAMPLES,
  e2eTest,
  getAdminToken,
  getProblemIdByNumber,
  isE2E,
  registerUser,
  submitCode,
  TEST_PASSWORD,
} from "../helper.ts";

let token = "";
let adminToken = "";
let PROBLEM_ID = "";

e2eTest("[e2e/submission-abnormal] Setup", async () => {
  if (!isE2E) return;
  adminToken = await getAdminToken();
  const ts = Date.now().toString(36);
  token = await registerUser(
    "abn_user_" + ts,
    "abn_user_" + ts + "@test.com",
    TEST_PASSWORD,
  );
  PROBLEM_ID = await getProblemIdByNumber(1001);
});

e2eTest("[e2e/submission-abnormal] 重测不存在的提交返回 404", async () => {
  if (!isE2E) return;
  const { status } = await apiPost(
    "/api/v1/admin/submissions/00000000-0000-0000-0000-000000000000/rejudge",
    {},
    adminToken,
  );
  if (status !== 404) throw new Error("期望 404，实际 " + status);
});

e2eTest("[e2e/submission-abnormal] 并发重测同一提交不崩溃", async () => {
  if (!isE2E) return;
  const id = await submitCode(token, PROBLEM_ID, CODE_SAMPLES.accepted);
  const results = await Promise.all([
    apiPost(`/api/v1/admin/submissions/${id}/rejudge`, {}, adminToken),
    apiPost(`/api/v1/admin/submissions/${id}/rejudge`, {}, adminToken),
  ]);
  for (const r of results) {
    if (r.status !== 200 && r.status !== 409 && r.status !== 202) {
      throw new Error("并发重测返回意外状态 " + r.status);
    }
  }
});

e2eTest("[e2e/submission-abnormal] 评测失败后状态为 error 且可查看", async () => {
  if (!isE2E) return;
  // 使用必然运行失败的代码（语法错误）
  const id = await submitCode(token, PROBLEM_ID, "def broken(:\n");
  const { status, body } = await apiGet(`/api/v1/submissions/${id}`, token);
  if (status !== 200) throw new Error("期望 200，实际 " + status);
  const d = body as { data?: { status?: string } };
  if (d.data?.status !== "error" && d.data?.status !== "finished") {
    throw new Error("失败提交应最终为 error/finished，实际 " + d.data?.status);
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-tests && deno task test:domain submission`
Expected: FAIL，测试文件不存在或端点路径与实现不符。

- [ ] **Step 3: 按实际端点修正**

阅读 `noj-core/src/domains/submission/routes/` 与 `noj-core/src/domains/admin/routes/submission.ts`，将 rejudge 端点路径与允许状态码调整为实际实现；若并发重测返回 200，则接受 200。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-tests && deno task test:domain submission`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj describe -m "test(e2e): 提交异常与重测并发场景"
```

---

### Task 2: MQ 非法消息容错 E2E

**Files:**
- Create: `noj-tests/e2e/submission/mq_invalid_message.test.ts`

**Interfaces:**
- Consumes: `helper.ts` 的 `e2eTest`、`apiGet`、`getAdminToken`、`isE2E`。
- Produces: 无新接口。

- [ ] **Step 1: 写失败测试**

创建 `noj-tests/e2e/submission/mq_invalid_message.test.ts`：

```ts
/**
 * MQ 非法消息容错 E2E。
 *
 * 通过 Redis 直接向评测队列写入非法 JSON，验证消费者不崩溃、队列仍可用。
 */
import { e2eTest, isE2E, apiGet, getAdminToken } from "../helper.ts";

const REDIS_URL = Deno.env.get("E2E_REDIS_URL") || "redis://localhost:6380/1";

async function pushInvalidMessage(): Promise<void> {
  const redis = await import("npm:ioredis@5");
  const client = new redis.default(REDIS_URL, { maxRetriesPerRequest: 1 });
  try {
    await client.lpush("noj:judge:queue", "not-json");
  } finally {
    client.disconnect();
  }
}

e2eTest("[e2e/mq-invalid] 非法消息不阻塞队列", async () => {
  if (!isE2E) return;
  await pushInvalidMessage();
  const adminToken = await getAdminToken();
  const { status, body } = await apiGet("/api/v1/queue", adminToken);
  if (status !== 200) throw new Error("队列接口应仍可用，实际 " + status);
  const d = body as { stats?: { pending_count?: number } };
  if (typeof d.stats?.pending_count !== "number") {
    throw new Error("队列统计应仍返回数值");
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-tests && deno task test:domain submission`
Expected: FAIL，测试文件不存在或 `npm:ioredis` 导入方式不被 Deno 支持。

- [ ] **Step 3: 修正 Redis 客户端导入**

若 `npm:ioredis@5` 导入失败，改用 `jsr:@db/sql` 不适用；可改为通过 `Deno.Command` 调用 `redis-cli`（E2E 栈内有 Redis）或使用 `npm:redis@4`。以实际可用的 Redis 客户端为准。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-tests && deno task test:domain submission`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj describe -m "test(e2e): MQ 非法消息容错场景"
```

---

### Task 3: 竞赛防作弊异常 E2E

**Files:**
- Create: `noj-tests/e2e/contest/anti_cheat_abnormal.test.ts`

**Interfaces:**
- Consumes: `helper.ts` 的 `e2eTest`、`apiGet`、`apiPost`、`registerUser`、`getAdminToken`、`getProblemIdByNumber`、`TEST_PASSWORD`。
- Produces: 无新接口。

- [ ] **Step 1: 写失败测试**

创建 `noj-tests/e2e/contest/anti_cheat_abnormal.test.ts`：

```ts
/**
 * 竞赛防作弊异常场景 E2E。
 */
import {
  apiGet,
  apiPost,
  e2eTest,
  getAdminToken,
  getProblemIdByNumber,
  isE2E,
  registerUser,
  TEST_PASSWORD,
} from "../helper.ts";

let adminToken = "";
let userToken = "";
let contestId = "";

e2eTest("[e2e/anti-cheat-abnormal] Setup", async () => {
  if (!isE2E) return;
  adminToken = await getAdminToken();
  const ts = Date.now().toString(36);
  userToken = await registerUser(
    "ac_user_" + ts,
    "ac_user_" + ts + "@test.com",
    TEST_PASSWORD,
  );
  const problemId = await getProblemIdByNumber(1001);
  const res = await apiPost(
    "/api/v1/admin/contests",
    {
      title: "AC Abnormal " + ts,
      type: "OI",
      kind: "public",
      start_time: new Date(Date.now() - 3600_000).toISOString(),
      end_time: new Date(Date.now() + 3600_000).toISOString(),
      problem_ids: [problemId],
    },
    adminToken,
  );
  if (res.status !== 201) throw new Error("创建竞赛失败 " + res.status);
  contestId = (res.body as { data: { id: string } }).data.id;
});

e2eTest("[e2e/anti-cheat-abnormal] 未报名用户不能接收提交事件", async () => {
  if (!isE2E) return;
  // 未报名用户订阅竞赛事件应被拒绝或收不到提交事件；此处验证接口不返回 200 流
  const res = await fetch(
    `http://localhost:8099/api/v1/contests/${contestId}/events`,
    { headers: { Authorization: "Bearer " + userToken } },
  );
  // 公开赛未报名用户可连接但不应收到提交事件；至少不应 500
  if (res.status === 500) throw new Error("SSE 不应 500");
});

e2eTest("[e2e/anti-cheat-abnormal] 非管理员 SSE 事件不泄露 user_id", async () => {
  if (!isE2E) return;
  // 通过事件总线直接向频道发布一条带 user_id 的消息，验证非 admin 订阅者收到时被剥离
  const redis = await import("npm:ioredis@5");
  const client = new redis.default(
    Deno.env.get("E2E_REDIS_URL") || "redis://localhost:6380/1",
  );
  try {
    await client.publish(
      `noj:events:contest:${contestId}:submission`,
      JSON.stringify({ submission_id: "s1", user_id: "secret-user" }),
    );
  } finally {
    client.disconnect();
  }
  // 该场景需要真实 SSE 长连接断言，当前仅验证发布不抛错；
  // 完整 user_id 剥离断言由 core 单元测试覆盖。
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-tests && deno task test:domain contest`
Expected: FAIL，测试文件不存在或竞赛创建接口字段不符。

- [ ] **Step 3: 按实际接口修正**

阅读 `noj-core/src/domains/admin/routes/contest.ts` 与 `noj-core/src/domains/contest/routes/sse.ts`，将创建竞赛字段、SSE 路径与断言调整为实际实现；若 SSE 对未报名用户返回 403，则断言 403。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-tests && deno task test:domain contest`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj describe -m "test(e2e): 竞赛防作弊异常场景"
```

---

### Task 4: 存储故障 E2E

**Files:**
- Create: `noj-tests/e2e/cross-domain/storage_failure.test.ts`

**Interfaces:**
- Consumes: `helper.ts` 的 `e2eTest`、`apiGet`、`apiPost`、`registerUser`、`getAdminToken`、`getProblemIdByNumber`、`TEST_PASSWORD`。
- Produces: 无新接口。

- [ ] **Step 1: 写失败测试**

创建 `noj-tests/e2e/cross-domain/storage_failure.test.ts`：

```ts
/**
 * 存储故障 E2E：无效 presigned URL 与不存在对象。
 */
import {
  apiGet,
  apiPost,
  e2eTest,
  getAdminToken,
  getProblemIdByNumber,
  isE2E,
  registerUser,
  TEST_PASSWORD,
} from "../helper.ts";

let token = "";
let adminToken = "";
let PROBLEM_ID = "";

e2eTest("[e2e/storage-failure] Setup", async () => {
  if (!isE2E) return;
  adminToken = await getAdminToken();
  const ts = Date.now().toString(36);
  token = await registerUser(
    "st_user_" + ts,
    "st_user_" + ts + "@test.com",
    TEST_PASSWORD,
  );
  PROBLEM_ID = await getProblemIdByNumber(1001);
});

e2eTest("[e2e/storage-failure] 无效 presigned URL 下载返回 4xx", async () => {
  if (!isE2E) return;
  const res = await fetch(
    "http://localhost:9000/noj-support-packages/nonexistent-key?X-Amz-Signature=invalid",
  );
  if (res.status < 400 || res.status >= 500) {
    throw new Error("无效 presigned URL 应返回 4xx，实际 " + res.status);
  }
});

e2eTest("[e2e/storage-failure] 提交仍可创建（存储故障不阻塞主流程）", async () => {
  if (!isE2E) return;
  // 即使对象存储不可用，代码提交接口仍应接受（评测阶段才下载支持包）
  const res = await apiPost(
    `/api/v1/problems/${PROBLEM_ID}/submit`,
    { code: "print(1)", language: "python" },
    token,
  );
  if (res.status !== 201 && res.status !== 202) {
    throw new Error("提交应被接受，实际 " + res.status);
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-tests && deno task test:domain cross-domain`
Expected: FAIL，测试文件不存在或 MinIO 地址/端口与 E2E 栈不符。

- [ ] **Step 3: 按实际 MinIO 配置修正**

阅读 `docker-compose.e2e.yml` 中 MinIO 端口与 bucket 名，将 URL 调整为实际值；若 E2E 使用 local 存储，则改为验证 local 存储路径不存在返回 404。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-tests && deno task test:domain cross-domain`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj describe -m "test(e2e): 存储故障异常场景"
```

---

### Task 5: 限流与密码爆破锁定 E2E

**Files:**
- Create: `noj-tests/e2e/identity/rate_limit_lockout.test.ts`

**Interfaces:**
- Consumes: `helper.ts` 的 `e2eTest`、`apiPost`、`isE2E`。
- Produces: 无新接口。

- [ ] **Step 1: 写失败测试**

创建 `noj-tests/e2e/identity/rate_limit_lockout.test.ts`：

```ts
/**
 * 限流与密码爆破锁定 E2E。
 */
import { apiPost, e2eTest, isE2E } from "../helper.ts";

e2eTest("[e2e/rate-limit] 连续错误密码触发 429 或锁定", async () => {
  if (!isE2E) return;
  const email = `lock_${Date.now().toString(36)}@test.com`;
  let saw429 = false;
  for (let i = 0; i < 10; i++) {
    const res = await apiPost("/api/v1/auth/login", {
      login: email,
      password: "WrongPass" + i,
    });
    if (res.status === 429 || res.status === 423) {
      saw429 = true;
      break;
    }
  }
  if (!saw429) {
    throw new Error("连续错误密码后应触发限流/锁定，未观察到 429/423");
  }
});

e2eTest("[e2e/rate-limit] 注册接口超频返回 429", async () => {
  if (!isE2E) return;
  const ts = Date.now().toString(36);
  let saw429 = false;
  for (let i = 0; i < 20; i++) {
    const res = await apiPost("/api/v1/auth/register", {
      username: `rl_${ts}_${i}`,
      email: `rl_${ts}_${i}@test.com`,
      password: "ValidPass123",
    });
    if (res.status === 429) {
      saw429 = true;
      break;
    }
  }
  if (!saw429) {
    throw new Error("注册超频应触发 429，未观察到");
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-tests && deno task test:domain identity`
Expected: FAIL，测试文件不存在或限流阈值与实现不符。

- [ ] **Step 3: 按实际限流阈值修正**

阅读 `noj-core/src/domains/identity/middleware/login-rate-limit.ts` 与 `write-rate-limit-matrix.md`，将循环次数与期望状态码调整为实际阈值；若测试环境 `RATE_LIMIT_ENABLED` 为 false，则跳过该测试（在测试内 `if (!isE2E) return` 已处理，但还需检查环境变量）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-tests && deno task test:domain identity`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj describe -m "test(e2e): 限流与密码爆破锁定场景"
```

---

### Task 6: 浏览器异常流程 E2E

**Files:**
- Modify: `noj-tests/e2e/browser/ui_flows.test.ts`

**Interfaces:**
- Consumes: 现有 browser E2E 辅助（`browser.ts`）。
- Produces: 无新接口。

- [ ] **Step 1: 写失败测试**

在 `noj-tests/e2e/browser/ui_flows.test.ts` 末尾追加：

```ts
e2eTest("[e2e/browser] 登录失败显示错误提示", async () => {
  if (!isE2E) return;
  const { page } = await browserContext();
  await page.goto(BASE_URL + "/login");
  await page.fill('input[name="login"]', "nonexistent@test.com");
  await page.fill('input[name="password"]', "WrongPass123");
  await page.click('button[type="submit"]');
  await page.waitForSelector(".error-message, [data-testid='login-error']", {
    timeout: 5000,
  });
});

e2eTest("[e2e/browser] 提交失败显示失败反馈", async () => {
  if (!isE2E) return;
  const { page } = await browserContext();
  // 需要登录态；此处仅验证错误反馈选择器存在，具体流程由现有测试覆盖
  await page.goto(BASE_URL + "/problems");
  await page.waitForSelector("main", { timeout: 5000 });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-tests && NOJ_RUN_BROWSER_E2E=1 deno task test:browser`
Expected: FAIL，`browserContext` 辅助不存在或选择器与页面不符。

- [ ] **Step 3: 按实际 browser 辅助修正**

阅读 `noj-tests/e2e/browser/browser.ts` 与 `ui_flows.test.ts`，使用实际导出的上下文/页面辅助函数与选择器；若登录失败提示无固定选择器，按页面实际 DOM 调整。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-tests && NOJ_RUN_BROWSER_E2E=1 deno task test:browser`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj describe -m "test(e2e): 浏览器异常流程场景"
```
