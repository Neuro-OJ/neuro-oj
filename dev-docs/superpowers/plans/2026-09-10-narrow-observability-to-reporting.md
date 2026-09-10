# 收窄观测域职责为纯状态上报 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `noj-core` 的观测域收窄为只做"采集自身状态 + 暴露为 Prometheus
文本"，删除告警判定、管理端观测端点与派生指标。

**Architecture:** 观测域保留探针、快照聚合与 `/metrics`
渲染三个内部环节，去掉其上的判定层（`alerts.ts`）、对外 JSON
契约（管理端路由与两个类型）与派生计算（比率/平均延迟）。判定归部署侧 Prometheus
规则文件，展示归 Prometheus / Grafana。

**Tech Stack:** Deno 2 + Hono（noj-core）、Nuxt 4 + Vue 3（noj-ui）、Prometheus
/ Grafana、jj 版本控制。

**Spec:**
`dev-docs/superpowers/specs/2026-09-10-narrow-observability-to-reporting-design.md`

## Global Constraints

- 注释、文档、提交信息用中文；标识符用英文。
- 代码格式化与静态检查：`deno fmt` + `deno lint`（CI 强制）；提交信息格式
  `<type>(<scope>): <中文描述>`，scope 用 `core` / `ui` / `root`。
- 所有提交必须 GPG 签名。
- Deno 测试必须通过 `deno task` 运行：noj-core 用
  `deno task test:domain <domain>`，仓库级门禁用
  `deno run -A scripts/check-ci.ts`。
- `deno task test:domain` **不读 `.env`**，本地运行前需
  `set -a && . ./.env && set +a`。
- 搜索用 `rg`，且**不要**误用 `-r`（`rg -r` 是替换而非递归）。
- 本变更未进入 `main`，删除指标不构成破坏性变更，**无需过渡期**。
- **不得改动**：`/metrics`、`/health`、`/health/live`、`/health/ready`
  的路径与语义；任何原始指标（counter / histogram / gauge）的继续上报。
- **不得删除** `noj_http_rate_limited_total`：它在 `noj-core/src/app.ts`
  被写入，属原始 counter。
- **不得搬迁** `slo.ts` 与 `scripts/gen-alert-rules.ts`（SLO
  定义与规则生成保留原位）。

## File Structure

| 文件                                                             | 责任                       | 动作                            |
| ---------------------------------------------------------------- | -------------------------- | ------------------------------- |
| `noj-core/src/domains/observability/routes/admin.ts`             | 管理端观测 JSON 契约       | 删除                            |
| `noj-core/src/domains/observability/services/alerts.ts`          | 9 条阈值判定               | 删除                            |
| `noj-core/src/domains/observability/index.ts`                    | 域导出面                   | 去掉 admin 路由导出             |
| `noj-core/src/domains/admin/index.ts`                            | admin 门面挂载             | 去掉 `/dashboard` 挂载与 import |
| `noj-core/src/domains/observability/services/snapshot.ts`        | 采集聚合 + `/metrics` 渲染 | 删派生计算与 alerts             |
| `noj-core/src/domains/observability/types.ts`                    | 域内类型                   | 删两个对外类型，快照类型转内部  |
| `noj-core/src/domains/observability/metrics/platform.ts`         | 平台指标定义               | 删两个派生指标定义              |
| `noj-core/src/shared/observability/contracts.ts` / `registry.ts` | 共享写/读契约              | 删 `sum` / `count`              |
| `noj-ui/pages/admin/index.vue`                                   | 管理面板                   | 删观测卡片                      |
| `deploy/monitoring/grafana-dashboard.json`                       | 看板                       | 派生表达式改原始表达式          |
| 四个测试文件                                                     | 行为断言                   | 删/改                           |

---

### Task 1: 移除管理端观测端点

**Files:**

- Delete: `noj-core/src/domains/observability/routes/admin.ts`
- Delete: `noj-core/src/domains/observability/tests/admin.test.ts`
- Modify: `noj-core/src/domains/observability/index.ts`
- Modify: `noj-core/src/domains/admin/index.ts:17,53`

**Interfaces:**

- Consumes: 无。
- Produces: 观测域不再导出 `createObservabilityAdminRouter`；admin
  域不再从观测域导入读侧。

- [ ] **Step 1: 确认当前挂载与导出**

Run:

```bash
cd /home/xyber-nova/Github/neuro-oj
rg -n 'createObservabilityAdminRouter' noj-core/src
```

Expected: 命中
`domains/observability/routes/admin.ts`、`domains/observability/index.ts`、`domains/admin/index.ts`
三处。

- [ ] **Step 2: 删除路由与测试文件**

```bash
cd /home/xyber-nova/Github/neuro-oj
rm noj-core/src/domains/observability/routes/admin.ts
rm noj-core/src/domains/observability/tests/admin.test.ts
```

- [ ] **Step 3: 去掉域导出**

把 `noj-core/src/domains/observability/index.ts` 改为（删除最后一行）：

```ts
export * from "./write.ts";
export * from "./types.ts";
```

- [ ] **Step 4: 去掉 admin 挂载与 import**

在 `noj-core/src/domains/admin/index.ts` 中删除这一行 import：

```ts
import { createObservabilityAdminRouter } from "../observability/index.ts";
```

并删除这一行挂载：

```ts
router.route("/dashboard", createObservabilityAdminRouter(observability));
```

保留同文件中的
`import { observability } from "../observability/write.ts";`——admin
仍需注册指标。

- [ ] **Step 5: 验证无残留引用**

Run:

```bash
cd /home/xyber-nova/Github/neuro-oj
rg -n 'createObservabilityAdminRouter|observability/routes/admin' noj-core/src || echo "无残留"
```

Expected: 输出 `无残留`。

- [ ] **Step 6: 提交**

```bash
cd /home/xyber-nova/Github/neuro-oj
jj describe -m "refactor(core): 移除管理端观测端点与路由"
jj new
```

---

### Task 2: 收缩域内类型、删除告警判定与派生计算

> **合并说明：**
> 原计划把"类型改名"与"删除判定/派生计算"拆成两个任务，但二者互相依赖：`MetricsSnapshot`
> 不含 `api` 字段，而派生计算正是 `api`
> 的唯一来源，分开做会产生无法编译的中间态。故合并为同一任务执行。

**Files:**

- Modify: `noj-core/src/domains/observability/types.ts`
- Modify: `noj-core/src/domains/observability/services/snapshot.ts`
- Modify: `noj-core/src/domains/observability/write.ts`
- Delete: `noj-core/src/domains/observability/services/alerts.ts`
- Delete: `noj-core/src/domains/observability/tests/alerts.test.ts`
- Test: `noj-core/src/domains/observability/tests/snapshot.test.ts`

**Interfaces:**

- Consumes: Task 1 已移除 admin 端点，`collectMetricsSnapshot` 仅剩 `/metrics`
  一个调用方。
- Produces: `MetricsSnapshot`（内部聚合类型，无 `api` / `alerts`
  字段）；`collectMetricsSnapshot(registry): Promise<MetricsSnapshot>`；`renderPrometheusMetrics(registry): Promise<string>`
  签名不变。

- [ ] **Step 1: 先加回归测试（断言派生指标不再进入 /metrics）**

在 `noj-core/src/domains/observability/tests/snapshot.test.ts` 末尾追加：

```ts
Deno.test("snapshot: 不再上报派生的错误率与平均延迟指标", async () => {
  const r = createObservabilityRegistry();
  registerPlatformMetrics(r);
  const out = await renderPrometheusMetrics(r);
  assert(
    !out.includes("noj_api_error_rate_percent"),
    "派生的错误率指标应已移除（判定归 Prometheus 规则）",
  );
  assert(
    !out.includes("noj_api_average_latency_ms"),
    "派生的平均延迟指标应已移除（判定归 Prometheus 规则）",
  );
  assert(
    out.includes("noj_http_request_errors_total"),
    "原始错误计数 counter 必须保留",
  );
  assert(
    out.includes("noj_http_request_duration_seconds"),
    "原始延迟 histogram 必须保留",
  );
});
```

- [ ] **Step 2: 运行确认失败**

Run:

```bash
cd /home/xyber-nova/Github/neuro-oj/noj-core && \
  deno test -A --no-check src/domains/observability/tests/snapshot.test.ts 2>&1 | rg "派生|passed|failed"
```

Expected: FAIL，提示"派生的错误率指标应已移除"。

> 注：此用例此时失败，因为 `metrics/platform.ts` 仍在定义这两个指标（Task 3
> 移除）。这正是它指向下一个任务的原因。

- [ ] **Step 3: 改写 types.ts 为内部聚合类型**

把 `noj-core/src/domains/observability/types.ts` 全文替换为：

```ts
/**
 * 观测域内部聚合类型。
 *
 * 本类型只服务于 `/metrics` 渲染，不构成对外 JSON 契约：
 * 管理端观测端点已移除，展示归 Prometheus / Grafana。
 */

export interface JudgeSnapshot {
  required: boolean;
  workers: number;
  active_tasks: number;
  max_concurrent_tasks: number;
  completed_tasks_total: number;
  failed_tasks_total: number;
  result_push_failures_total: number;
  orphan_containers: number;
  cache_items: number;
  cache_bytes: number;
  work_dir_bytes: number;
  last_seen_at: string | null;
}

export interface MetricsSnapshot {
  generated_at: string;
  dependencies: Record<string, unknown>;
  queue: {
    pending: number | null;
    processing: number | null;
    result_pending: number | null;
    result_processing: number | null;
    judging: number | null;
    oldest_judging_age_seconds: number | null;
  };
  judge: JudgeSnapshot;
  providers?: {
    name: string;
    status: "ok" | "error" | "timeout";
    duration_ms: number;
    error?: string;
  }[];
}
```

- [ ] **Step 4: 从 write.ts 删除读侧类型重导**

`write.ts` 是业务域写侧门面，重导出读侧类型属边界瑕疵。删除这一行：

```ts
export type { ObservabilitySnapshot } from "./types.ts";
```

保留其上方对 `HealthProbe` / `MetricDefinition` / `SnapshotProvider` 的重导。

- [ ] **Step 5: 改写 snapshot.ts：删派生计算与 alerts**

1. import 改为：

```ts
import type { JudgeSnapshot, MetricsSnapshot } from "../types.ts";
```

2. 删除 `import { makeAlerts } from "./alerts.ts";`

3. 删除 `ApiView` 接口（含 `requests_total` / `errors_total` /
   `rate_limited_total` / `error_rate_percent` / `average_latency_ms`
   五个字段）与 `computeApiMetrics()` 函数整块（含其文档注释）。

> `DependencyView` 接口（`status` /
> `latency_ms`）**必须保留**——`renderPrometheusMetrics` 用它读探针状态。

4. 函数改名并去掉 `api` 与 `alerts`：

```ts
export async function collectMetricsSnapshot(
  registry: ObservabilityRegistry,
): Promise<MetricsSnapshot> {
```

函数体内删除 `computedApi` / `providerApi` / `api` 三个变量与 `base`
中间变量，return 改为：

```ts
return {
  generated_at: generatedAt,
  dependencies,
  queue,
  judge,
  providers: partial.providers as MetricsSnapshot["providers"],
};
```

5. `renderPrometheusMetrics` 内改为
   `await collectMetricsSnapshot(registry)`，并删除这两行：

```ts
set("noj_api_error_rate_percent", snapshot.api.error_rate_percent);
set("noj_api_average_latency_ms", snapshot.api.average_latency_ms);
```

- [ ] **Step 6: 删除 alerts 模块与其测试**

```bash
cd /home/xyber-nova/Github/neuro-oj
rm noj-core/src/domains/observability/services/alerts.ts
rm noj-core/src/domains/observability/tests/alerts.test.ts
```

- [ ] **Step 7: 类型检查**

Run:

```bash
cd /home/xyber-nova/Github/neuro-oj/noj-core && deno check src/mod.ts
```

Expected: 无错误。

- [ ] **Step 8: 验证无残留引用**

Run:

```bash
cd /home/xyber-nova/Github/neuro-oj
rg -n 'ObservabilityAlert|makeAlerts|getObservabilitySnapshot' noj-core/src || echo "无残留"
```

Expected: `无残留`。

- [ ] **Step 9: 跑测试（回归用例此时仍红，指向 Task 3）**

Run:

```bash
cd /home/xyber-nova/Github/neuro-oj/noj-core && \
  deno test -A --no-check src/domains/observability/tests/ 2>&1 | tail -4
```

Expected: 仅"不再上报派生的错误率与平均延迟指标"一条 FAILED，其余 PASS。Task 3
完成后转绿。

- [ ] **Step 10: 提交**

```bash
cd /home/xyber-nova/Github/neuro-oj
jj describe -m "refactor(core): 观测域类型转为内部聚合类型并删除告警判定"
jj new
```

---

### Task 3: 删除两个派生指标定义（原 Task 4）

**Files:**

- Modify: `noj-core/src/domains/observability/metrics/platform.ts`

**Interfaces:**

- Consumes: Task 2 已停止 `set` 这两个指标，并已删除 `computeApiMetrics`。
- Produces: `PLATFORM_METRIC_NAMES` 不再包含 `noj_api_error_rate_percent` 与
  `noj_api_average_latency_ms`。

- [ ] **Step 1: 写失败测试**

在 `noj-core/src/domains/observability/tests/platform-metrics.test.ts`
末尾追加：

```ts
Deno.test("platform: 派生指标不再进入平台指标定义", () => {
  const names: readonly string[] = PLATFORM_METRIC_NAMES;
  assert(
    !names.includes("noj_api_error_rate_percent"),
    "派生错误率指标应已从平台指标移除",
  );
  assert(
    !names.includes("noj_api_average_latency_ms"),
    "派生平均延迟指标应已从平台指标移除",
  );
  assert(
    names.includes("noj_http_rate_limited_total"),
    "原始限流 counter 应保留",
  );
});
```

若该文件未导入 `PLATFORM_METRIC_NAMES`，在文件顶部 import 中补上：

```ts
import { PLATFORM_METRIC_NAMES } from "../metrics/platform.ts";
```

- [ ] **Step 2: 运行确认失败**

Run:

```bash
cd /home/xyber-nova/Github/neuro-oj/noj-core && set -a && . ./.env && set +a && \
  deno task test:domain observability 2>&1 | rg -A3 "派生"
```

Expected: FAIL。

- [ ] **Step 3: 从名称数组删除两项**

在 `PLATFORM_METRIC_NAMES` 中删除这两行：

```ts
"noj_api_error_rate_percent",
"noj_api_average_latency_ms",
```

- [ ] **Step 4: 从定义数组删除两个定义块**

删除 `{ name: "noj_api_error_rate_percent", ... }` 与
`{ name: "noj_api_average_latency_ms", ... }` 两个完整对象（含各自的 `help` /
`type` / `owner`）。

- [ ] **Step 5: 运行确认通过**

Run:

```bash
cd /home/xyber-nova/Github/neuro-oj/noj-core && set -a && . ./.env && set +a && \
  deno task test:domain observability
```

Expected: 全部 PASS。

- [ ] **Step 6: 提交**

```bash
cd /home/xyber-nova/Github/neuro-oj
jj describe -m "refactor(core): 移除派生的错误率与平均延迟平台指标"
jj new
```

---

### Task 4: 改 Grafana 看板为原始表达式（原 Task 5）

**Files:**

- Modify: `deploy/monitoring/grafana-dashboard.json`

**Interfaces:**

- Consumes: Task 3 已移除两个派生指标定义。
- Produces: 看板不再查询任何 `noj_api_*` 派生指标。

- [ ] **Step 1: 记录当前表达式（改动前基线）**

Run:

```bash
cd /home/xyber-nova/Github/neuro-oj
python3 -c "
import json
d=json.load(open('deploy/monitoring/grafana-dashboard.json'))
def walk(p,out):
    for panel in p.get('panels',[]):
        if 'panels' in panel: walk(panel,out)
        else:
            exprs=[t.get('expr','') for t in panel.get('targets',[])]
            if any('noj_api_' in e for e in exprs): out.append((panel.get('id'),panel.get('title'),exprs))
out=[];walk(d,out)
for i,t,e in out: print(f'id={i} title={t} exprs={e}')
"
```

Expected: 输出 `id=3 title=API 错误率` 与 `id=7 title=请求延迟与错误率`
两个面板。

- [ ] **Step 2: 替换表达式**

把看板中三处 `expr` 按此映射替换：

| 原表达式                     | 新表达式                                                                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `noj_api_error_rate_percent` | `100 * sum(rate(noj_http_request_errors_total[5m])) / clamp_min(sum(rate(noj_http_requests_total[5m])), 0.001)`                          |
| `noj_api_average_latency_ms` | `1000 * sum(rate(noj_http_request_duration_seconds_sum[5m])) / clamp_min(sum(rate(noj_http_request_duration_seconds_count[5m])), 0.001)` |

- [ ] **Step 3: 验证 JSON 合法且无残留**

Run:

```bash
cd /home/xyber-nova/Github/neuro-oj
python3 -c "
import json
d=json.load(open('deploy/monitoring/grafana-dashboard.json'))
s=json.dumps(d)
assert 'noj_api_error_rate_percent' not in s, '仍有残留'
assert 'noj_api_average_latency_ms' not in s, '仍有残留'
assert 'noj_http_request_errors_total' in s, '新表达式未写入'
print('✓ JSON 合法且表达式已替换')
"
```

Expected: `✓ JSON 合法且表达式已替换`。

- [ ] **Step 4: 提交**

```bash
cd /home/xyber-nova/Github/neuro-oj
jj describe -m "refactor(root): Grafana 看板改用原始表达式替代派生指标"
jj new
```

---

### Task 5: 删除 registry 的 sum / count 契约（原 Task 6）

**Files:**

- Modify: `noj-core/src/shared/observability/contracts.ts`
- Modify: `noj-core/src/shared/observability/registry.ts`

**Interfaces:**

- Consumes: Task 2 已删除唯一调用方 `computeApiMetrics`。
- Produces: `ObservabilityRegistry` 不再声明 `sum` / `count`。

- [ ] **Step 1: 确认无调用方**

Run:

```bash
cd /home/xyber-nova/Github/neuro-oj
rg -n '\.(sum|count)\(' noj-core/src | grep -v '/tests/' || echo "无调用方"
```

Expected: `无调用方`。

- [ ] **Step 2: 删除契约声明**

在 `noj-core/src/shared/observability/contracts.ts` 中删除这两行：

```ts
sum(name: string): number;
count(name: string): number;
```

- [ ] **Step 3: 删除实现**

在 `noj-core/src/shared/observability/registry.ts` 中删除
`sum(name: string): number { ... }` 与 `count(name: string): number { ... }`
两个方法实现。

- [ ] **Step 4: 类型检查与测试**

Run:

```bash
cd /home/xyber-nova/Github/neuro-oj/noj-core && deno check src/mod.ts && \
  set -a && . ./.env && set +a && deno task test:domain observability
```

Expected: 类型检查无错误，测试全部 PASS。

- [ ] **Step 5: 运行仓库门禁**

Run:

```bash
cd /home/xyber-nova/Github/neuro-oj
deno run -A scripts/check-ci.ts
```

Expected: `CI 仓库级门禁通过`。若 `check-domains` 因 admin→observability 边界
fixture 失败，转入 Task 7 一并处理。

- [ ] **Step 6: 提交**

```bash
cd /home/xyber-nova/Github/neuro-oj
jj describe -m "refactor(core): 收缩观测注册表契约，移除 sum/count"
jj new
```

---

### Task 6: 删除管理面板观测卡片（原 Task 7）

**Files:**

- Modify: `noj-ui/pages/admin/index.vue:64,66-67,107,112,122-123,226-250`

**Interfaces:**

- Consumes: Task 1 已移除后端端点。
- Produces: 管理面板不再请求或渲染观测数据。

- [ ] **Step 1: 删除状态与请求**

在 `noj-ui/pages/admin/index.vue` 中：

1. 删除这两个 ref：

```ts
const observability = ref<ObservabilitySnapshot | null>(null);
const observabilityError = ref("");
```

2. 从 `Promise.allSettled` 数组中删除该项：

```ts
api.get<{ data: ObservabilitySnapshot }>("/api/v1/admin/query/dashboard/observability", { silent: true }),
```

并把解构
`const [userRes, problemRes, submissionRes, queueRes, observabilityRes]` 改为
`const [userRes, problemRes, submissionRes, queueRes]`。

3. 删除赋值与错误处理两行：

```ts
observability.value = observabilityRes.status === "fulfilled"
  ? observabilityRes.value.data
  : observability.value;
if (!silent) {
  observabilityError.value = observabilityRes.status === "rejected"
    ? "生产观测数据加载失败"
    : "";
}
```

- [ ] **Step 2: 删除模板块**

删除观测卡片整个 `<div v-if="observability" ...>...</div>` 块（原 226-250
行区间，含其中的依赖状态、Judge Worker、告警列表渲染）。

- [ ] **Step 3: 删除本地类型引用**

若文件顶部或脚本区有 `ObservabilitySnapshot` 的本地类型定义或 import，一并删除。

- [ ] **Step 4: 验证无残留**

Run:

```bash
cd /home/xyber-nova/Github/neuro-oj
rg -n 'observability|ObservabilitySnapshot' noj-ui/pages/admin/index.vue || echo "无残留"
```

Expected: `无残留`。

- [ ] **Step 5: 前端检查**

Run:

```bash
cd /home/xyber-nova/Github/neuro-oj/noj-ui && deno task test 2>&1 | tail -5
```

Expected: 通过（若该任务需要 DB/Redis 且不可用，改为 `deno check`
相关文件并在提交信息中注明）。

- [ ] **Step 6: 提交**

```bash
cd /home/xyber-nova/Github/neuro-oj
jj describe -m "refactor(ui): 移除管理面板观测卡片"
jj new
```

---

### Task 7: 更新权限测试与域边界门禁（原 Task 8）

**Files:**

- Modify: `noj-core/src/domains/identity/tests/routes/auth-admin.test.ts`
- Modify: `scripts/check-domains_test.ts`

**Interfaces:**

- Consumes: Task 1 已删除端点；admin 域不再导入观测域读侧。
- Produces: 测试不再断言不存在的路由；域边界门禁改为断言 admin
  不得导入观测域读侧。

- [ ] **Step 1: 删除三条观测端点断言**

在 `noj-core/src/domains/identity/tests/routes/auth-admin.test.ts` 中删除 `name`
含 `/api/v1/admin/query/dashboard/observability` 的三个 `Deno.test({...})`
块（未登录 401、非管理员 403、管理员 200）。

- [ ] **Step 2: 更新域边界 fixture**

在 `scripts/check-domains_test.ts` 中：

1. 删除引用 `getObservabilitySnapshot` 的 fixture（原 90 行附近）：

```ts
`import { getObservabilitySnapshot } from "../../observability/services/snapshot.ts";\n`,
```

2. 把断言 `checkFile: admin import observability/index.ts 允许`
   的测试改为断言**不允许导入读侧**：

```ts
Deno.test("checkFile: admin 不得 import observability 读侧", async () => {
  const errors = await checkFile(
    "admin/index.ts",
    `import { collectMetricsSnapshot } from "../observability/services/snapshot.ts";\n`,
  );
  if (errors.length === 0) {
    throw new Error("admin 从观测域导入读侧应被域边界检查拒绝");
  }
});
```

> 注：`checkFile` 的调用签名以该文件内既有 fixture
> 为准；若参数顺序或返回类型不同，按既有用法对齐，保持断言意图不变。

- [ ] **Step 3: 运行门禁**

Run:

```bash
cd /home/xyber-nova/Github/neuro-oj
deno run -A scripts/check-ci.ts
```

Expected: `CI 仓库级门禁通过`。

- [ ] **Step 4: 提交**

```bash
cd /home/xyber-nova/Github/neuro-oj
jj describe -m "test(core): 同步移除观测端点断言并收紧域边界门禁"
jj new
```

---

### Task 8: 更新文档（原 Task 9）

**Files:**

- Modify: `dev-docs/engineering/metric-catalog.md:47-48`
- Modify: `noj-docs/docs/operators/observability.md:100`
- Modify: `docs/operators/observability.md:63`
- Modify:
  `.agents/notes/implemented/architecture/2026-09-10-observability-domain.md:26`

**Interfaces:**

- Consumes: Task 1/3 已删除端点与指标定义。
- Produces: 文档不再引用已删除的端点与派生指标。

- [ ] **Step 1: 删除指标目录中的两行**

在 `dev-docs/engineering/metric-catalog.md` 中删除这两行表格行：

```
| `noj_api_error_rate_percent`           | gauge     | API 5xx 错误率百分比          |
| `noj_api_average_latency_ms`           | gauge     | API 平均延迟                  |
```

- [ ] **Step 2: 改运维文档的指标指引**

`noj-docs/docs/operators/observability.md:100` 原文：

```
3. 恢复后确认 5 分钟窗口错误率回落；进程累计指标（`noj_api_error_rate_percent`）仅作长期参考。
```

改为：

```
3. 恢复后确认 5 分钟窗口错误率回落：`sum(rate(noj_http_request_errors_total[5m])) / sum(rate(noj_http_requests_total[5m]))`。
```

- [ ] **Step 3: 改另一份运维文档**

`docs/operators/observability.md:63` 原文：

```
1. 查看 `noj_api_error_rate_percent`、`noj_api_average_latency_ms`，再按 route/status 查询结构化日志。
```

改为：

```
1. 查看 `sum(rate(noj_http_request_errors_total[5m])) / sum(rate(noj_http_requests_total[5m]))` 与 histogram 的 `_sum/_count`，再按 route/status 查询结构化日志。
```

- [ ] **Step 4: 更新 Agent Note 的路径清单**

在 `.agents/notes/implemented/architecture/2026-09-10-observability-domain.md`
中把第 26-27 行保留的对外路径清单：

```
- 保留 `/health*`、`/metrics`、`/api/v1/admin/dashboard/observability`
  路径与语义。
```

改为：

```
- 保留 `/health*` 与 `/metrics` 路径与语义；管理端观测端点已按
  [观测域收窄](../bug-fix/2026-09-10-observability-gates-review-fixes.md) 后续决策移除。
```

- [ ] **Step 5: 校验文档**

Run:

```bash
cd /home/xyber-nova/Github/neuro-oj
deno run -A scripts/verify-md-links.ts && deno run -A scripts/verify-agent-note-format.ts && \
  deno fmt --check dev-docs/engineering/metric-catalog.md noj-docs/docs/operators/observability.md
```

Expected: 三项均通过。

- [ ] **Step 6: 提交**

```bash
cd /home/xyber-nova/Github/neuro-oj
jj describe -m "docs(root): 同步观测域收窄后的指标与端点说明"
jj new
```

---

### Task 9: 全量验收（原 Task 10）

**Files:**

- 无新增；仅运行验证。

**Interfaces:**

- Consumes: Task 1-8 全部完成。
- Produces: 收窄后的完整验收证据。

- [ ] **Step 1: 仓库级门禁**

Run:

```bash
cd /home/xyber-nova/Github/neuro-oj
deno run -A scripts/check-ci.ts
```

Expected: `CI 仓库级门禁通过`。

- [ ] **Step 2: core 观测域测试**

Run:

```bash
cd /home/xyber-nova/Github/neuro-oj/noj-core && set -a && . ./.env && set +a && \
  deno task test:domain observability
```

Expected: 全部 PASS，无 FAILED。

- [ ] **Step 3: 关键契约仍在**

Run:

```bash
cd /home/xyber-nova/Github/neuro-oj/noj-core && set -a && . ./.env && set +a && \
  deno task test:domain observability 2>&1 | rg -i "无重复 HELP|health: ready|派生"
```

Expected: 命中"无重复 HELP"与"health: ready"相关用例；"派生"用例通过。

- [ ] **Step 4: 监控门禁（SLO 规则与 runbook 未受影响）**

Run:

```bash
cd /home/xyber-nova/Github/neuro-oj
bash scripts/deploy/test-monitoring.sh && deno run -A scripts/gen-alert-rules.ts --check
```

Expected: `监控配置一致性测试通过` 与 `SLO 告警规则与 SLO 定义一致`。

- [ ] **Step 5: 格式与静态检查**

Run:

```bash
cd /home/xyber-nova/Github/neuro-oj
deno fmt --check noj-core/src/domains/observability noj-core/src/shared/observability \
  noj-ui/pages/admin/index.vue scripts/check-domains_test.ts && \
deno lint noj-core/src/domains/observability noj-core/src/shared/observability
```

Expected: 均通过。

- [ ] **Step 6: 确认删除物与保留物**

Run:

```bash
cd /home/xyber-nova/Github/neuro-oj
echo "--- 应不存在 ---"
ls noj-core/src/domains/observability/routes/admin.ts 2>&1 | rg -q 'No such' && echo "✓ admin.ts 已删除"
ls noj-core/src/domains/observability/services/alerts.ts 2>&1 | rg -q 'No such' && echo "✓ alerts.ts 已删除"
echo "--- 应存在 ---"
rg -q 'noj_http_rate_limited_total' noj-core/src/app.ts && echo "✓ 限流 counter 仍在上报"
rg -q 'collectMetricsSnapshot' noj-core/src/domains/observability/services/snapshot.ts && echo "✓ 纯聚合函数存在"
rg -q 'renderPrometheusMetrics' noj-core/src/domains/observability/services/snapshot.ts && echo "✓ /metrics 渲染仍在"
```

Expected: 五行 `✓` 全部输出。

- [ ] **Step 7: 汇总证据并汇报**

把上述命令的实际输出汇总为验收报告，明确列出：通过项、失败项（若有）、以及未覆盖项（例如本地
DB 脏导致未能跑的测试）。

---

## 风险与已知边界

- **本地 DB 可能脏**：`noj-core` 本地库曾出现 `contests.kind`
  已存在导致迁移失败。`test:domain` 依赖真实
  PG，若迁移失败则域测试无法运行。此时以 `deno check` + `scripts/check-ci.ts`
  为替代验证，并在汇报中明确标注未跑域测试。
- **`check-domains_test.ts` 的 fixture 签名**：Task 8 按断言意图编写，实际
  `checkFile` 调用形式以该文件既有用法为准。
- **`auth-admin.test.ts` 的 `skip`**：`skip = !hasDb || !hasEnv`，本地无 env
  时这些测试被忽略；删除三条断言后需确认该文件仍有其他用例在跑，避免整文件变空。
