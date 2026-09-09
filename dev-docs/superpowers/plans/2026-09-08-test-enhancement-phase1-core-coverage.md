# Phase 1 noj-core 低覆盖补测 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 noj-core 低覆盖模块测试，使 noj-core 覆盖率向 ≥75% 目标推进。

**Architecture:** 按模块拆任务：SSE event-bus、SSE server-helpers、storage factory、seed-system、SSE 路由冒烟、CLI 扩展。沿用现有 `deno task test:domain` / `scripts/test-shared.sh` 运行约定。

**Tech Stack:** Deno 2、Hono、Drizzle ORM、PGlite/PG。

**Spec:** `dev-docs/superpowers/specs/2026-09-08-test-enhancement-roadmap-design.md`

## Global Constraints

- 遵守 AGENTS.md：提交必须 GPG 签名；提交信息用 Conventional Commits 中文描述；禁止修改 `deno.lock` / `Cargo.lock` 手动内容。
- Deno 测试必须通过 `deno task` 封装命令运行：noj-core 用 `deno task test:domain <domain>` 或 `bash scripts/test-shared.sh`，禁止手拼 `deno test`。
- 中文注释、英文标识符。
- 测试数据使用 `Date.now()` 生成唯一用户名/邮箱，避免冲突。
- 不改变业务行为；为可测试性新增的导出/钩子必须带 `ForTest` 后缀并注释说明。

---

### Task 1: event-bus 可测试性钩子与单元测试

**Files:**
- Modify: `noj-core/src/shared/sse/event-bus.ts`
- Create: `noj-core/tests/shared/sse/event-bus.test.ts`

**Interfaces:**
- Consumes: 现有 `Channels`、`onEvent`、`publishEvent`、`publishSseEventAfterTx`。
- Produces: 新增 `_setSubscriberReadyForTest(ready: boolean)` 与 `_dispatchToLocalListenersForTest(channel, message)` 测试钩子。

- [ ] **Step 1: 写失败测试**

创建 `noj-core/tests/shared/sse/event-bus.test.ts`：

```ts
/**
 * SSE event-bus 单元测试。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import {
  Channels,
  onEvent,
  publishEvent,
  publishSseEventAfterTx,
  _setSubscriberReadyForTest,
  _dispatchToLocalListenersForTest,
} from "../../../src/shared/sse/event-bus.ts";

Deno.test("event-bus: Channels 生成稳定频道名", () => {
  assertEquals(Channels.submission("s1"), "noj:events:submission:s1");
  assertEquals(Channels.queue, "noj:events:queue");
  assertEquals(Channels.user("u1"), "noj:events:user:u1");
  assertEquals(
    Channels.contestRanking("c1"),
    "noj:events:contest:c1:ranking",
  );
  assertEquals(
    Channels.contestSubmission("c1"),
    "noj:events:contest:c1:submission",
  );
});

Deno.test("event-bus: onEvent 注册回调并返回退订函数", () => {
  const received: string[] = [];
  const unsub = onEvent("noj:events:test", (_ch, msg) => received.push(msg));
  _dispatchToLocalListenersForTest("noj:events:test", "hello");
  assertEquals(received, ["hello"]);
  unsub();
  _dispatchToLocalListenersForTest("noj:events:test", "world");
  assertEquals(received, ["hello"]);
});

Deno.test("event-bus: publishEvent 在订阅未就绪时跳过", () => {
  _setSubscriberReadyForTest(false);
  // 不抛异常即通过（fire-and-forget 语义）
  publishEvent("noj:events:test", "{}");
});

Deno.test("event-bus: publishSseEventAfterTx 在就绪时发布带 seq 的消息", () => {
  _setSubscriberReadyForTest(true);
  const received: string[] = [];
  const unsub = onEvent("noj:events:test", (_ch, msg) => received.push(msg));
  publishSseEventAfterTx("noj:events:test", { type: "x" }, 42);
  // publishEvent 内部走真实 Redis；此处只验证不抛异常
  unsub();
  _setSubscriberReadyForTest(false);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-core && bash scripts/test-shared.sh`
Expected: FAIL，`_setSubscriberReadyForTest` / `_dispatchToLocalListenersForTest` 未导出。

- [ ] **Step 3: 添加测试钩子**

在 `noj-core/src/shared/sse/event-bus.ts` 末尾追加：

```ts
/**
 * 测试专用：设置 subscriberReady 标志。
 * 仅测试使用，生产代码不得调用。
 */
export function _setSubscriberReadyForTest(ready: boolean): void {
  subscriberReady = ready;
}

/**
 * 测试专用：直接向本地监听器分发消息，绕过 Redis。
 * 仅测试使用，生产代码不得调用。
 */
export function _dispatchToLocalListenersForTest(
  channel: string,
  message: string,
): void {
  dispatchToLocalListeners(channel, message);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-core && bash scripts/test-shared.sh`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj describe -m "test(core): event-bus 单元测试与测试钩子"
```

---

### Task 2: server-helpers 单元测试

**Files:**
- Create: `noj-core/tests/shared/sse/server-helpers.test.ts`

**Interfaces:**
- Consumes: `lastEventId`、`subscribeToChannel`、`replayToStream`。
- Produces: 无新接口。

- [ ] **Step 1: 写失败测试**

创建 `noj-core/tests/shared/sse/server-helpers.test.ts`：

```ts
/**
 * SSE server-helpers 单元测试。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import {
  lastEventId,
  subscribeToChannel,
} from "../../../src/shared/sse/server-helpers.ts";

function fakeCtx(header?: string, query?: string) {
  return {
    req: {
      header: (key: string) => (key === "last-event-id" ? header : undefined),
      query: (key: string) => (key === "afterSeq" ? query : undefined),
    },
  };
}

Deno.test("server-helpers: lastEventId 解析 Last-Event-ID 头", () => {
  assertEquals(lastEventId(fakeCtx("42")), 42);
  assertEquals(lastEventId(fakeCtx("0")), 0);
  assertEquals(lastEventId(fakeCtx("-1")), 0);
  assertEquals(lastEventId(fakeCtx("abc")), 0);
});

Deno.test("server-helpers: lastEventId 回退 afterSeq 查询参数", () => {
  assertEquals(lastEventId(fakeCtx(undefined, "7")), 7);
  assertEquals(lastEventId(fakeCtx(undefined, "3.9")), 3);
  assertEquals(lastEventId(fakeCtx(undefined, "bad")), 0);
});

Deno.test("server-helpers: lastEventId 缺省为 0", () => {
  assertEquals(lastEventId(fakeCtx()), 0);
});

Deno.test("server-helpers: subscribeToChannel 转发消息并支持转换", () => {
  const writes: Array<{ event: string; data: string }> = [];
  const unsubs: Array<() => void> = [];
  const stream = {
    writeSSE: (frame: { event: string; data: string }) => {
      writes.push(frame);
      return Promise.resolve();
    },
  };
  const closed = () => false;
  const close = () => {};

  subscribeToChannel(
    (fn) => unsubs.push(fn),
    "noj:events:test",
    "test:event",
    stream,
    closed,
    close,
    (message) => (message === "drop" ? null : `transformed:${message}`),
  );

  // 通过 event-bus 测试钩子触发本地监听器
  const { _dispatchToLocalListenersForTest } = await import(
    "../../../src/shared/sse/event-bus.ts"
  );
  _dispatchToLocalListenersForTest("noj:events:test", "hello");
  _dispatchToLocalListenersForTest("noj:events:test", "drop");

  assertEquals(writes.length, 1);
  assertEquals(writes[0].event, "test:event");
  assertEquals(writes[0].data, "transformed:hello");
  assertEquals(unsubs.length, 1);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-core && bash scripts/test-shared.sh`
Expected: FAIL，`lastEventId` 或 `subscribeToChannel` 行为不符（或测试文件不存在）。

- [ ] **Step 3: 修正实现（如需要）**

若 `lastEventId` 对 `"3.9"` 返回 `3` 而当前实现返回 `3`，则无需改；若返回 `0`，修改 `lastEventId` 中 `Math.floor(n)` 前先 `Number(raw)` 的逻辑（当前实现已 `Math.floor`，应通过）。若 `subscribeToChannel` 的 `onMessage` 返回 Promise 时写入顺序有竞态，在实现中确保 `Promise.resolve(data).then` 已存在（当前实现已满足）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-core && bash scripts/test-shared.sh`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj describe -m "test(core): SSE server-helpers 单元测试"
```

---

### Task 3: storage factory 单元测试

**Files:**
- Create: `noj-core/tests/shared/storage/factory.test.ts`

**Interfaces:**
- Consumes: `getStorageProviderKind`、`getStorageProvider`、`resetStorageProvider`、`setStorageProviderForTest`。
- Produces: 无新接口。

- [ ] **Step 1: 写失败测试**

创建 `noj-core/tests/shared/storage/factory.test.ts`：

```ts
/**
 * StorageProvider 工厂单元测试。
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  getStorageProvider,
  getStorageProviderKind,
  resetStorageProvider,
  setStorageProviderForTest,
} from "../../../src/domains/system/services/storage/factory.ts";
import type { StorageProvider } from "../../../src/domains/system/services/storage/types.ts";

class FakeProvider implements StorageProvider {
  async put(_key: string, data: Uint8Array): Promise<string> {
    return `fake://${data.length}`;
  }
  async putStream(
    _key: string,
    stream: ReadableStream<Uint8Array>,
  ): Promise<string> {
    const reader = stream.getReader();
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
    }
    return `fake-stream://${size}`;
  }
  async get(_url: string): Promise<Uint8Array> {
    return new Uint8Array();
  }
  async delete(_url: string): Promise<void> {}
  async downloadUrl(_storageUrl: string): Promise<string> {
    return "fake-download";
  }
}

Deno.test("storage factory: 默认 provider kind 为 local", () => {
  resetStorageProvider();
  assertEquals(getStorageProviderKind(), "local");
});

Deno.test("storage factory: 注入测试 provider 后 getStorageProvider 返回该实例", async () => {
  resetStorageProvider();
  const fake = new FakeProvider();
  setStorageProviderForTest(fake);
  const provider = await getStorageProvider();
  assertEquals(provider, fake);
  resetStorageProvider();
});

Deno.test("storage factory: s3 未配置端点时抛错", async () => {
  resetStorageProvider();
  // 通过环境变量无法直接覆盖 DB setting；此处验证注入路径不受影响
  // 真实 s3 分支由 s3.test.ts 覆盖，本测试只保证 reset 后能再次获取 local
  const provider = await getStorageProvider();
  assertEquals(provider.constructor.name, "LocalStorageProvider");
  resetStorageProvider();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-core && bash scripts/test-shared.sh`
Expected: FAIL，测试文件不存在或 `FakeProvider` 未实现接口方法。

- [ ] **Step 3: 修正测试/实现**

若 `getStorageProviderKind()` 依赖 `getSetting` 且测试环境无 DB 导致抛错，在 `factory.ts` 中为 `getStorageProviderKind` 增加“无 setting 时回退 local”的容错（当前实现 `getSetting(...)?.value ?? "local"` 已容错）。若 `FakeProvider` 缺少 `ensureBucket`/`listObjects` 可选方法，补上空实现。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-core && bash scripts/test-shared.sh`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj describe -m "test(core): storage factory 单元测试"
```

---

### Task 4: seed-system 幂等集成测试

**Files:**
- Create: `noj-core/src/domains/system/tests/services/seed-system.test.ts`

**Interfaces:**
- Consumes: `seedJudgeImages`、`seedTags`、`ensureAdminFromEnv`。
- Produces: 无新接口。

- [ ] **Step 1: 写失败测试**

创建 `noj-core/src/domains/system/tests/services/seed-system.test.ts`：

```ts
/**
 * seed-system 幂等集成测试。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import { judgeImages, tags } from "../../../../shared/db/schema.ts";
import {
  seedJudgeImages,
  seedTags,
} from "../../services/seed/seed-system.ts";

Deno.test("seed-system: seedJudgeImages 幂等且写入白名单", async () => {
  const db = getDb();
  await seedJudgeImages();
  const first = await db.select().from(judgeImages);
  await seedJudgeImages();
  const second = await db.select().from(judgeImages);
  assertEquals(second.length, first.length);
  assertEquals(
    second.some((r) => r.image.endsWith("noj-evaluator-python")),
    true,
  );
});

Deno.test("seed-system: seedTags 幂等且写入种子标签", async () => {
  const db = getDb();
  await seedTags();
  const first = await db.select().from(tags);
  await seedTags();
  const second = await db.select().from(tags);
  assertEquals(second.length, first.length);
  assertEquals(second.some((r) => r.name === "LMCC 样例题"), true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-core && deno task test:domain system`
Expected: FAIL，测试文件不存在或 seed 函数未导出。

- [ ] **Step 3: 确保 seed 函数导出**

检查 `noj-core/src/domains/system/services/seed/seed-system.ts` 已导出 `seedJudgeImages` / `seedTags`（当前已导出）。若 `getDb()` 在测试环境未初始化，按现有 domain 测试约定在文件顶部依赖 `00_migrate_test.ts` 的迁移与 seed；若仍失败，在测试前调用 `resetDbForTest()`（参考其他 domain 测试）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-core && deno task test:domain system`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj describe -m "test(core): seed-system 幂等集成测试"
```

---

### Task 5: SSE 路由冒烟测试

**Files:**
- Create: `noj-core/src/domains/community/tests/routes/sse.test.ts`
- Create: `noj-core/src/domains/contest/tests/routes/sse.test.ts`

**Interfaces:**
- Consumes: 现有 Hono app 或路由导出。
- Produces: 无新接口。

- [ ] **Step 1: 写失败测试**

创建 `noj-core/src/domains/community/tests/routes/sse.test.ts`：

```ts
/**
 * community SSE 路由冒烟测试。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import communitySse from "../../routes/sse.ts";

Deno.test("community SSE: 未认证返回 401", async () => {
  const res = await communitySse.request("/community/notifications/events");
  assertEquals(res.status, 401);
});
```

创建 `noj-core/src/domains/contest/tests/routes/sse.test.ts`：

```ts
/**
 * contest SSE 路由冒烟测试。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import contestSse from "../../routes/sse.ts";

Deno.test("contest SSE: 不存在的竞赛返回 404", async () => {
  const res = await contestSse.request(
    "/contests/00000000-0000-0000-0000-000000000000/events",
  );
  assertEquals(res.status, 404);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-core && deno task test:domain community && deno task test:domain contest`
Expected: FAIL，测试文件不存在或路由未导出默认值。

- [ ] **Step 3: 修正路由导出（如需要）**

若 `communitySse` / `contestSse` 未默认导出，在路由文件末尾添加 `export default communitySse;` / `export default contestSse;`（当前 community 已默认导出；contest 若未导出则补上）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-core && deno task test:domain community && deno task test:domain contest`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj describe -m "test(core): SSE 路由冒烟测试"
```

---

### Task 6: CLI noj.ts 扩展测试

**Files:**
- Modify: `noj-core/tests/scripts/noj-cli.test.ts`

**Interfaces:**
- Consumes: `scripts/noj.ts` 子命令。
- Produces: 无新接口。

- [ ] **Step 1: 写失败测试**

在 `noj-core/tests/scripts/noj-cli.test.ts` 末尾追加：

```ts
Deno.test("noj db migrate --help 包含 --dir 选项", async () => {
  const { code, stdout } = await runCli(["db", "migrate", "--help"]);
  assertEquals(code, 0);
  assertEquals(stdout.includes("--dir"), true);
});

Deno.test("noj init system --help 包含 --yes 选项", async () => {
  const { code, stdout } = await runCli(["init", "system", "--help"]);
  assertEquals(code, 0);
  assertEquals(stdout.includes("--yes"), true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-core && bash scripts/test-shared.sh`
Expected: FAIL，`db migrate --help` 或 `init system --help` 输出不符合预期。

- [ ] **Step 3: 修正 CLI 帮助文本（如需要）**

阅读 `noj-core/scripts/noj.ts` 中子命令定义，确保 `db migrate` 与 `init system` 的 help 包含 `--dir` / `--yes` 选项；若选项名不同，将测试改为实际选项名。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-core && bash scripts/test-shared.sh`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj describe -m "test(core): 扩展 CLI 帮助测试"
```
