# 评测任务三级优先级队列实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将评测任务从单队列升级为 high/medium/low 三级队列，由 judge 侧固定比例轮转消费，保证竞赛提交优先且低优先级不饿死。

**Architecture:** noj-core 按“是否属于进行中竞赛 + 调用来源”推导优先级并写入 JudgeTask，按优先级入不同 Redis 主队列；noj-judge 每个 worker 用 4:2:1 固定序列对三个队列做 BRPOPLPUSH 轮转；core sweeper 按优先级分别做 processing 超时重投；结果队列保持单队列。

**Tech Stack:** Deno + Hono + ioredis（noj-core）、Rust + redis-rs + Tokio（noj-judge）、Redis List + Lua。

**Spec:** `dev-docs/superpowers/specs/2026-09-08-judge-priority-queue-design.md`

## Global Constraints

- 不兼容旧单队列：noj-core 与 noj-judge 必须同版本升级，回退=整体回滚。
- 优先级取值固定为 `"high" | "medium" | "low"`。
- 队列名固定：`noj:judge:queue:high` / `:medium` / `:low`，各自带 `:processing` / `:dead`。
- 每级独立容量：high 5000 / medium 10000 / low 20000。
- 客户端不能声明优先级；core 服务端推导。
- 结果队列 `noj:judge:results` 不变。
- 本次不做按级可观测性/指标、管理员暂停、动态调度、旧队列兼容迁移。
- 所有 Deno 测试通过 `deno task` 运行；Rust 测试通过 `cargo nextest run --all-targets` 或 `cargo test`。

---

### Task 1: core 类型与 producer 多队列

**Files:**
- Modify: `noj-core/src/domains/submission/types/index.ts`
- Modify: `noj-core/src/domains/submission/mq/producer.ts`
- Test: `noj-core/src/domains/submission/tests/mq/producer.test.ts`

**Interfaces:**
- Consumes: 现有 `JudgeTask`、`getRedis()`、`logJudgeTaskEnqueued`。
- Produces:
  - `export type JudgeTaskPriority = "high" | "medium" | "low"`
  - `export const JUDGE_QUEUES: Record<JudgeTaskPriority, string>`
  - `export const JUDGE_QUEUE_CAPACITY: Record<JudgeTaskPriority, number>`
  - `pushJudgeTask(task: JudgeTask): Promise<number>`（内部读取 `task.priority` 选择队列）

- [ ] **Step 1: 在 `types/index.ts` 增加优先级类型与字段**

在 `JudgeTask` 接口中增加：

```ts
export type JudgeTaskPriority = "high" | "medium" | "low";

export interface JudgeTask {
  // ...现有字段
  priority: JudgeTaskPriority;
}
```

- [ ] **Step 2: 在 `mq/producer.ts` 改为多队列**

替换 `JUDGE_QUEUE` / `MAX_JUDGE_QUEUE_LENGTH` 常量与 `pushJudgeTask` 实现：

```ts
import type { JudgeTask, JudgeTaskPriority } from "../types/index.ts";

export const JUDGE_QUEUES: Record<JudgeTaskPriority, string> = {
  high: "noj:judge:queue:high",
  medium: "noj:judge:queue:medium",
  low: "noj:judge:queue:low",
};

export const JUDGE_QUEUE_CAPACITY: Record<JudgeTaskPriority, number> = {
  high: 5000,
  medium: 10000,
  low: 20000,
};

export async function pushJudgeTask(task: JudgeTask): Promise<number> {
  const redis = getRedis();
  if (redis.status !== "ready") {
    throw new Error(
      `Redis 连接不可用（状态: ${redis.status}），无法推送评测任务`,
    );
  }

  const message = JSON.stringify(task);
  const messageBytes = new TextEncoder().encode(message).length;
  if (messageBytes > MAX_MESSAGE_BYTES) {
    throw new Error(
      `评测任务消息超过大小限制（${messageBytes} > ${MAX_MESSAGE_BYTES} 字节），请检查支持包大小`,
    );
  }

  const queue = JUDGE_QUEUES[task.priority];
  const capacity = JUDGE_QUEUE_CAPACITY[task.priority];
  const length = await redis.eval(
    QUEUE_CAPACITY_SCRIPT,
    1,
    queue,
    capacity,
    message,
  );
  if (length < 0) {
    throw new Error(
      `评测队列已满（${capacity}/${capacity}），请稍后重试`,
    );
  }

  logJudgeTaskEnqueued(task.submission_id, length, messageBytes);
  return length;
}
```

- [ ] **Step 3: 更新 producer 测试**

在 `tests/mq/producer.test.ts` 的 `makeTask` 增加 `priority: "medium"`，并把所有 `"noj:judge:queue"` 断言改为 `"noj:judge:queue:medium"`。新增两个测试：

```ts
Deno.test({
  name: "mq/producer: 按优先级入对应队列",
  ignore: !hasDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fake = startFakeRedis();
    try {
      resetRedisForTest();
      Deno.env.set("REDIS_URL", fake.url);
      const redis = getRedis();
      await redis.connect();
      await redis.ping();

      await pushJudgeTask(makeTask({ submission_id: "high-1", priority: "high" }));
      await pushJudgeTask(makeTask({ submission_id: "low-1", priority: "low" }));

      assertEquals(fake.getMessages("noj:judge:queue:high").length, 1);
      assertEquals(fake.getMessages("noj:judge:queue:low").length, 1);
      assertEquals(fake.getMessages("noj:judge:queue:medium").length, 0);
    } finally {
      await fake.stop();
      resetRedisForTest();
      Deno.env.delete("REDIS_URL");
    }
  },
});

Deno.test({
  name: "mq/producer: 每级独立容量上限",
  ignore: !hasDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fake = startFakeRedis();
    try {
      resetRedisForTest();
      Deno.env.set("REDIS_URL", fake.url);
      const redis = getRedis();
      await redis.connect();
      await redis.ping();

      fake.seedQueue("noj:judge:queue:high", JUDGE_QUEUE_CAPACITY.high);
      await assertRejects(
        async () => pushJudgeTask(makeTask({ submission_id: "high-full", priority: "high" })),
        Error,
        "评测队列已满",
      );
      // medium 不受 high 满影响
      const len = await pushJudgeTask(makeTask({ submission_id: "medium-ok", priority: "medium" }));
      assertEquals(len, 1);
    } finally {
      await fake.stop();
      resetRedisForTest();
      Deno.env.delete("REDIS_URL");
    }
  },
});
```

同时更新 import：`import { JUDGE_QUEUE_CAPACITY, pushJudgeTask } from "../../mq/producer.ts";`，删除 `MAX_JUDGE_QUEUE_LENGTH` 引用。

- [ ] **Step 4: 运行测试**

Run: `cd noj-core && deno task test -- --filter "mq/producer"`（或 `deno task test:parallel` 中对应分片）
Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
jj describe -m "feat(core): JudgeTask 增加优先级并支持三级评测队列"
```

---

### Task 2: core 优先级推导 helper 与入队调用点

**Files:**
- Create: `noj-core/src/domains/submission/services/submissions/judge-priority.ts`
- Modify: `noj-core/src/domains/submission/services/submissions/submissions-crud.ts`
- Modify: `noj-core/src/domains/submission/services/submissions/artifact-submissions.ts`
- Modify: `noj-core/src/domains/submission/services/self-tests.ts`
- Modify: `noj-core/src/domains/submission/services/submissions/submissions-rejudge.ts`
- Test: `noj-core/src/domains/submission/tests/services/judge-priority.test.ts`（新建）

**Interfaces:**
- Consumes: `contests` schema、`computeContestStatus`（来自 `../../contest/index.ts`）、`JudgeTaskPriority`。
- Produces:
  - `export type JudgeTaskSource = "submission" | "self_test" | "rejudge"`
  - `export async function resolveJudgeTaskPriority(contestId: string | null, source: JudgeTaskSource): Promise<JudgeTaskPriority>`

- [ ] **Step 1: 新建 `judge-priority.ts`**

```ts
import { eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import { contests } from "../../../../shared/db/schema.ts";
import { computeContestStatus } from "../../../contest/index.ts";
import type { JudgeTaskPriority } from "../../types/index.ts";

export type JudgeTaskSource = "submission" | "self_test" | "rejudge";

export async function resolveJudgeTaskPriority(
  contestId: string | null,
  source: JudgeTaskSource,
): Promise<JudgeTaskPriority> {
  if (source === "rejudge") return "low";
  if (source === "self_test") return "medium";
  if (!contestId) return "medium";

  const [contest] = await getDb()
    .select({ start_time: contests.start_time, end_time: contests.end_time })
    .from(contests)
    .where(eq(contests.id, contestId))
    .limit(1);
  if (!contest) return "medium";

  return computeContestStatus(contest.start_time, contest.end_time) === "running"
    ? "high"
    : "medium";
}
```

- [ ] **Step 2: 新建 `judge-priority.test.ts`**

测试三种来源与进行中/非进行中竞赛：

```ts
import { assertEquals } from "jsr:@std/assert@^1";
import { resolveJudgeTaskPriority } from "./judge-priority.ts";
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

    assertEquals(await resolveJudgeTaskPriority(runningId, "submission"), "high");
    assertEquals(await resolveJudgeTaskPriority(endedId, "submission"), "medium");
  },
});
```

- [ ] **Step 3: 更新 `submissions-crud.ts`**

在 `createSubmission` 中，构造 `task` 前计算优先级并加入：

```ts
const priority = await resolveJudgeTaskPriority(resolvedContestId, "submission");
// ...
const task: JudgeTask = {
  // ...现有字段
  priority,
};
```

在文件顶部 import：

```ts
import { resolveJudgeTaskPriority } from "./judge-priority.ts";
```

- [ ] **Step 4: 更新 `artifact-submissions.ts`**

同样在 `createArtifactSubmission` 中：

```ts
const priority = await resolveJudgeTaskPriority(resolvedContestId, "submission");
// ...
const task: JudgeTask = {
  // ...现有字段
  priority,
};
```

import 同上。

- [ ] **Step 5: 更新 `self-tests.ts`**

在 `task` 中直接写 `priority: "medium"`（自测无竞赛）：

```ts
const task: JudgeTask = {
  // ...现有字段
  priority: "medium",
};
```

- [ ] **Step 6: 更新 `submissions-rejudge.ts`**

单提交重测与批量重测构造的 `task` 都加 `priority: "low"`。

- [ ] **Step 7: 运行测试**

Run: `cd noj-core && deno task test -- --filter "judge-priority|submissions|self-tests|rejudge"`
Expected: 全部通过。

- [ ] **Step 8: 提交**

```bash
jj describe -m "feat(core): 按竞赛状态与来源推导评测任务优先级"
```

---

### Task 3: core sweeper 多队列与队列服务适配

**Files:**
- Modify: `noj-core/src/domains/submission/mq/sweeper.ts`
- Modify: `noj-core/src/domains/submission/services/queue.ts`
- Test: `noj-core/src/domains/submission/tests/services/queue.test.ts`
- Test: `noj-core/src/domains/submission/tests/services/queue-health.test.ts`
- Test: `noj-core/src/domains/submission/tests/mq/self-test-consumer.test.ts`

**Interfaces:**
- Consumes: `JUDGE_QUEUES`、`JUDGE_QUEUE_CAPACITY`、`resolveJudgeTaskPriority`。
- Produces: 无新导出；`getPendingSubmissionIds` / `getPendingQueueLength` / `removePendingSubmission` / `getQueueHealth` 改为跨三级队列工作。

- [ ] **Step 1: 更新 `sweeper.ts` 遍历三级队列**

- 删除 `import { JUDGE_QUEUE, MAX_JUDGE_QUEUE_LENGTH }`，改为：

```ts
import { JUDGE_QUEUES, JUDGE_QUEUE_CAPACITY } from "./producer.ts";
```

- `runQueueSweeperOnce` 中：

```ts
const judgeQueues = [
  JUDGE_QUEUES.high,
  JUDGE_QUEUES.medium,
  JUDGE_QUEUES.low,
] as const;

const results = await Promise.allSettled([
  ...judgeQueues.map((queue) =>
    sweepProcessingQueue(
      `${queue}:processing`,
      queue,
      taskProcessingTimeoutMs(),
    )
  ),
  sweepProcessingQueue(
    `${RESULT_QUEUE}:processing`,
    RESULT_QUEUE,
    RESULT_PROCESSING_TIMEOUT_MS,
  ),
  recoverPendingSubmissions(now),
  recoverPendingSelfTests(now),
  cleanupOrphanArtifacts(now),
  logQueueAlertsIfNeeded(),
]);
```

- `logQueueAlertsIfNeeded` 中把 `queues` 数组改为：

```ts
const RESULT_QUEUE_ALERT_THRESHOLD = 10_000;

const queues = [
  { key: "judge:high", main: JUDGE_QUEUES.high, capacity: JUDGE_QUEUE_CAPACITY.high },
  { key: "judge:medium", main: JUDGE_QUEUES.medium, capacity: JUDGE_QUEUE_CAPACITY.medium },
  { key: "judge:low", main: JUDGE_QUEUES.low, capacity: JUDGE_QUEUE_CAPACITY.low },
  { key: "result", main: RESULT_QUEUE, capacity: RESULT_QUEUE_ALERT_THRESHOLD },
] as const;
```

`MAIN_QUEUE_ALERT_THRESHOLD` 常量删除；告警阈值统一用 `capacity / 2`（result 队列仍单队列，阈值 10000/2=5000）。

- [ ] **Step 2: 更新 `sweeper.ts` pending 恢复优先级**

- `PendingRecoveryRow` 增加 `contest_id?: string | null`。
- `PendingRecoveryTableColumns` 增加 `contestId?: AnyPgColumn`。
- `selectPendingRecoveryRows` 中若 `cols.contestId` 存在则 select `contest_id: cols.contestId`。
- `recoverPendingSubmissions` 调用 `selectPendingRecoveryRows` 时传入 `contestId: submissions.contest_id`。
- `recoverPendingRows` 签名改为 `recoverPendingRows<T>(rows: T[], actions: PendingRecoveryActions<T>, source: "submission" | "self_test")`，构造 task 时：

```ts
let priority: JudgeTaskPriority;
if (source === "self_test") {
  priority = "medium";
} else if ((row.rejudge_seq ?? 0) > 0) {
  priority = "low";
} else {
  priority = await resolveJudgeTaskPriority(row.contest_id ?? null, "submission");
}
```

并在 `task` 中加入 `priority`。`recoverPendingSubmissions` 调用 `recoverPendingRows(rows, actions, "submission")`，`recoverPendingSelfTests` 调用 `recoverPendingRows(rows, actions, "self_test")`。

- [ ] **Step 3: 更新 `queue.ts` 跨三级队列**

- 顶部 import：

```ts
import { JUDGE_QUEUES } from "../mq/producer.ts";
```

- 删除本地 `const JUDGE_QUEUE = "noj:judge:queue";`，新增：

```ts
const JUDGE_QUEUE_LIST = [JUDGE_QUEUES.high, JUDGE_QUEUES.medium, JUDGE_QUEUES.low];
```

- `getPendingSubmissionIds`：

```ts
const raw: string[] = [];
for (const queue of JUDGE_QUEUE_LIST) {
  const end = limit <= 0 ? -1 : Math.max(0, limit - 1);
  raw.push(...await redis.lrange(queue, 0, end));
}
```

- `getPendingQueueLength`：

```ts
let total = 0;
for (const queue of JUDGE_QUEUE_LIST) {
  total += Number(await redis.llen(queue) ?? 0);
}
return total;
```

- `removePendingSubmission`：遍历 `JUDGE_QUEUE_LIST`，在第一个包含该 submission 的队列中 `lrem`。

- `getQueueHealth`：`readQueueHealth` 保持单队列读取，新增聚合函数：

```ts
async function readJudgeQueueHealth(): Promise<QueueHealthEntry> {
  const entries = await Promise.all(JUDGE_QUEUE_LIST.map((q) => readQueueHealth(q)));
  const sum = (pick: (e: QueueHealthEntry) => number): number => {
    if (entries.some((e) => pick(e) < 0)) return -1;
    return entries.reduce((total, e) => total + pick(e), 0);
  };
  return {
    queue_length: sum((e) => e.queue_length),
    processing_length: sum((e) => e.processing_length),
    dead_length: sum((e) => e.dead_length),
  };
}
```

`getQueueHealth` 中 `const judge = await readJudgeQueueHealth();`。

- [ ] **Step 4: 更新相关测试**

- `queue.test.ts`：`pushToQueue` 改为写入 `noj:judge:queue:medium`；`clearQueue` 清空三个队列；断言同步改。
- `queue-health.test.ts`：测试消息写入 `noj:judge:queue:medium`，断言 `after.judge.queue_length === beforeLen + 1`。
- `self-test-consumer.test.ts`：若断言具体队列，改为 `noj:judge:queue:medium`（pending 正式提交无竞赛）或 `noj:judge:queue:high`（若测试数据带进行中竞赛）。

- [ ] **Step 5: 运行测试**

Run: `cd noj-core && deno task test -- --filter "queue|sweeper|self-test-consumer"`
Expected: 全部通过。

- [ ] **Step 6: 提交**

```bash
jj describe -m "feat(core): sweeper 与队列服务适配三级评测队列"
```

---

### Task 4: judge Rust 类型、配置与轮转拉取

**Files:**
- Modify: `noj-judge/src/types.rs`
- Modify: `noj-judge/src/config.rs`
- Modify: `noj-judge/src/mq.rs`
- Modify: `noj-judge/src/main.rs`
- Test: `noj-judge/src/mq.rs`（内嵌 tests）
- Test: `noj-judge/src/config.rs`（内嵌 tests）

**Interfaces:**
- Consumes: 现有 `JudgeTask`、`Config`、`PulledTask`。
- Produces:
  - `PulledTask { task, raw, queue: String }`
  - `pub const PRIORITY_SEQUENCE: [usize; 7]`
  - `pub fn priority_slot(cursor: usize, offset: usize) -> usize`
  - `pub async fn pull_task_priority(conn, queues: &[String; 3], cursor: &mut usize, timeout_secs: f64) -> Result<Option<PulledTask>>`
  - `Config::judge_queues(&self) -> [String; 3]`
  - `Config::priority_poll_timeout_secs: f64`

- [ ] **Step 1: `types.rs` 增加 priority 字段**

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JudgeTask {
    // ...现有字段
    #[serde(default = "default_priority")]
    pub priority: String,
}

fn default_priority() -> String {
    "medium".to_string()
}
```

更新 `types.rs` 内测试 JSON，至少一个用例包含 `"priority":"high"` 并断言。

- [ ] **Step 2: `config.rs` 增加队列派生与轮询超时**

在 `Config` 增加字段：

```rust
pub priority_poll_timeout_secs: f64,
```

`from_env` 中：

```rust
priority_poll_timeout_secs: env_var_parse::<f64>("JUDGE_PRIORITY_POLL_TIMEOUT_MS")
    .map(|ms| ms / 1000.0)
    .unwrap_or(0.1),
```

增加方法：

```rust
pub fn judge_queues(&self) -> [String; 3] {
    [
        format!("{}:high", self.judge_queue),
        format!("{}:medium", self.judge_queue),
        format!("{}:low", self.judge_queue),
    ]
}
```

更新 `config.rs` 测试：默认 `judge_queues()` 返回 `["noj:judge:queue:high", "noj:judge:queue:medium", "noj:judge:queue:low"]`；自定义 `JUDGE_QUEUE=custom:queue` 时返回 `custom:queue:high` 等。

- [ ] **Step 3: `mq.rs` 增加轮转拉取**

在 `PulledTask` 增加 `pub queue: String`。

新增常量与纯函数：

```rust
pub const PRIORITY_SEQUENCE: [usize; 7] = [0, 0, 0, 0, 1, 1, 2];

pub fn priority_slot(cursor: usize, offset: usize) -> usize {
    PRIORITY_SEQUENCE[(cursor + offset) % PRIORITY_SEQUENCE.len()]
}
```

新增 `pull_task_priority`：

```rust
pub async fn pull_task_priority(
    conn: &mut redis::aio::MultiplexedConnection,
    queues: &[String; 3],
    cursor: &mut usize,
    timeout_secs: f64,
) -> Result<Option<PulledTask>> {
    for offset in 0..PRIORITY_SEQUENCE.len() {
        let idx = priority_slot(*cursor, offset);
        let queue = &queues[idx];
        let processing = processing_queue(queue);
        let raw: Option<String> = conn
            .brpoplpush(queue, &processing, timeout_secs)
            .await
            .context("BRPOPLPUSH 拉取任务失败")?;

        if let Some(raw) = raw {
            match parse_task_message(&raw) {
                Some(task) => {
                    *cursor = (*cursor + offset + 1) % PRIORITY_SEQUENCE.len();
                    return Ok(Some(PulledTask { task, raw, queue: queue.clone() }));
                }
                None => {
                    let dead_queue = format!("{}:dead", queue);
                    let _: redis::RedisResult<usize> = conn.lpush(&dead_queue, &raw).await;
                    let _: redis::RedisResult<usize> = conn.lrem(&processing, 1, &raw).await;
                }
            }
        }
    }
    Ok(None)
}
```

修改 `requeue_task` 与 `ack_task` 参数名 `judge_queue` 为 `queue`，内部使用传入的 `queue` 计算 processing。

- [ ] **Step 4: `main.rs` 使用轮转拉取**

- 在 main 中：

```rust
let judge_queues = config.judge_queues();
let mut priority_cursor = 0usize;
let priority_poll_timeout = config.priority_poll_timeout_secs;
```

- `tokio::select!` 中：

```rust
task_result = mq::pull_task_priority(
    &mut redis_conn,
    &judge_queues,
    &mut priority_cursor,
    priority_poll_timeout,
) => {
```

- requeue 调用改为 `mq::requeue_task(&redis_client, &pulled.queue, &pulled.raw)`。
- spawn 前保存 `let task_queue = pulled.queue.clone();`，ack 调用改为 `mq::ack_task(&redis_client, &task_queue, &raw)`。

- [ ] **Step 5: 增加 Rust 测试**

在 `mq.rs` tests 中：

```rust
#[test]
fn test_priority_sequence_ratio() {
    let high = PRIORITY_SEQUENCE.iter().filter(|&&i| i == 0).count();
    let medium = PRIORITY_SEQUENCE.iter().filter(|&&i| i == 1).count();
    let low = PRIORITY_SEQUENCE.iter().filter(|&&i| i == 2).count();
    assert_eq!((high, medium, low), (4, 2, 1));
}

#[test]
fn test_priority_slot_round_robin() {
    assert_eq!(priority_slot(0, 0), 0);
    assert_eq!(priority_slot(0, 4), 1);
    assert_eq!(priority_slot(0, 6), 2);
    assert_eq!(priority_slot(6, 1), 0);
}
```

在 `config.rs` tests 中增加 `judge_queues` 断言。

- [ ] **Step 6: 运行测试**

Run: `cd noj-judge && cargo nextest run --all-targets`
Expected: 全部通过。

- [ ] **Step 7: 提交**

```bash
jj describe -m "feat(judge): 三级评测队列固定比例轮转拉取"
```

---

### Task 5: noj-tests 集成场景

**Files:**
- Modify: `noj-tests/e2e/07_queue.test.ts`（或新建 `noj-tests/e2e/33_priority_queue.test.ts`）

**Interfaces:**
- Consumes: 现有 `e2eTest`、`apiGet`、`apiPost`、`registerUser`、`getAdminToken`、`getProblemIdByNumber`、`submitCode`、`pollSubmission` 等 helper。
- Produces: 一个验证 high/medium 都能被消费的 E2E 用例。

- [ ] **Step 1: 新建 `33_priority_queue.test.ts`**

用例：创建进行中竞赛，提交一个竞赛提交（high）和一个普通提交（medium），轮询两者都到达终态；再触发一次管理员重测（low），也到达终态。这样覆盖三级队列都被消费。

```ts
import {
  apiGet,
  apiPost,
  CODE_SAMPLES,
  e2eTest,
  getAdminToken,
  getProblemIdByNumber,
  isE2E,
  pollSubmission,
  registerUser,
  submitCode,
  TEST_PASSWORD,
  waitForServer,
} from "./helper.ts";

let adminToken = "";
let userToken = "";
let problemId = "";
let contestId = "";

e2eTest("[e2e/priority-queue] Setup", async () => {
  if (!isE2E) return;
  await waitForServer();
  adminToken = await getAdminToken();
  const ts = Date.now().toString(36);
  userToken = await registerUser(`pq_${ts}`, `pq_${ts}@test.com`, TEST_PASSWORD);
  problemId = await getProblemIdByNumber(1001);

  const contest = await apiPost(
    "/api/v1/admin/contest/contests",
    adminToken,
    {
      title: `pq-${ts}`,
      type: "kaggle",
      kind: "public",
      start_time: new Date(Date.now() - 60_000).toISOString(),
      end_time: new Date(Date.now() + 3_600_000).toISOString(),
      problems: [{ problem_id: problemId }],
    },
  );
  if (contest.status !== 201) throw new Error(`建赛失败: ${contest.status}`);
  contestId = (contest.body as { data: { id: string } }).data.id;
});

e2eTest("[e2e/priority-queue] high/medium/low 均能被消费", async () => {
  if (!isE2E) return;
  const highId = await submitCode(userToken, problemId, CODE_SAMPLES.accepted, contestId);
  const mediumId = await submitCode(userToken, problemId, CODE_SAMPLES.accepted);
  await pollSubmission(adminToken, highId, 60, 2000, true);
  await pollSubmission(adminToken, mediumId, 60, 2000, true);

  const rejudge = await apiPost(
    `/api/v1/admin/submission/submissions/${mediumId}/rejudge`,
    adminToken,
  );
  if (rejudge.status !== 200) throw new Error(`重测失败: ${rejudge.status}`);
  await pollSubmission(adminToken, mediumId, 60, 2000, true);
});
```

> 若 `submitCode` 不支持 contestId 参数，先扩展 helper 或在用例中直接调用提交 API 携带 `contest_id`。

- [ ] **Step 2: 运行 E2E**

Run: `cd noj-tests && deno task test`（或按 `E2E_TESTING.md` 启动全链路）
Expected: 新用例通过。

- [ ] **Step 3: 提交**

```bash
jj describe -m "test(e2e): 三级评测队列消费集成场景"
```

---

## Self-Review

- **Spec coverage:** 队列布局（Task 1/4）、优先级推导（Task 2）、sweeper 多队列（Task 3）、队列位置/删除/健康聚合（Task 3）、judge 轮转（Task 4）、E2E（Task 5）、不做可观测性/暂停/兼容（Global Constraints）均已覆盖。
- **Placeholder scan:** 所有代码步骤均给出实际代码或明确修改点；`submitCode` 的 contestId 参数以“若不支持则扩展 helper”标注，属于实现时需确认的接口细节，不是占位。
- **Type consistency:** `JudgeTaskPriority` 在 core 与 Rust `priority: String` 对应；`PulledTask.queue` 在 requeue/ack 中一致使用；`resolveJudgeTaskPriority` 签名在 Task 2/3 中一致。
