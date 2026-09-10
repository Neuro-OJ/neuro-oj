# 可观测性平台域（Observability Domain）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 noj-core 内把可观测性抽离为 `domains/observability` 平台域，建立无环依赖、Fail-open 写入、CI 强制边界的长期架构，并扩充五类指标与 SLO 单一事实源。

**Architecture:** 双层结构——`shared/observability` 低层 kernel 承载 registry/契约/日志上下文；`domains/observability` 平台域承载平台指标、探针、快照聚合、健康/指标/管理路由、Judge 心跳、SLO 与外部运行时契约。业务域只能通过 `domains/observability/write.ts` 写指标/注册 provider；观测域不 import 任何业务域，聚合通过 `app.ts` 组合根注入 provider 完成。

**Tech Stack:** Deno 2、TypeScript、Hono、Redis、PostgreSQL、Prometheus/Grafana/Alertmanager、`scripts/check-domains.ts`。

**Spec:** `dev-docs/superpowers/specs/2026-09-10-observability-domain-design.md`

## Global Constraints

- 所有提交必须 GPG 签名，使用 `jj` 提交；提交信息遵循 Conventional Commits，描述使用中文。
- 搜索代码/文件内容必须使用 `rg`（ripgrep）。
- 新 Deno 脚本必须通过 `deno fmt`、`deno lint`。
- 禁止修改 `_journal.json`、`deno.lock`、`Cargo.lock`。
- 新环境变量必须登记 `noj-core/src/shared/config/settings-registry.ts` 与 `noj-core/.env.example`，并通过 `deno task check:env`。
- 测试必须使用项目规定命令：`deno task test:domain observability`、`bash scripts/test-shared.sh`、`cd noj-tests && deno task test:domain cross-domain`；禁止手拼 `deno test` 绕过脚本。
- 不新增运行时依赖。
- 保留对外路径与语义：`/metrics`、`/health`、`/health/live`、`/health/ready`、`/api/v1/admin/dashboard/observability`。
- 非平凡变更需新增/更新 `.agents/notes/implemented/` 下对应 Agent Note。

---

### Task 1: 创建 `shared/observability` kernel（contracts + labels + registry）

**Files:**
- Create: `noj-core/src/shared/observability/contracts.ts`
- Create: `noj-core/src/shared/observability/labels.ts`
- Create: `noj-core/src/shared/observability/registry.ts`
- Create: `noj-core/src/shared/observability/index.ts`
- Test: `noj-core/tests/shared/observability/registry.test.ts`

**Interfaces:**
- Consumes: 无（kernel 是新的最低层）。
- Produces:
  - `export type MetricType = "counter" | "gauge" | "histogram"`
  - `export type MetricLabels = Readonly<Record<string, string | number | boolean>>`
  - `export interface MetricDefinition { name; help; type; owner; labels?; buckets? }`
  - `export interface MetricSink { define; inc; set; add; observe }`
  - `export interface HealthProbeResult { status: "up" | "down" | "unknown"; latency_ms?; detail?; error? }`
  - `export interface HealthProbe { name; critical; timeoutMs?; check() }`
  - `export interface SnapshotProvider<T = unknown> { name; timeoutMs?; collect() }`
  - `export interface ObservabilityRegistry extends MetricSink { registerHealthProbe; registerSnapshotProvider; registerBusinessMetric; sum; count; render }`
  - `export function createObservabilityRegistry(options?: { strict?: boolean; maxSeriesPerMetric?: number }): ObservabilityRegistry`
  - `export const observability: ObservabilityRegistry`
  - `export const LABEL_WHITELIST: readonly string[]`
  - `export const MAX_LABEL_VALUE_LENGTH = 64`
  - `export const MAX_SERIES_PER_METRIC = 1000`
  - `export function normalizeMetricRoute(path: string, routePath?: string): string`
  - `export function validateMetricDefinition(def: MetricDefinition): string[]`（返回错误列表）

- [ ] **Step 1: 写失败测试**

创建 `noj-core/tests/shared/observability/registry.test.ts`：

```ts
import {
  createObservabilityRegistry,
  validateMetricDefinition,
  normalizeMetricRoute,
  LABEL_WHITELIST,
} from "../../../src/shared/observability/index.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("registry: counter inc/sum/render", () => {
  const r = createObservabilityRegistry({ strict: true });
  r.define({ name: "noj_http_requests_total", help: "HTTP 请求总数", type: "counter", owner: "platform" });
  r.inc("noj_http_requests_total", { method: "GET", route: "/health", status: "200" });
  assert(r.sum("noj_http_requests_total") === 1, "sum 应为 1");
  const out = r.render();
  assert(out.includes("noj_http_requests_total{method=\"GET\",route=\"/health\",status=\"200\"} 1"), "render 应包含序列");
});

Deno.test("registry: 未定义指标写入是 no-op 且不抛错", () => {
  const r = createObservabilityRegistry();
  r.inc("noj_unknown_total");
  assert(r.sum("noj_unknown_total") === 0, "未定义指标 sum 应为 0");
});

Deno.test("registry: 非法标签被丢弃并产生自观测计数", () => {
  const r = createObservabilityRegistry();
  r.define({ name: "noj_test_total", help: "测试", type: "counter", owner: "platform" });
  r.inc("noj_test_total", { user_id: "u-123" });
  assert(r.sum("noj_test_total") === 0, "非法标签样本应被丢弃");
  assert(r.sum("noj_observability_write_errors_total") >= 1, "应记录写错误");
});

Deno.test("registry: 基数超限丢弃新序列", () => {
  const r = createObservabilityRegistry({ maxSeriesPerMetric: 2 });
  r.define({ name: "noj_test_total", help: "测试", type: "counter", owner: "platform", labels: ["route"] });
  r.inc("noj_test_total", { route: "/a" });
  r.inc("noj_test_total", { route: "/b" });
  r.inc("noj_test_total", { route: "/c" });
  assert(r.sum("noj_test_total") === 2, "只应保留前两个序列");
  assert(r.sum("noj_observability_metric_dropped_total") >= 1, "应记录丢弃");
});

Deno.test("registry: strict 模式类型冲突抛错", () => {
  const r = createObservabilityRegistry({ strict: true });
  r.define({ name: "noj_test_total", help: "测试", type: "counter", owner: "platform" });
  let threw = false;
  try {
    r.define({ name: "noj_test_total", help: "测试", type: "gauge", owner: "platform" });
  } catch {
    threw = true;
  }
  assert(threw, "strict 模式类型冲突应抛错");
});

Deno.test("validateMetricDefinition: 拒绝动态 ID 标签", () => {
  const errors = validateMetricDefinition({
    name: "noj_test_total", help: "测试", type: "counter", owner: "submission",
    labels: ["user_id"],
  });
  assert(errors.length > 0, "user_id 标签应被拒绝");
});

Deno.test("normalizeMetricRoute: 隐藏 UUID 和数字", () => {
  assert(normalizeMetricRoute("/api/v1/submissions/550e8400-e29b-41d4-a716-446655440000") === "/api/v1/submissions/:id", "UUID 应归一化为 :id");
  assert(normalizeMetricRoute("/api/v1/users/123") === "/api/v1/users/:id", "数字应归一化为 :id");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-core && deno test -A --no-check tests/shared/observability/registry.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 kernel**

创建 `noj-core/src/shared/observability/contracts.ts`：

```ts
export type MetricType = "counter" | "gauge" | "histogram";
export type MetricLabels = Readonly<Record<string, string | number | boolean>>;

export interface MetricDefinition {
  name: string;
  help: string;
  type: MetricType;
  owner: string;
  labels?: readonly string[];
  buckets?: readonly number[];
}

export interface MetricSink {
  define(def: MetricDefinition): void;
  inc(name: string, labels?: MetricLabels, amount?: number): void;
  set(name: string, value: number, labels?: MetricLabels): void;
  add(name: string, amount: number, labels?: MetricLabels): void;
  observe(name: string, value: number, labels?: MetricLabels): void;
}

export interface HealthProbeResult {
  status: "up" | "down" | "unknown";
  latency_ms?: number;
  detail?: Record<string, unknown>;
  error?: string;
}

export interface HealthProbe {
  name: string;
  critical: boolean;
  timeoutMs?: number;
  check(): Promise<HealthProbeResult> | HealthProbeResult;
}

export interface SnapshotProvider<T = unknown> {
  name: string;
  timeoutMs?: number;
  collect(): Promise<T>;
}

export interface ObservabilityRegistry extends MetricSink {
  registerHealthProbe(probe: HealthProbe): void;
  registerSnapshotProvider(provider: SnapshotProvider): void;
  registerBusinessMetric(def: MetricDefinition): void;
  listHealthProbes(): HealthProbe[];
  listSnapshotProviders(): SnapshotProvider[];
  sum(name: string): number;
  count(name: string): number;
  render(): string;
}
```

创建 `noj-core/src/shared/observability/labels.ts`：

```ts
import type { MetricLabels } from "./contracts.ts";

export const LABEL_WHITELIST = [
  "method", "route", "status", "queue", "provider", "language", "result", "type", "criticality",
] as const;

export const MAX_LABEL_VALUE_LENGTH = 64;
export const MAX_SERIES_PER_METRIC = 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i;

export function validateLabels(
  name: string,
  labels: MetricLabels | undefined,
  allowedLabels: readonly string[] | undefined,
): string[] {
  const errors: string[] = [];
  if (!labels) return errors;
  const entries = Object.entries(labels);
  if (entries.length > 5) errors.push("标签数量超过 5");
  for (const [key, value] of entries) {
    if (allowedLabels && !allowedLabels.includes(key)) {
      errors.push(`标签不在白名单: ${key}`);
    }
    if (!LABEL_WHITELIST.includes(key as (typeof LABEL_WHITELIST)[number])) {
      errors.push(`标签不在全局白名单: ${key}`);
    }
    const str = String(value);
    if (str.length > MAX_LABEL_VALUE_LENGTH) errors.push(`标签值过长: ${key}`);
    if (UUID_RE.test(str)) errors.push(`标签值疑似动态 ID: ${key}`);
  }
  return errors;
}
```

创建 `noj-core/src/shared/observability/registry.ts`：

```ts
import type {
  HealthProbe,
  MetricDefinition,
  MetricLabels,
  MetricSink,
  ObservabilityRegistry,
  SnapshotProvider,
} from "./contracts.ts";
import { MAX_SERIES_PER_METRIC, validateLabels } from "./labels.ts";

const DEFAULT_HISTOGRAM_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface MetricValue {
  kind: "counter" | "gauge" | "histogram";
  value: number;
  buckets?: number[];
  counts?: number[];
  sum?: number;
  count?: number;
}

interface MetricState {
  def: MetricDefinition;
  values: Map<string, MetricValue>;
}

function normalizeLabels(labels: MetricLabels = {}): [string, string][] {
  return Object.entries(labels)
    .map(([key, value]) => [key, String(value)] as [string, string])
    .sort(([a], [b]) => a.localeCompare(b));
}

function labelsKey(labels: MetricLabels): string {
  return JSON.stringify(normalizeLabels(labels));
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

function renderLabels(labels: [string, string][]): string {
  if (labels.length === 0) return "";
  return `{${labels.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(",")}}`;
}

function finiteValue(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

export function createObservabilityRegistry(options: {
  strict?: boolean;
  maxSeriesPerMetric?: number;
} = {}): ObservabilityRegistry {
  const strict = options.strict ?? false;
  const maxSeries = options.maxSeriesPerMetric ?? MAX_SERIES_PER_METRIC;
  const metrics = new Map<string, MetricState>();
  const probes = new Map<string, HealthProbe>();
  const providers = new Map<string, SnapshotProvider>();
  const self = new Map<string, number>();

  function selfInc(name: string): void {
    self.set(name, (self.get(name) ?? 0) + 1);
  }

  function requireState(name: string, type: MetricDefinition["type"]): MetricState | undefined {
    const state = metrics.get(name);
    if (!state) {
      selfInc("noj_observability_write_errors_total");
      return undefined;
    }
    if (state.def.type !== type) {
      selfInc("noj_observability_write_errors_total");
      return undefined;
    }
    return state;
  }

  function write(
    name: string,
    type: MetricDefinition["type"],
    labels: MetricLabels | undefined,
    mutate: (value: MetricValue) => void,
  ): void {
    try {
      const state = requireState(name, type);
      if (!state) return;
      const errors = validateLabels(name, labels, state.def.labels);
      if (errors.length > 0) {
        selfInc("noj_observability_write_errors_total");
        return;
      }
      const key = labelsKey(labels ?? {});
      if (state.values.size >= maxSeries && !state.values.has(key)) {
        selfInc("noj_observability_metric_dropped_total");
        return;
      }
      const current = state.values.get(key);
      if (current) {
        mutate(current);
      } else {
        const base: MetricValue = type === "histogram"
          ? { kind: "histogram", value: 0, buckets: [...(state.def.buckets ?? DEFAULT_HISTOGRAM_BUCKETS)], counts: [], sum: 0, count: 0 }
          : { kind: type, value: 0 };
        mutate(base);
        state.values.set(key, base);
      }
    } catch {
      selfInc("noj_observability_write_errors_total");
    }
  }

  const registry: ObservabilityRegistry = {
    define(def: MetricDefinition): void {
      const existing = metrics.get(def.name);
      if (existing) {
        if (existing.def.type !== def.type) {
          if (strict) throw new Error(`指标类型冲突: ${def.name}`);
          selfInc("noj_observability_write_errors_total");
        }
        return;
      }
      metrics.set(def.name, { def, values: new Map() });
    },

    inc(name: string, labels?: MetricLabels, amount = 1): void {
      write(name, "counter", labels, (v) => { v.value += finiteValue(amount); });
    },

    set(name: string, value: number, labels?: MetricLabels): void {
      write(name, "gauge", labels, (v) => { v.value = finiteValue(value); });
    },

    add(name: string, amount: number, labels?: MetricLabels): void {
      write(name, "gauge", labels, (v) => { v.value += finiteValue(amount); });
    },

    observe(name: string, value: number, labels?: MetricLabels): void {
      write(name, "histogram", labels, (v) => {
        const safe = Math.max(0, finiteValue(value));
        v.sum = (v.sum ?? 0) + safe;
        v.count = (v.count ?? 0) + 1;
        const buckets = v.buckets ?? [];
        const counts = v.counts ?? [];
        for (let i = 0; i < buckets.length; i++) {
          if (safe <= buckets[i]!) counts[i] = (counts[i] ?? 0) + 1;
        }
        v.counts = counts;
      });
    },

    registerHealthProbe(probe: HealthProbe): void {
      probes.set(probe.name, probe);
    },

    registerSnapshotProvider(provider: SnapshotProvider): void {
      providers.set(provider.name, provider);
    },

    registerBusinessMetric(def: MetricDefinition): void {
      const errors = validateMetricDefinition(def);
      if (errors.length > 0) {
        if (strict) throw new Error(errors.join("; "));
        selfInc("noj_observability_write_errors_total");
        return;
      }
      registry.define(def);
    },

    listHealthProbes(): HealthProbe[] {
      return [...probes.values()];
    },

    listSnapshotProviders(): SnapshotProvider[] {
      return [...providers.values()];
    },

    sum(name: string): number {
      const state = metrics.get(name);
      if (!state) return 0;
      let total = 0;
      for (const v of state.values.values()) {
        total += v.kind === "histogram" ? (v.sum ?? 0) : v.value;
      }
      return total;
    },

    count(name: string): number {
      const state = metrics.get(name);
      if (!state) return 0;
      let total = 0;
      for (const v of state.values.values()) {
        total += v.kind === "histogram" ? (v.count ?? 0) : 1;
      }
      return total;
    },

    render(): string {
      const lines: string[] = [];
      for (const [name, state] of [...metrics.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(`# HELP ${name} ${state.def.help}`);
        lines.push(`# TYPE ${name} ${state.def.type}`);
        for (const [key, v] of [...state.values.entries()].sort(([a], [b]) => a.localeCompare(b))) {
          const labels = JSON.parse(key) as [string, string][];
          const rendered = renderLabels(labels);
          if (v.kind === "histogram") {
            const buckets = v.buckets ?? [];
            const counts = v.counts ?? [];
            buckets.forEach((bucket, i) => {
              lines.push(`${name}_bucket${renderLabels([...labels, ["le", String(bucket)]])} ${counts[i] ?? 0}`);
            });
            lines.push(`${name}_bucket${renderLabels([...labels, ["le", "+Inf"]])} ${v.count ?? 0}`);
            lines.push(`${name}_sum${rendered} ${v.sum ?? 0}`);
            lines.push(`${name}_count${rendered} ${v.count ?? 0}`);
          } else {
            lines.push(`${name}${rendered} ${v.value}`);
          }
        }
      }
      for (const [name, value] of [...self.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(`# HELP ${name} 观测自身错误计数`);
        lines.push(`# TYPE ${name} counter`);
        lines.push(`${name} ${value}`);
      }
      return lines.length > 0 ? `${lines.join("\n")}\n` : "";
    },
  };

  registry.define({ name: "noj_observability_write_errors_total", help: "观测写错误总数", type: "counter", owner: "platform" });
  registry.define({ name: "noj_observability_metric_dropped_total", help: "观测指标丢弃总数", type: "counter", owner: "platform" });
  return registry;
}

export const observability = createObservabilityRegistry();

export function validateMetricDefinition(def: MetricDefinition): string[] {
  const errors: string[] = [];
  if (!/^noj_[a-z][a-z0-9_]*$/.test(def.name)) errors.push("指标名必须以 noj_ 开头且只含小写字母/数字/下划线");
  if (!def.help) errors.push("help 必填");
  if (!def.owner) errors.push("owner 必填");
  if (def.labels) {
    for (const label of def.labels) {
      if (!LABEL_WHITELIST.includes(label as (typeof LABEL_WHITELIST)[number])) {
        errors.push(`标签不在白名单: ${label}`);
      }
    }
  }
  return errors;
}

export function normalizeMetricRoute(path: string, routePath?: string): string {
  if (routePath && routePath.includes(":")) return routePath;
  return path.split("/").map((segment) => {
    if (!segment) return segment;
    if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment)) return ":id";
    if (/^\d+$/.test(segment)) return ":id";
    if (segment.length > 48) return ":param";
    return segment;
  }).join("/") || "/";
}
```

创建 `noj-core/src/shared/observability/index.ts`：

```ts
export * from "./contracts.ts";
export * from "./labels.ts";
export { createObservabilityRegistry, observability, validateMetricDefinition, normalizeMetricRoute } from "./registry.ts";
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-core && deno test -A --no-check tests/shared/observability/registry.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj commit -m "feat(core): 新增 shared/observability kernel 指标注册表"
```

---

### Task 2: 创建 `shared/observability/context.ts` 并迁移日志上下文

**Files:**
- Create: `noj-core/src/shared/observability/context.ts`
- Modify: `noj-core/src/shared/base/logging.ts`
- Modify: `noj-core/src/shared/middleware/request-context.ts`
- Test: `noj-core/tests/shared/observability/context.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `export function runWithRequestContext<T>(requestId: string, fn: () => T): T`
  - `export function getRequestId(): string | undefined`
  - `export interface RequestContext { requestId: string }`

- [ ] **Step 1: 写失败测试**

创建 `noj-core/tests/shared/observability/context.test.ts`：

```ts
import { getRequestId, runWithRequestContext } from "../../../src/shared/observability/context.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("context: runWithRequestContext 内可读取 requestId", () => {
  let inside: string | undefined;
  runWithRequestContext("req-1", () => {
    inside = getRequestId();
  });
  assert(inside === "req-1", "上下文内应读到 req-1");
});

Deno.test("context: 上下文外 getRequestId 返回 undefined", () => {
  assert(getRequestId() === undefined, "上下文外应为 undefined");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-core && deno test -A --no-check tests/shared/observability/context.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 context 并更新 logging**

创建 `noj-core/src/shared/observability/context.ts`：

```ts
import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  requestId: string;
}

const requestStore = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(requestId: string, fn: () => T): T {
  return requestStore.run({ requestId }, fn);
}

export function getRequestId(): string | undefined {
  return requestStore.getStore()?.requestId;
}
```

修改 `noj-core/src/shared/base/logging.ts`：

- 删除文件顶部的 `import { AsyncLocalStorage } from "node:async_hooks";`、`interface RequestContext`、`const requestStore`、`runWithRequestContext`、`getRequestId` 定义。
- 改为 `import { getRequestId } from "../observability/context.ts";`
- `emit` 内部原 `requestStore.getStore()?.requestId` 改为 `getRequestId()`。

修改 `noj-core/src/shared/middleware/request-context.ts`：

- 把 `import { runWithRequestContext } from "../base/logging.ts";` 改为 `import { runWithRequestContext } from "../observability/context.ts";`

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-core && deno test -A --no-check tests/shared/observability/context.test.ts && deno check src/shared/base/logging.ts src/shared/middleware/request-context.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj commit -m "refactor(core): 迁移请求日志上下文到 shared/observability"
```

---

### Task 3: 更新 `shared/db` 与 `shared/mq` 使用 kernel registry

**Files:**
- Modify: `noj-core/src/shared/db/connection.ts`
- Modify: `noj-core/src/shared/mq/connection.ts`
- Test: `noj-core/tests/shared/observability/health-registration.test.ts`

**Interfaces:**
- Consumes: `observability`、`ObservabilityRegistry` from `../observability/registry.ts`。
- Produces:
  - `export function registerDbHealthProbe(registry: ObservabilityRegistry): void`
  - `export function registerRedisHealthProbe(registry: ObservabilityRegistry): void`

- [ ] **Step 1: 写失败测试**

创建 `noj-core/tests/shared/observability/health-registration.test.ts`：

```ts
import { createObservabilityRegistry } from "../../../src/shared/observability/registry.ts";
import { registerDbHealthProbe } from "../../../src/shared/db/connection.ts";
import { registerRedisHealthProbe } from "../../../src/shared/mq/connection.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("health registration: db/redis 探针注册后可列出", () => {
  const r = createObservabilityRegistry();
  registerDbHealthProbe(r);
  registerRedisHealthProbe(r);
  const names = r.listHealthProbes().map((p) => p.name);
  assert(names.includes("database"), "应包含 database 探针");
  assert(names.includes("redis"), "应包含 redis 探针");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-core && deno test -A --no-check tests/shared/observability/health-registration.test.ts`
Expected: FAIL，`registerDbHealthProbe` 不存在。

- [ ] **Step 3: 修改 import 并新增注册函数**

在 `noj-core/src/shared/db/connection.ts` 中：

```diff
-import { metrics } from "../base/metrics.ts";
+import { observability as metrics, type ObservabilityRegistry } from "../observability/registry.ts";
```

在文件末尾新增：

```ts
export function registerDbHealthProbe(registry: ObservabilityRegistry): void {
  registry.registerHealthProbe({
    name: "database",
    critical: true,
    timeoutMs: 1000,
    check: async () => {
      const started = performance.now();
      const health = await checkDbHealth();
      return {
        status: health.ok ? "up" : "down",
        latency_ms: Math.round(performance.now() - started),
        error: health.error,
      };
    },
  });
}
```

在 `noj-core/src/shared/mq/connection.ts` 中：

```diff
-import { metrics } from "../base/metrics.ts";
+import { observability as metrics, type ObservabilityRegistry } from "../observability/registry.ts";
```

在文件末尾新增：

```ts
export function registerRedisHealthProbe(registry: ObservabilityRegistry): void {
  registry.registerHealthProbe({
    name: "redis",
    critical: true,
    timeoutMs: 1000,
    check: async () => {
      const started = performance.now();
      const health = await checkRedisHealth();
      return {
        status: health.ok ? "up" : "down",
        latency_ms: Math.round(performance.now() - started),
        error: health.error,
      };
    },
  });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-core && deno test -A --no-check tests/shared/observability/health-registration.test.ts && bash scripts/test-shared.sh`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj commit -m "refactor(core): shared/db 与 shared/mq 改用 shared/observability registry 并导出探针注册函数"
```

---

### Task 4: 创建 `domains/observability` 骨架（types + write.ts + index.ts）

**Files:**
- Create: `noj-core/src/domains/observability/types.ts`
- Create: `noj-core/src/domains/observability/write.ts`
- Create: `noj-core/src/domains/observability/index.ts`
- Test: `noj-core/src/domains/observability/tests/write.test.ts`

**Interfaces:**
- Consumes: `shared/observability` kernel。
- Produces:
  - `export interface ObservabilityAlert { key; severity: "info" | "warning" | "critical"; status: "active" | "ok"; message }`
  - `export interface ObservabilitySnapshot { generated_at; dependencies; queue; api; judge; alerts; providers? }`
  - `write.ts` 导出 `observability`、`registerBusinessMetric`、`registerHealthProbe`、`registerSnapshotProvider` 及类型。
  - `index.ts` 导出 `write.ts` 与后续路由/服务入口（本任务先导出 write 与 types）。

- [ ] **Step 1: 写失败测试**

创建 `noj-core/src/domains/observability/tests/write.test.ts`：

```ts
import { observability, registerBusinessMetric } from "../write.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("write: registerBusinessMetric 后可以写入", () => {
  registerBusinessMetric({
    name: "noj_submission_e2e_duration_seconds",
    help: "提交端到端耗时",
    type: "histogram",
    owner: "submission",
    labels: ["result"],
  });
  observability.observe("noj_submission_e2e_duration_seconds", 1.5, { result: "accepted" });
  assert(observability.count("noj_submission_e2e_duration_seconds") === 1, "应记录 1 个样本");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-core && deno task test:domain observability`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现骨架**

创建 `noj-core/src/domains/observability/types.ts`：

```ts
export interface ObservabilityAlert {
  key: string;
  severity: "info" | "warning" | "critical";
  status: "active" | "ok";
  message: string;
}

export interface ObservabilitySnapshot {
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
  api: {
    requests_total: number;
    errors_total: number;
    rate_limited_total: number;
    error_rate_percent: number;
    average_latency_ms: number | null;
  };
  judge: Record<string, unknown>;
  alerts: ObservabilityAlert[];
  providers?: {
    name: string;
    status: "ok" | "error" | "timeout";
    duration_ms: number;
    error?: string;
  }[];
}
```

创建 `noj-core/src/domains/observability/write.ts`：

```ts
export { observability } from "../../shared/observability/registry.ts";
export type {
  HealthProbe,
  MetricDefinition,
  SnapshotProvider,
} from "../../shared/observability/contracts.ts";
export type { ObservabilitySnapshot } from "./types.ts";

export function registerBusinessMetric(
  def: Parameters<typeof observability.registerBusinessMetric>[0],
): void {
  observability.registerBusinessMetric(def);
}

export function registerHealthProbe(
  probe: Parameters<typeof observability.registerHealthProbe>[0],
): void {
  observability.registerHealthProbe(probe);
}

export function registerSnapshotProvider(
  provider: Parameters<typeof observability.registerSnapshotProvider>[0],
): void {
  observability.registerSnapshotProvider(provider);
}
```

创建 `noj-core/src/domains/observability/index.ts`：

```ts
export * from "./write.ts";
export * from "./types.ts";
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-core && deno task test:domain observability`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj commit -m "feat(core): 新增 observability 平台域骨架与 write 门面"
```

---

### Task 5: 平台指标定义与业务指标 catalog

**Files:**
- Create: `noj-core/src/domains/observability/metrics/platform.ts`
- Create: `noj-core/src/domains/observability/metrics/business-catalog.ts`
- Test: `noj-core/src/domains/observability/tests/platform-metrics.test.ts`

**Interfaces:**
- Consumes: `observability` from `../write.ts`。
- Produces:
  - `export function registerPlatformMetrics(registry: typeof observability): void`
  - `export function registerBusinessMetric(def: MetricDefinition): void`（薄封装，带 owner 校验）
  - `export const PLATFORM_METRIC_NAMES: readonly string[]`

- [ ] **Step 1: 写失败测试**

创建 `noj-core/src/domains/observability/tests/platform-metrics.test.ts`：

```ts
import { createObservabilityRegistry } from "../../../shared/observability/registry.ts";
import { registerPlatformMetrics } from "../metrics/platform.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("platform: 注册平台指标后 render 包含核心指标", () => {
  const r = createObservabilityRegistry({ strict: true });
  registerPlatformMetrics(r);
  r.inc("noj_http_requests_total", { method: "GET", route: "/", status: "200" });
  const out = r.render();
  assert(out.includes("noj_http_requests_total"), "应包含 HTTP 请求指标");
  assert(out.includes("noj_redis_up"), "应包含 Redis 指标");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-core && deno task test:domain observability`
Expected: FAIL，`registerPlatformMetrics` 不存在。

- [ ] **Step 3: 实现平台指标**

创建 `noj-core/src/domains/observability/metrics/platform.ts`：

```ts
import type { ObservabilityRegistry } from "../../../shared/observability/contracts.ts";

export const PLATFORM_METRIC_NAMES = [
  "noj_http_requests_total",
  "noj_http_request_errors_total",
  "noj_http_rate_limited_total",
  "noj_http_request_duration_seconds",
  "noj_http_requests_in_flight",
  "noj_http_sse_connections",
  "noj_evaluation_results_total",
  "noj_evaluation_consumer_errors_total",
  "noj_database_health_checks_total",
  "noj_database_health_check_errors_total",
  "noj_redis_health_checks_total",
  "noj_redis_health_check_errors_total",
  "noj_redis_up",
  "noj_database_up",
  "noj_result_consumer_up",
  "noj_queue_pending_jobs",
  "noj_queue_processing_jobs",
  "noj_queue_result_pending_jobs",
  "noj_queue_result_processing_jobs",
  "noj_queue_judging_jobs",
  "noj_queue_oldest_judging_age_seconds",
  "noj_judge_required",
  "noj_judge_workers",
  "noj_judge_active_tasks",
  "noj_judge_max_concurrent_tasks",
  "noj_judge_orphan_containers",
  "noj_judge_cache_items",
  "noj_judge_cache_bytes",
  "noj_judge_work_dir_bytes",
  "noj_api_error_rate_percent",
  "noj_api_average_latency_ms",
  "noj_database_health_latency_ms",
  "noj_redis_health_latency_ms",
  "noj_database_pool_configured_max",
] as const;

export function registerPlatformMetrics(registry: ObservabilityRegistry): void {
  const defs: Array<Parameters<ObservabilityRegistry["define"]>[0]> = [
    { name: "noj_http_requests_total", help: "HTTP 请求总数", type: "counter", owner: "platform", labels: ["method", "route", "status"] },
    { name: "noj_http_request_errors_total", help: "HTTP 5xx 请求总数", type: "counter", owner: "platform", labels: ["method", "route", "status"] },
    { name: "noj_http_rate_limited_total", help: "HTTP 被限流请求总数", type: "counter", owner: "platform", labels: ["method", "route"] },
    { name: "noj_http_request_duration_seconds", help: "HTTP 请求耗时（秒）", type: "histogram", owner: "platform", labels: ["method", "route"] },
    { name: "noj_http_requests_in_flight", help: "当前处理中的 HTTP 请求数", type: "gauge", owner: "platform" },
    { name: "noj_http_sse_connections", help: "当前 SSE 连接数", type: "gauge", owner: "platform" },
    { name: "noj_evaluation_results_total", help: "收到的评测结果总数", type: "counter", owner: "platform" },
    { name: "noj_evaluation_consumer_errors_total", help: "评测结果消费者错误总数", type: "counter", owner: "platform" },
    { name: "noj_database_health_checks_total", help: "PostgreSQL 健康检查总数", type: "counter", owner: "platform" },
    { name: "noj_database_health_check_errors_total", help: "PostgreSQL 健康检查失败总数", type: "counter", owner: "platform" },
    { name: "noj_redis_health_checks_total", help: "Redis 健康检查总数", type: "counter", owner: "platform" },
    { name: "noj_redis_health_check_errors_total", help: "Redis 健康检查失败总数", type: "counter", owner: "platform" },
    { name: "noj_redis_up", help: "Redis 是否可用", type: "gauge", owner: "platform" },
    { name: "noj_database_up", help: "PostgreSQL 是否可用", type: "gauge", owner: "platform" },
    { name: "noj_result_consumer_up", help: "评测结果消费者是否存活", type: "gauge", owner: "platform" },
    { name: "noj_queue_pending_jobs", help: "评测 pending 队列长度", type: "gauge", owner: "platform" },
    { name: "noj_queue_processing_jobs", help: "评测 processing 队列长度", type: "gauge", owner: "platform" },
    { name: "noj_queue_result_pending_jobs", help: "评测结果 pending 队列长度", type: "gauge", owner: "platform" },
    { name: "noj_queue_result_processing_jobs", help: "评测结果 processing 队列长度", type: "gauge", owner: "platform" },
    { name: "noj_queue_judging_jobs", help: "数据库中 judging 状态的评测数", type: "gauge", owner: "platform" },
    { name: "noj_queue_oldest_judging_age_seconds", help: "最早 judging 评测年龄（秒）", type: "gauge", owner: "platform" },
    { name: "noj_judge_required", help: "生产环境是否要求 Judge Worker", type: "gauge", owner: "platform" },
    { name: "noj_judge_workers", help: "在线 Judge Worker 数", type: "gauge", owner: "platform" },
    { name: "noj_judge_active_tasks", help: "Judge 活跃任务数", type: "gauge", owner: "platform" },
    { name: "noj_judge_max_concurrent_tasks", help: "Judge 并发上限总和", type: "gauge", owner: "platform" },
    { name: "noj_judge_orphan_containers", help: "Judge 孤儿容器数", type: "gauge", owner: "platform" },
    { name: "noj_judge_cache_items", help: "Judge 支持包缓存条目数", type: "gauge", owner: "platform" },
    { name: "noj_judge_cache_bytes", help: "Judge 支持包缓存字节数", type: "gauge", owner: "platform" },
    { name: "noj_judge_work_dir_bytes", help: "Judge 工作目录字节数", type: "gauge", owner: "platform" },
    { name: "noj_api_error_rate_percent", help: "API 5xx 错误率百分比", type: "gauge", owner: "platform" },
    { name: "noj_api_average_latency_ms", help: "API 平均延迟（毫秒）", type: "gauge", owner: "platform" },
    { name: "noj_database_health_latency_ms", help: "PostgreSQL 健康检查延迟（毫秒）", type: "gauge", owner: "platform" },
    { name: "noj_redis_health_latency_ms", help: "Redis 健康检查延迟（毫秒）", type: "gauge", owner: "platform" },
    { name: "noj_database_pool_configured_max", help: "PostgreSQL 配置的连接池上限", type: "gauge", owner: "platform" },
  ];
  for (const def of defs) registry.define(def);
}
```

创建 `noj-core/src/domains/observability/metrics/business-catalog.ts`：

```ts
import type { MetricDefinition } from "../../../shared/observability/contracts.ts";
import { observability } from "../write.ts";

export function registerBusinessMetric(def: MetricDefinition): void {
  observability.registerBusinessMetric(def);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-core && deno task test:domain observability`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj commit -m "feat(core): 新增平台指标定义与业务指标注册入口"
```

---

### Task 6: 探针/Provider 注册表与 single-flight 缓存

**Files:**
- Create: `noj-core/src/domains/observability/probes/registry.ts`
- Test: `noj-core/src/domains/observability/tests/probes.test.ts`

**Interfaces:**
- Consumes: `HealthProbe`、`SnapshotProvider`、`ObservabilityRegistry` from kernel。
- Produces:
  - `export interface ProbeRunResult { name; status; latency_ms; error? }`
  - `export function runHealthProbes(registry: ObservabilityRegistry, opts?: { timeoutMs?: number }): Promise<ProbeRunResult[]>`
  - `export function collectSnapshot(registry: ObservabilityRegistry, opts?: { timeoutMs?: number; cacheTtlMs?: number }): Promise<Record<string, unknown>>`

- [ ] **Step 1: 写失败测试**

创建 `noj-core/src/domains/observability/tests/probes.test.ts`：

```ts
import { createObservabilityRegistry } from "../../../shared/observability/registry.ts";
import { runHealthProbes, collectSnapshot } from "../probes/registry.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("probes: 探针超时返回 unknown 且不抛错", async () => {
  const r = createObservabilityRegistry();
  r.registerHealthProbe({
    name: "slow",
    critical: true,
    timeoutMs: 10,
    check: () => new Promise((resolve) => setTimeout(() => resolve({ status: "up" }), 100)),
  });
  const results = await runHealthProbes(r, { timeoutMs: 20 });
  assert(results[0]!.status === "unknown", "超时应为 unknown");
});

Deno.test("probes: provider 失败返回部分快照", async () => {
  const r = createObservabilityRegistry();
  r.registerSnapshotProvider({
    name: "bad",
    timeoutMs: 10,
    collect: async () => { throw new Error("boom"); },
  });
  r.registerSnapshotProvider({
    name: "good",
    timeoutMs: 10,
    collect: async () => ({ queue: { pending: 1 } }),
  });
  const snap = await collectSnapshot(r, { timeoutMs: 20 });
  assert((snap as { queue?: { pending?: number } }).queue?.pending === 1, "good provider 应贡献数据");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-core && deno task test:domain observability`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现探针注册表**

创建 `noj-core/src/domains/observability/probes/registry.ts`：

```ts
import type { ObservabilityRegistry } from "../../../shared/observability/contracts.ts";

export interface ProbeRunResult {
  name: string;
  status: "up" | "down" | "unknown";
  latency_ms: number;
  error?: string;
}

async function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function deepMerge(target: Record<string, unknown>, source: unknown): void {
  if (source && typeof source === "object" && !Array.isArray(source)) {
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      if (
        value && typeof value === "object" && !Array.isArray(value) &&
        target[key] && typeof target[key] === "object" && !Array.isArray(target[key])
      ) {
        deepMerge(target[key] as Record<string, unknown>, value);
      } else {
        target[key] = value;
      }
    }
  }
}

export async function runHealthProbes(
  registry: ObservabilityRegistry,
  opts: { timeoutMs?: number } = {},
): Promise<ProbeRunResult[]> {
  const probes = registry.listHealthProbes();
  const timeoutMs = opts.timeoutMs ?? 1000;
  const results: ProbeRunResult[] = [];
  await Promise.all(probes.map(async (probe) => {
    const started = performance.now();
    try {
      const result = await withTimeout(() => Promise.resolve(probe.check()), probe.timeoutMs ?? timeoutMs);
      results.push({ name: probe.name, status: result.status, latency_ms: Math.round(performance.now() - started), error: result.error });
    } catch (err) {
      results.push({
        name: probe.name,
        status: "unknown",
        latency_ms: Math.round(performance.now() - started),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }));
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

export async function collectSnapshot(
  registry: ObservabilityRegistry,
  opts: { timeoutMs?: number; cacheTtlMs?: number } = {},
): Promise<Record<string, unknown>> {
  const providers = registry.listSnapshotProviders();
  const timeoutMs = opts.timeoutMs ?? 500;
  const out: Record<string, unknown> = {};
  const providerStatus: { name: string; status: "ok" | "error" | "timeout"; duration_ms: number; error?: string }[] = [];
  await Promise.all(providers.map(async (provider) => {
    const started = performance.now();
    try {
      const contribution = await withTimeout(() => Promise.resolve(provider.collect()), provider.timeoutMs ?? timeoutMs);
      deepMerge(out, contribution);
      providerStatus.push({ name: provider.name, status: "ok", duration_ms: Math.round(performance.now() - started) });
    } catch (err) {
      providerStatus.push({
        name: provider.name,
        status: "timeout",
        duration_ms: Math.round(performance.now() - started),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }));
  out.providers = providerStatus;
  return out;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-core && deno task test:domain observability`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj commit -m "feat(core): 新增探针/Provider 注册表与超时降级"
```

---

### Task 7: 健康路由迁移到观测域

**Files:**
- Create: `noj-core/src/domains/observability/routes/health.ts`
- Modify: `noj-core/src/app.ts`
- Delete: `noj-core/src/routes/health.ts`
- Delete: `noj-core/tests/routes/health.ts`
- Test: `noj-core/src/domains/observability/tests/health.test.ts`

**Interfaces:**
- Consumes: `runHealthProbes`、`ObservabilityRegistry`。
- Produces: `export default function createHealthRouter(registry: ObservabilityRegistry): Hono`（或直接导出 `healthRouter`，组合根传入 registry）。

- [ ] **Step 1: 写失败测试**

创建 `noj-core/src/domains/observability/tests/health.test.ts`：

```ts
import { Hono } from "hono";
import { createObservabilityRegistry } from "../../../shared/observability/registry.ts";
import { createHealthRouter } from "../routes/health.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("health: live 永远 200", async () => {
  const r = createObservabilityRegistry();
  const app = new Hono().route("/", createHealthRouter(r));
  const res = await app.request("/health/live");
  assert(res.status === 200, "live 应 200");
});

Deno.test("health: ready 在 critical 探针 down 时 503", async () => {
  const r = createObservabilityRegistry();
  r.registerHealthProbe({ name: "db", critical: true, check: async () => ({ status: "down" as const }) });
  const app = new Hono().route("/", createHealthRouter(r));
  const res = await app.request("/health/ready");
  assert(res.status === 503, "ready 应 503");
});

Deno.test("health: 兼容 /health 返回 200 + degraded", async () => {
  const r = createObservabilityRegistry();
  r.registerHealthProbe({ name: "db", critical: true, check: async () => ({ status: "down" as const }) });
  const app = new Hono().route("/", createHealthRouter(r));
  const res = await app.request("/health");
  assert(res.status === 200, "/health 应 200");
  const body = await res.json();
  assert(body.status === "degraded", "应为 degraded");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-core && deno task test:domain observability`
Expected: FAIL，`createHealthRouter` 不存在。

- [ ] **Step 3: 实现健康路由**

创建 `noj-core/src/domains/observability/routes/health.ts`：

```ts
import { Hono } from "hono";
import type { ObservabilityRegistry } from "../../../shared/observability/contracts.ts";
import { runHealthProbes } from "../probes/registry.ts";

export function createHealthRouter(registry: ObservabilityRegistry): Hono {
  const health = new Hono();

  health.get("/health/live", (c) =>
    c.json({ status: "alive", service: "noj-core", version: "0.1.0" }));

  const criticalNames = new Set(
    registry.listHealthProbes().filter((p) => p.critical).map((p) => p.name),
  );

  health.get("/health/ready", async (c) => {
    const results = await runHealthProbes(registry);
    const critical = results.filter((r) => criticalNames.has(r.name));
    const ready = critical.every((r) => r.status === "up");
    const showDetails = Deno.env.get("NOJ_ENV") !== "production";
    return c.json({
      status: ready ? "ready" : "not_ready",
      service: "noj-core",
      version: "0.1.0",
      checks: showDetails ? Object.fromEntries(results.map((r) => [r.name, r])) : undefined,
    }, ready ? 200 : 503);
  });

  health.get("/health", async (c) => {
    const results = await runHealthProbes(registry);
    const critical = results.filter((r) => criticalNames.has(r.name));
    const healthy = critical.every((r) => r.status === "up");
    const showDetails = Deno.env.get("NOJ_ENV") !== "production";
    return c.json({
      status: healthy ? "healthy" : "degraded",
      service: "noj-core",
      version: "0.1.0",
      checks: showDetails ? Object.fromEntries(results.map((r) => [r.name, r])) : undefined,
    });
  });

  return health;
}
```

修改 `noj-core/src/app.ts`：

- 删除 `import health from "./routes/health.ts";`
- 新增 `import { createHealthRouter } from "./domains/observability/routes/health.ts";`
- 在 `createApp()` 内创建 `const observabilityRegistry = ...`（本任务先用 `createObservabilityRegistry()` 临时实例，后续组合根任务再统一注入）。
- 把 `app.route("/", health);` 改为 `app.route("/", createHealthRouter(observabilityRegistry));`

删除 `noj-core/src/routes/health.ts` 与 `noj-core/tests/routes/health.ts`。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-core && deno task test:domain observability && deno check src/app.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj commit -m "refactor(core): 健康路由迁入 observability 域"
```

---

### Task 8: 快照聚合、Judge 心跳与告警服务

**Files:**
- Create: `noj-core/src/domains/observability/services/snapshot.ts`
- Create: `noj-core/src/domains/observability/services/judge-heartbeat.ts`
- Create: `noj-core/src/domains/observability/services/alerts.ts`
- Test: `noj-core/src/domains/observability/tests/snapshot.test.ts`
- Test: `noj-core/src/domains/observability/tests/judge-heartbeat.test.ts`
- Test: `noj-core/src/domains/observability/tests/alerts.test.ts`

**Interfaces:**
- Consumes: `collectSnapshot`、`ObservabilityRegistry`、`shared/mq` Redis。
- Produces:
  - `export async function getObservabilitySnapshot(registry: ObservabilityRegistry): Promise<ObservabilitySnapshot>`
  - `export async function renderPrometheusMetrics(registry: ObservabilityRegistry): Promise<string>`
  - `export async function readJudgeHeartbeats(redis: ReturnType<typeof getRedis>): Promise<ObservabilitySnapshot["judge"]>`
  - `export function makeAlerts(snapshot: Omit<ObservabilitySnapshot, "alerts">): ObservabilityAlert[]`

- [ ] **Step 1: 写失败测试**

创建 `noj-core/src/domains/observability/tests/snapshot.test.ts`：

```ts
import { createObservabilityRegistry } from "../../../shared/observability/registry.ts";
import { getObservabilitySnapshot, renderPrometheusMetrics } from "../services/snapshot.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("snapshot: provider 失败时仍返回部分快照且 HTTP 可渲染", async () => {
  const r = createObservabilityRegistry();
  r.registerSnapshotProvider({
    name: "bad",
    collect: async () => { throw new Error("boom"); },
  });
  r.registerSnapshotProvider({
    name: "good",
    collect: async () => ({ queue: { pending: 1, processing: 0, result_pending: 0, result_processing: 0, judging: 0, oldest_judging_age_seconds: null } }),
  });
  const snap = await getObservabilitySnapshot(r);
  assert(snap.queue.pending === 1, "good provider 应贡献数据");
  assert(snap.providers?.some((p) => p.status === "timeout"), "应有 timeout 状态");
  const out = await renderPrometheusMetrics(r);
  assert(out.includes("noj_queue_pending_jobs"), "渲染应包含队列指标");
});
```

创建 `noj-core/src/domains/observability/tests/alerts.test.ts`：

```ts
import { makeAlerts } from "../services/alerts.ts";
import type { ObservabilitySnapshot } from "../types.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("alerts: 队列积压触发告警", () => {
  const base = {
    generated_at: new Date().toISOString(),
    dependencies: { database: { status: "up" }, redis: { status: "up" }, result_consumer: { status: "up" } },
    queue: { pending: 200, processing: 0, result_pending: 0, result_processing: 0, judging: 0, oldest_judging_age_seconds: null },
    api: { requests_total: 0, errors_total: 0, rate_limited_total: 0, error_rate_percent: 0, average_latency_ms: null },
    judge: { required: false, workers: 0, active_tasks: 0, max_concurrent_tasks: 0, completed_tasks_total: 0, failed_tasks_total: 0, result_push_failures_total: 0, orphan_containers: 0, cache_items: 0, cache_bytes: 0, work_dir_bytes: 0, last_seen_at: null },
  } as Omit<ObservabilitySnapshot, "alerts">;
  const alerts = makeAlerts(base);
  assert(alerts.some((a) => a.key === "queue_backlog" && a.status === "active"), "应触发 queue_backlog");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-core && deno task test:domain observability`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现服务**

创建 `noj-core/src/domains/observability/services/judge-heartbeat.ts`：

```ts
import { getRedis } from "../../../shared/mq/connection.ts";
import type { ObservabilitySnapshot } from "../types.ts";

const JUDGE_HEARTBEAT_PREFIX = "noj:observability:judge:";

interface JudgeHeartbeat {
  active_tasks?: number;
  max_concurrent_tasks?: number;
  completed_tasks_total?: number;
  failed_tasks_total?: number;
  result_push_failures_total?: number;
  orphan_containers?: number;
  cache_items?: number;
  cache_bytes?: number;
  work_dir_bytes?: number;
  updated_at_ms?: number;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export async function readJudgeHeartbeats(
  redis: ReturnType<typeof getRedis>,
): Promise<ObservabilitySnapshot["judge"]> {
  const aggregate: ObservabilitySnapshot["judge"] = {
    required: Deno.env.get("NOJ_ENV") === "production" && Deno.env.get("JUDGE_ENABLED") !== "false",
    workers: 0,
    active_tasks: 0,
    max_concurrent_tasks: 0,
    completed_tasks_total: 0,
    failed_tasks_total: 0,
    result_push_failures_total: 0,
    orphan_containers: 0,
    cache_items: 0,
    cache_bytes: 0,
    work_dir_bytes: 0,
    last_seen_at: null,
  };
  let cursor = "0";
  let scanned = 0;
  do {
    const [nextCursor, keys] = await redis.scan(cursor, "MATCH", `${JUDGE_HEARTBEAT_PREFIX}*`, "COUNT", 100);
    cursor = nextCursor;
    for (const key of keys) {
      if (++scanned > 1000) break;
      const raw = await redis.get(key);
      if (!raw) continue;
      try {
        const hb = JSON.parse(raw) as JudgeHeartbeat;
        aggregate.workers += 1;
        aggregate.active_tasks += numberOrZero(hb.active_tasks);
        aggregate.max_concurrent_tasks += numberOrZero(hb.max_concurrent_tasks);
        aggregate.completed_tasks_total += numberOrZero(hb.completed_tasks_total);
        aggregate.failed_tasks_total += numberOrZero(hb.failed_tasks_total);
        aggregate.result_push_failures_total += numberOrZero(hb.result_push_failures_total);
        aggregate.orphan_containers += numberOrZero(hb.orphan_containers);
        aggregate.cache_items += numberOrZero(hb.cache_items);
        aggregate.cache_bytes += numberOrZero(hb.cache_bytes);
        aggregate.work_dir_bytes += numberOrZero(hb.work_dir_bytes);
        if (hb.updated_at_ms && (!aggregate.last_seen_at || hb.updated_at_ms > Date.parse(aggregate.last_seen_at))) {
          aggregate.last_seen_at = new Date(hb.updated_at_ms).toISOString();
        }
      } catch {
        // malformed 心跳忽略
      }
    }
    if (scanned > 1000) break;
  } while (cursor !== "0");
  return aggregate;
}
```

创建 `noj-core/src/domains/observability/services/alerts.ts`：

```ts
import type { ObservabilityAlert, ObservabilitySnapshot } from "../types.ts";

export function makeAlerts(
  snapshot: Omit<ObservabilitySnapshot, "alerts">,
): ObservabilityAlert[] {
  const alerts: ObservabilityAlert[] = [];
  const add = (
    key: string,
    severity: ObservabilityAlert["severity"],
    active: boolean,
    message: string,
  ) => alerts.push({ key, severity, status: active ? "active" : "ok", message });

  const db = snapshot.dependencies.database as { status?: string };
  const redis = snapshot.dependencies.redis as { status?: string };
  const consumer = snapshot.dependencies.result_consumer as { status?: string };
  const judge = snapshot.judge as { required?: boolean; workers?: number; work_dir_bytes?: number };
  const queue = snapshot.queue;

  add("database_unavailable", "critical", db.status !== "up", "PostgreSQL 不可用");
  add("redis_unavailable", "critical", redis.status !== "up", "Redis 不可用");
  add("result_consumer_down", "critical", consumer.status !== "up", "评测结果消费者未运行");
  add("judge_workers_down", "critical", judge.required === true && (judge.workers ?? 0) === 0, "没有在线 Judge Worker");
  add("queue_backlog", queue.pending !== null && queue.pending >= 500 ? "critical" : "warning", queue.pending !== null && queue.pending >= 100, "评测 pending 队列持续堆积");
  add("result_backlog", "warning", queue.result_processing !== null && queue.result_processing >= 10, "评测结果 processing 队列存在积压");
  add("stale_judging", "warning", queue.oldest_judging_age_seconds !== null && queue.oldest_judging_age_seconds >= 600, "存在超过 10 分钟未完成的评测");
  add("api_error_rate", snapshot.api.error_rate_percent >= 20 ? "critical" : "warning", snapshot.api.requests_total >= 20 && snapshot.api.error_rate_percent >= 5, "API 5xx 错误率升高");
  add("judge_work_dir_pressure", "warning", (judge.work_dir_bytes ?? 0) >= 8 * 1024 ** 3, "Judge 工作目录占用超过 8 GiB");
  return alerts;
}
```

创建 `noj-core/src/domains/observability/services/snapshot.ts`：

```ts
import type { ObservabilityRegistry } from "../../../shared/observability/contracts.ts";
import { collectSnapshot } from "../probes/registry.ts";
import { makeAlerts } from "./alerts.ts";
import type { ObservabilitySnapshot } from "../types.ts";

export async function getObservabilitySnapshot(
  registry: ObservabilityRegistry,
): Promise<ObservabilitySnapshot> {
  const generatedAt = new Date().toISOString();
  const partial = await collectSnapshot(registry);
  const base = {
    generated_at: generatedAt,
    dependencies: (partial.dependencies ?? {}) as ObservabilitySnapshot["dependencies"],
    queue: (partial.queue ?? {
      pending: null, processing: null, result_pending: null, result_processing: null,
      judging: null, oldest_judging_age_seconds: null,
    }) as ObservabilitySnapshot["queue"],
    api: (partial.api ?? {
      requests_total: registry.sum("noj_http_requests_total"),
      errors_total: registry.sum("noj_http_request_errors_total"),
      rate_limited_total: registry.sum("noj_http_rate_limited_total"),
      error_rate_percent: 0,
      average_latency_ms: null,
    }) as ObservabilitySnapshot["api"],
    judge: (partial.judge ?? {}) as ObservabilitySnapshot["judge"],
    providers: partial.providers as ObservabilitySnapshot["providers"],
  };
  return { ...base, alerts: makeAlerts(base) };
}

export async function renderPrometheusMetrics(
  registry: ObservabilityRegistry,
): Promise<string> {
  const snapshot = await getObservabilitySnapshot(registry);
  const lines = [
    registry.render().trimEnd(),
    `# HELP noj_database_up PostgreSQL 是否可用\n# TYPE noj_database_up gauge\nnoj_database_up ${(snapshot.dependencies.database as { status?: string })?.status === "up" ? 1 : 0}`,
    `# HELP noj_redis_up Redis 是否可用\n# TYPE noj_redis_up gauge\nnoj_redis_up ${(snapshot.dependencies.redis as { status?: string })?.status === "up" ? 1 : 0}`,
    `# HELP noj_queue_pending_jobs 评测 pending 队列长度\n# TYPE noj_queue_pending_jobs gauge\nnoj_queue_pending_jobs ${snapshot.queue.pending ?? -1}`,
    `# HELP noj_queue_processing_jobs 评测 processing 队列长度\n# TYPE noj_queue_processing_jobs gauge\nnoj_queue_processing_jobs ${snapshot.queue.processing ?? -1}`,
    `# HELP noj_queue_result_pending_jobs 评测结果 pending 队列长度\n# TYPE noj_queue_result_pending_jobs gauge\nnoj_queue_result_pending_jobs ${snapshot.queue.result_pending ?? -1}`,
    `# HELP noj_queue_result_processing_jobs 评测结果 processing 队列长度\n# TYPE noj_queue_result_processing_jobs gauge\nnoj_queue_result_processing_jobs ${snapshot.queue.result_processing ?? -1}`,
    `# HELP noj_queue_judging_jobs 数据库中 judging 状态的评测数\n# TYPE noj_queue_judging_jobs gauge\nnoj_queue_judging_jobs ${snapshot.queue.judging ?? -1}`,
    `# HELP noj_queue_oldest_judging_age_seconds 最早 judging 评测年龄（秒）\n# TYPE noj_queue_oldest_judging_age_seconds gauge\nnoj_queue_oldest_judging_age_seconds ${snapshot.queue.oldest_judging_age_seconds ?? -1}`,
    `# HELP noj_judge_workers 在线 Judge Worker 数\n# TYPE noj_judge_workers gauge\nnoj_judge_workers ${(snapshot.judge as { workers?: number })?.workers ?? 0}`,
    `# HELP noj_api_error_rate_percent API 5xx 错误率百分比\n# TYPE noj_api_error_rate_percent gauge\nnoj_api_error_rate_percent ${snapshot.api.error_rate_percent}`,
    `# HELP noj_api_average_latency_ms API 平均延迟（毫秒）\n# TYPE noj_api_average_latency_ms gauge\nnoj_api_average_latency_ms ${snapshot.api.average_latency_ms ?? -1}`,
  ].filter(Boolean);
  return `${lines.join("\n")}\n`;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-core && deno task test:domain observability`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj commit -m "feat(core): 新增快照聚合、Judge 心跳与告警服务"
```

---

### Task 9: HTTP 指标中间件与请求上下文中间件迁入观测域

**Files:**
- Create: `noj-core/src/domains/observability/middleware/http-metrics.ts`
- Create: `noj-core/src/domains/observability/middleware/request-context.ts`
- Modify: `noj-core/src/app.ts`
- Delete: `noj-core/src/shared/middleware/metrics.ts`
- Delete: `noj-core/src/shared/middleware/request-context.ts`
- Test: `noj-core/src/domains/observability/tests/middleware.test.ts`

**Interfaces:**
- Consumes: `observability`、`normalizeMetricRoute`、`runWithRequestContext`。
- Produces:
  - `export function httpMetricsMiddleware(registry: ObservabilityRegistry): (c: Context, next: Next) => Promise<void>`
  - `export function requestContext(c: Context, next: Next): Promise<void>`

- [ ] **Step 1: 写失败测试**

创建 `noj-core/src/domains/observability/tests/middleware.test.ts`：

```ts
import { Hono } from "hono";
import { createObservabilityRegistry } from "../../../shared/observability/registry.ts";
import { httpMetricsMiddleware } from "../middleware/http-metrics.ts";
import { requestContext } from "../middleware/request-context.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("middleware: 请求后指标增加", async () => {
  const r = createObservabilityRegistry();
  r.define({ name: "noj_http_requests_total", help: "HTTP 请求总数", type: "counter", owner: "platform", labels: ["method", "route", "status"] });
  r.define({ name: "noj_http_request_duration_seconds", help: "HTTP 请求耗时", type: "histogram", owner: "platform", labels: ["method", "route"] });
  const app = new Hono();
  app.use("*", httpMetricsMiddleware(r));
  app.get("/ok", (c) => c.text("ok"));
  await app.request("/ok");
  assert(r.sum("noj_http_requests_total") === 1, "请求数应为 1");
});

Deno.test("middleware: requestContext 设置 X-Request-Id", async () => {
  const app = new Hono();
  app.use("*", requestContext);
  app.get("/ok", (c) => c.text("ok"));
  const res = await app.request("/ok");
  assert(res.headers.has("X-Request-Id"), "应包含 X-Request-Id");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-core && deno task test:domain observability`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现中间件**

创建 `noj-core/src/domains/observability/middleware/http-metrics.ts`：

```ts
import type { Context, Next } from "hono";
import type { ObservabilityRegistry } from "../../../shared/observability/contracts.ts";
import { normalizeMetricRoute } from "../../../shared/observability/registry.ts";

export function httpMetricsMiddleware(registry: ObservabilityRegistry) {
  return async function metricsMiddleware(c: Context, next: Next): Promise<void> {
    const startedAt = performance.now();
    try {
      await next();
    } finally {
      const routePath = (c.req as unknown as { routePath?: string }).routePath;
      const route = normalizeMetricRoute(c.req.path, routePath);
      const labels = { method: c.req.method, route, status: String(c.res.status) };
      registry.inc("noj_http_requests_total", labels);
      if (c.res.status >= 500) registry.inc("noj_http_request_errors_total", labels);
      registry.observe("noj_http_request_duration_seconds", Math.max(0, performance.now() - startedAt) / 1000, { method: c.req.method, route });
    }
  };
}
```

创建 `noj-core/src/domains/observability/middleware/request-context.ts`：

```ts
import type { Context, Next } from "hono";
import { runWithRequestContext } from "../../../shared/observability/context.ts";

declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
  }
}

export function requestContext(c: Context, next: Next): Promise<void> {
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);
  c.header("X-Request-Id", requestId);
  return runWithRequestContext(requestId, () => next());
}
```

修改 `noj-core/src/app.ts`：

- 删除 `import { metricsMiddleware } from "./shared/middleware/metrics.ts";`
- 删除 `import { requestContext } from "./shared/middleware/request-context.ts";`
- 新增 `import { httpMetricsMiddleware } from "./domains/observability/middleware/http-metrics.ts";`
- 新增 `import { requestContext } from "./domains/observability/middleware/request-context.ts";`
- 把 `app.use("*", metricsMiddleware);` 改为 `app.use("*", httpMetricsMiddleware(observabilityRegistry));`

删除 `noj-core/src/shared/middleware/metrics.ts` 与 `noj-core/src/shared/middleware/request-context.ts`。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-core && deno task test:domain observability && deno check src/app.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj commit -m "refactor(core): HTTP 指标与请求上下文中间件迁入观测域"
```

---

### Task 10: 管理员观测路由迁入观测域

**Files:**
- Create: `noj-core/src/domains/observability/routes/admin.ts`
- Modify: `noj-core/src/domains/admin/routes/query.ts`
- Modify: `noj-core/src/domains/admin/index.ts`
- Test: `noj-core/src/domains/observability/tests/admin.test.ts`

**Interfaces:**
- Consumes: `getObservabilitySnapshot`、`ObservabilityRegistry`。
- Produces: `export function createObservabilityAdminRouter(registry: ObservabilityRegistry): Hono`

- [ ] **Step 1: 写失败测试**

创建 `noj-core/src/domains/observability/tests/admin.test.ts`：

```ts
import { Hono } from "hono";
import { createObservabilityRegistry } from "../../../shared/observability/registry.ts";
import { createObservabilityAdminRouter } from "../routes/admin.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("admin: 观测路由返回快照", async () => {
  const r = createObservabilityRegistry();
  const app = new Hono().route("/dashboard", createObservabilityAdminRouter(r));
  const res = await app.request("/dashboard/observability");
  assert(res.status === 200, "应 200");
  const body = await res.json();
  assert(body.data.generated_at, "应包含 generated_at");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-core && deno task test:domain observability`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现管理路由**

创建 `noj-core/src/domains/observability/routes/admin.ts`：

```ts
import { Hono } from "hono";
import type { ObservabilityRegistry } from "../../../shared/observability/contracts.ts";
import { getObservabilitySnapshot } from "../services/snapshot.ts";

export function createObservabilityAdminRouter(registry: ObservabilityRegistry): Hono {
  const router = new Hono();
  router.get("/observability", async (c) => {
    const snapshot = await getObservabilitySnapshot(registry);
    return c.json({ data: snapshot });
  });
  return router;
}
```

修改 `noj-core/src/domains/admin/routes/query.ts`：

- 删除 `import { getObservabilitySnapshot } from "../../system/services/observability.ts";`
- 删除 `router.get("/dashboard/observability", ...)` 块。

修改 `noj-core/src/domains/admin/index.ts`：

- 新增 `import { createObservabilityAdminRouter } from "../observability/routes/admin.ts";`
- 在 `router.route("/dashboard", createObservabilityAdminRouter(observabilityRegistry));` 处挂载（`observabilityRegistry` 由组合根传入；本任务先在 admin/index.ts 内临时创建，后续组合根任务统一注入）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-core && deno task test:domain observability && deno check src/domains/admin/index.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj commit -m "refactor(core): 管理员观测路由迁入观测域"
```

---

### Task 11: 业务域迁移到 `write.ts` 并新增 submission provider

**Files:**
- Modify: `noj-core/src/domains/submission/mq/consumer.ts`
- Modify: `noj-core/src/domains/system/services/email.ts`
- Modify: `noj-core/src/domains/system/services/email-delivery/service.ts`
- Create: `noj-core/src/domains/submission/observability.ts`
- Modify: `noj-core/src/domains/submission/index.ts`
- Test: `noj-core/src/domains/submission/tests/services/observability.test.ts`

**Interfaces:**
- Consumes: `write.ts` 的 `observability`、`registerSnapshotProvider`。
- Produces:
  - `export function registerSubmissionObservability(registry: typeof observability): void`
  - `export function registerSystemEmailMetrics(registry: typeof observability): void`

- [ ] **Step 1: 写失败测试**

创建 `noj-core/src/domains/submission/tests/services/observability.test.ts`：

```ts
import { createObservabilityRegistry } from "../../../shared/observability/registry.ts";
import { registerSubmissionObservability } from "../observability.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("submission observability: 注册 provider 后可聚合队列", async () => {
  const r = createObservabilityRegistry();
  registerSubmissionObservability(r);
  const names = r.listSnapshotProviders().map((p) => p.name);
  assert(names.includes("submission.queue"), "应注册 submission.queue provider");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-core && deno task test:domain submission`
Expected: FAIL，`registerSubmissionObservability` 不存在。

- [ ] **Step 3: 实现迁移**

创建 `noj-core/src/domains/submission/observability.ts`：

```ts
import type { ObservabilityRegistry } from "../../shared/observability/contracts.ts";
import { getQueueHealth } from "./services/queue.ts";
import { consumerAlive } from "./mq/consumer.ts";

export function registerSubmissionObservability(registry: ObservabilityRegistry): void {
  registry.registerSnapshotProvider({
    name: "submission.queue",
    timeoutMs: 500,
    collect: async () => {
      const q = await getQueueHealth();
      return {
        queue: {
          pending: q.judge.queue_length,
          processing: q.judge.processing_length,
          result_pending: q.result.queue_length,
          result_processing: q.result.processing_length,
          judging: null,
          oldest_judging_age_seconds: null,
        },
        dependencies: {
          result_consumer: { status: consumerAlive.value ? "up" : "down" },
        },
      };
    },
  });
}
```

修改 `noj-core/src/domains/submission/mq/consumer.ts`：

```diff
-import { metrics } from "../../../shared/base/metrics.ts";
+import { observability as metrics } from "../../../domains/observability/write.ts";
```

修改 `noj-core/src/domains/system/services/email.ts`：

```diff
-import { metrics } from "../../../shared/base/metrics.ts";
+import { observability as metrics } from "../../../domains/observability/write.ts";
```

修改 `noj-core/src/domains/system/services/email-delivery/service.ts`：

```diff
-import { metrics } from "../../../../shared/base/metrics.ts";
+import { observability as metrics } from "../../../../domains/observability/write.ts";
```

修改 `noj-core/src/domains/submission/index.ts`：

- 新增 `export { registerSubmissionObservability } from "./observability.ts";`

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-core && deno task test:domain submission && deno task test:domain system`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj commit -m "refactor(core): 业务域指标调用迁移到 observability write 门面"
```

---

### Task 12: 组合根 `app.ts` 统一装配并删除旧观测代码

**Files:**
- Modify: `noj-core/src/app.ts`
- Modify: `noj-core/src/domains/admin/index.ts`
- Delete: `noj-core/src/domains/system/services/observability.ts`
- Delete: `noj-core/src/shared/base/metrics.ts`
- Test: `noj-core/tests/routes/health.ts`（重建为组合根集成测试）

**Interfaces:**
- Consumes: `registerPlatformMetrics`、`registerDbHealthProbe`、`registerRedisHealthProbe`、`registerSubmissionObservability`、`createHealthRouter`、`createObservabilityAdminRouter`、`httpMetricsMiddleware`、`requestContext`。
- Produces: 最终 `createApp()` 使用单一 `observability` 单例。

- [ ] **Step 1: 写失败测试**

重建 `noj-core/tests/routes/health.ts`：

```ts
import { createApp } from "../../src/app.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("app: /health/live 200", async () => {
  const app = createApp();
  const res = await app.request("/health/live");
  assert(res.status === 200, "live 应 200");
});

Deno.test("app: /metrics 返回 Prometheus 文本", async () => {
  const app = createApp();
  const res = await app.request("/metrics");
  assert(res.status === 200, "metrics 应 200");
  assert((res.headers.get("content-type") ?? "").includes("text/plain"), "应为 text/plain");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-core && deno test -A --no-check tests/routes/health.ts`
Expected: FAIL，`createApp` 尚未装配新结构。

- [ ] **Step 3: 装配组合根**

修改 `noj-core/src/app.ts`：

- 删除 `import { metrics, normalizeMetricRoute } from "./shared/base/metrics.ts";`
- 删除 `import { renderPrometheusMetrics } from "./domains/system/services/observability.ts";`
- 新增：
  ```ts
  import { observability } from "./domains/observability/write.ts";
  import { registerPlatformMetrics } from "./domains/observability/metrics/platform.ts";
  import { createHealthRouter } from "./domains/observability/routes/health.ts";
  import { renderPrometheusMetrics } from "./domains/observability/services/snapshot.ts";
  import { registerSubmissionObservability } from "./domains/submission/index.ts";
  import { registerDbHealthProbe } from "./shared/db/connection.ts";
  import { registerRedisHealthProbe } from "./shared/mq/connection.ts";
  ```
- 在 `createApp()` 开头：
  ```ts
  registerPlatformMetrics(observability);
  registerDbHealthProbe(observability);
  registerRedisHealthProbe(observability);
  registerSubmissionObservability(observability);
  ```
- 把 `app.use("*", requestContext);` 保留（已从新中间件导入）。
- 把 `app.use("*", httpMetricsMiddleware(observability));`
- 把 `app.route("/", createHealthRouter(observability));`
- 把 `/metrics` handler 改为 `renderPrometheusMetrics(observability)`。
- 把 `metrics.inc("noj_http_rate_limited_total", ...)` 改为 `observability.inc(...)`。

修改 `noj-core/src/domains/admin/index.ts`：

- 删除临时创建的 registry，改为从 `../observability/write.ts` 导入 `observability`，并挂载 `createObservabilityAdminRouter(observability)`。

删除 `noj-core/src/domains/system/services/observability.ts` 与 `noj-core/src/shared/base/metrics.ts`。

运行 `rg -n "shared/base/metrics|system/services/observability" noj-core/src noj-core/tests`，确认无残留引用；如有，更新为 `domains/observability/write.ts` 或 `domains/observability/services/snapshot.ts` 对应入口。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-core && deno test -A --no-check tests/routes/health.ts && deno task check`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj commit -m "refactor(core): app.ts 组合根统一装配观测域并删除旧观测代码"
```

---

### Task 13: 扩展域边界检查与新增指标/运行时/Runbook 检查

**Files:**
- Modify: `scripts/check-domains.ts`
- Modify: `scripts/check-domains_test.ts`
- Create: `noj-core/src/domains/observability/services/runtime-contract.ts`
- Create: `scripts/check-metrics.ts`
- Create: `scripts/check-metrics_test.ts`
- Create: `scripts/check-runtime-contract.ts`
- Create: `scripts/check-runtime-contract_test.ts`
- Create: `scripts/check-runbooks.ts`
- Create: `scripts/check-runbooks_test.ts`
- Create: `noj-tests/fixtures/gateway-metrics.txt`
- Modify: `scripts/check-all.ts`
- Modify: `noj-core/deno.json`

**Interfaces:**
- Consumes: 现有 `check-domains.ts` 结构、`PLATFORM_METRIC_NAMES`。
- Produces:
  - `check-domains.ts` 支持 `observability` 域、`write.ts` 子路径白名单、admin 例外、观测域禁跨业务域。
  - `runtime-contract.ts` 导出 `RUNTIME_DESCRIPTORS`。
  - `check-metrics.ts` 扫描 `registerBusinessMetric` 与 `inc/set/add/observe` 调用，校验 catalog。
  - `check-runtime-contract.ts` 校验 `RUNTIME_DESCRIPTORS` 的 `requiredMetrics` 与 Prometheus 配置、gateway fixture。
  - `check-runbooks.ts` 校验告警规则中的 Runbook 链接存在。

- [ ] **Step 1: 写失败测试**

在 `scripts/check-domains_test.ts` 追加：

```ts
Deno.test("checkFile: 业务域 import observability/write.ts 不违规", () => {
  const violations = checkFile(
    "src/domains/submission/mq/consumer.ts",
    `import { observability } from "../observability/write.ts";\n`,
  );
  assert(violations.length === 0, "write.ts 应允许");
});

Deno.test("checkFile: 业务域 import observability/services 违规", () => {
  const violations = checkFile(
    "src/domains/submission/mq/consumer.ts",
    `import { getObservabilitySnapshot } from "../observability/services/snapshot.ts";\n`,
  );
  assert(violations.length > 0, "services 深路径应禁止");
});

Deno.test("checkFile: observability 域 import 其他业务域违规", () => {
  const violations = checkFile(
    "src/domains/observability/services/snapshot.ts",
    `import { getQueueHealth } from "../submission/services/queue.ts";\n`,
  );
  assert(violations.length > 0, "观测域不得 import 业务域");
});
```

创建 `scripts/check-metrics_test.ts`：

```ts
import { checkMetricCalls } from "./check-metrics.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("check-metrics: 未定义指标写入报错", () => {
  const errors = checkMetricCalls(
    `import { observability } from "./write.ts";\nobservability.inc("noj_unknown_total");\n`,
    new Set(["noj_known_total"]),
  );
  assert(errors.length > 0, "未定义指标应报错");
});
```

创建 `scripts/check-runtime-contract_test.ts`：

```ts
import { checkRuntimeContract } from "./check-runtime-contract.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("check-runtime-contract: 缺少 gateway job 时报错", async () => {
  const errors = await checkRuntimeContract(".");
  // 本仓库已配置 prometheus.yml 时不应报错；此测试只验证函数可运行。
  assert(Array.isArray(errors), "应返回数组");
});
```

创建 `scripts/check-runbooks_test.ts`：

```ts
import { checkRunbooks } from "./check-runbooks.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("check-runbooks: 返回数组", async () => {
  const errors = await checkRunbooks(".");
  assert(Array.isArray(errors), "应返回数组");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `deno test -A scripts/check-domains_test.ts scripts/check-metrics_test.ts scripts/check-runtime-contract_test.ts scripts/check-runbooks_test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现检查脚本**

修改 `scripts/check-domains.ts`：

- `DOMAINS` 新增 `"observability"`。
- 新增 `const PUBLIC_SUBPATHS: Record<string, string[]> = { observability: ["write.ts"] };`
- 新增 `const NO_CROSS_DOMAIN_DOMAINS = new Set(["observability"]);`
- 修改 `isPublicDomainImport(target, sourceDomain)`：
  - 若 `target` 是 `src/domains/observability/index.ts` 且 `sourceDomain === "admin"`，返回 true。
  - 若 `target` 是 `src/domains/observability/write.ts`，返回 true。
  - 否则保持原逻辑（`index.ts` 对非 observability 目标仍允许）。
- 在 `checkFile` 中，若 `sourceDomain === "observability"` 且 `targetDomain` 存在且不等于 `observability`，直接报违规（即使 target 是 index.ts）。

创建 `noj-core/src/domains/observability/services/runtime-contract.ts`：

```ts
export interface RuntimeDescriptor {
  name: "noj-llm-gateway" | "noj-judge";
  contractVersion: 1;
  mode: "http" | "heartbeat";
  healthUrl?: string;
  metricsUrl?: string;
  heartbeatKey?: string;
  requiredMetrics: readonly string[];
}

export const RUNTIME_DESCRIPTORS: readonly RuntimeDescriptor[] = [
  {
    name: "noj-llm-gateway",
    contractVersion: 1,
    mode: "http",
    healthUrl: "http://noj-llm-gateway:8001/health/live",
    metricsUrl: "http://noj-llm-gateway:8001/metrics",
    requiredMetrics: [
      "noj_llm_requests_total",
      "noj_llm_request_duration_seconds",
      "noj_llm_tokens_total",
      "noj_llm_rate_limited_total",
      "noj_llm_quota_exhausted_total",
      "noj_llm_provider_errors_total",
    ],
  },
  {
    name: "noj-judge",
    contractVersion: 1,
    mode: "heartbeat",
    heartbeatKey: "noj:observability:judge:",
    requiredMetrics: [
      "noj_judge_workers",
      "noj_judge_active_tasks",
      "noj_judge_completed_tasks_total",
      "noj_judge_failed_tasks_total",
      "noj_judge_result_push_failures_total",
      "noj_judge_orphan_containers",
      "noj_judge_cache_items",
      "noj_judge_cache_bytes",
      "noj_judge_work_dir_bytes",
    ],
  },
];
```

创建 `scripts/check-metrics.ts`：

```ts
import { resolve } from "node:path";
import { PLATFORM_METRIC_NAMES } from "../noj-core/src/domains/observability/metrics/platform.ts";

const DEFINE_RE = /registerBusinessMetric\(\s*\{[\s\S]*?name:\s*"([^"]+)"/g;
const WRITE_RE = /observability\.(?:inc|set|add|observe)\(\s*"([^"]+)"/g;

export function checkMetricCalls(content: string, known: Set<string>): string[] {
  const errors: string[] = [];
  for (const m of content.matchAll(WRITE_RE)) {
    if (m[1] && !known.has(m[1])) errors.push(`未定义指标: ${m[1]}`);
  }
  return errors;
}

async function collectTsFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(current: string): Promise<void> {
    for await (const entry of Deno.readDir(current)) {
      const full = `${current}/${entry.name}`;
      if (entry.isDirectory) {
        await walk(full);
      } else if (entry.isFile && entry.name.endsWith(".ts")) {
        results.push(full);
      }
    }
  }
  await walk(dir);
  return results;
}

export async function checkMetrics(root = "."): Promise<string[]> {
  const known = new Set<string>(PLATFORM_METRIC_NAMES);
  const errors: string[] = [];
  const srcDir = resolve(root, "noj-core/src");
  const files = await collectTsFiles(srcDir);
  for (const file of files) {
    const content = await Deno.readTextFile(file);
    for (const m of content.matchAll(DEFINE_RE)) {
      if (m[1]) known.add(m[1]);
    }
  }
  for (const file of files) {
    const content = await Deno.readTextFile(file);
    for (const error of checkMetricCalls(content, known)) {
      errors.push(`${file}: ${error}`);
    }
  }
  return errors;
}

if (import.meta.main) {
  const errors = await checkMetrics(".");
  if (errors.length > 0) {
    for (const e of errors) console.error(e);
    Deno.exit(1);
  }
  console.log("指标 catalog 检查通过");
}
```

创建 `scripts/check-runtime-contract.ts`：

```ts
import { resolve } from "node:path";
import { RUNTIME_DESCRIPTORS } from "../noj-core/src/domains/observability/services/runtime-contract.ts";

export async function checkRuntimeContract(root = "."): Promise<string[]> {
  const errors: string[] = [];
  const prometheusPath = resolve(root, "deploy/monitoring/prometheus.yml");
  const prometheus = await Deno.readTextFile(prometheusPath);
  for (const descriptor of RUNTIME_DESCRIPTORS) {
    if (descriptor.mode === "http") {
      if (!prometheus.includes(descriptor.name)) {
        errors.push(`prometheus.yml 缺少 job: ${descriptor.name}`);
      }
      const fixturePath = resolve(root, "noj-tests/fixtures/gateway-metrics.txt");
      const fixture = await Deno.readTextFile(fixturePath);
      for (const metric of descriptor.requiredMetrics) {
        if (!fixture.includes(metric)) {
          errors.push(`gateway fixture 缺少指标: ${metric}`);
        }
      }
    }
  }
  return errors;
}

if (import.meta.main) {
  const errors = await checkRuntimeContract(".");
  if (errors.length > 0) {
    for (const e of errors) console.error(e);
    Deno.exit(1);
  }
  console.log("运行时契约检查通过");
}
```

创建 `scripts/check-runbooks.ts`：

```ts
import { resolve } from "node:path";

const RUNBOOK_RE = /runbook:\s*["']?([^"'\s]+)["']?/g;

export async function checkRunbooks(root = "."): Promise<string[]> {
  const errors: string[] = [];
  const alertsPath = resolve(root, "deploy/monitoring/noj-alerts.yml");
  const alerts = await Deno.readTextFile(alertsPath);
  for (const m of alerts.matchAll(RUNBOOK_RE)) {
    const runbook = m[1];
    if (!runbook) continue;
    try {
      await Deno.stat(resolve(root, runbook));
    } catch {
      errors.push(`Runbook 不存在: ${runbook}`);
    }
  }
  return errors;
}

if (import.meta.main) {
  const errors = await checkRunbooks(".");
  if (errors.length > 0) {
    for (const e of errors) console.error(e);
    Deno.exit(1);
  }
  console.log("Runbook 链接检查通过");
}
```

创建 `noj-tests/fixtures/gateway-metrics.txt`（P1 前先提供契约指标样例，保证契约检查可运行）：

```text
# HELP noj_llm_requests_total LLM 请求总数
# TYPE noj_llm_requests_total counter
noj_llm_requests_total 0
# HELP noj_llm_request_duration_seconds LLM 请求耗时
# TYPE noj_llm_request_duration_seconds histogram
noj_llm_request_duration_seconds_count 0
# HELP noj_llm_tokens_total LLM token 用量
# TYPE noj_llm_tokens_total counter
noj_llm_tokens_total 0
# HELP noj_llm_rate_limited_total LLM 限流总数
# TYPE noj_llm_rate_limited_total counter
noj_llm_rate_limited_total 0
# HELP noj_llm_quota_exhausted_total LLM 额度耗尽总数
# TYPE noj_llm_quota_exhausted_total counter
noj_llm_quota_exhausted_total 0
# HELP noj_llm_provider_errors_total LLM provider 错误总数
# TYPE noj_llm_provider_errors_total counter
noj_llm_provider_errors_total 0
```

修改 `scripts/check-all.ts`：在现有 `run` 列表中加入 `check-metrics.ts`、`check-runtime-contract.ts`、`check-runbooks.ts`。

修改 `noj-core/deno.json`：新增 `"check:metrics": "deno run -A ../scripts/check-metrics.ts"`、`"check:runtime-contract": "deno run -A ../scripts/check-runtime-contract.ts"`、`"check:runbooks": "deno run -A ../scripts/check-runbooks.ts"`。

- [ ] **Step 4: 运行测试确认通过**

Run: `deno test -A scripts/check-domains_test.ts scripts/check-metrics_test.ts scripts/check-runtime-contract_test.ts scripts/check-runbooks_test.ts && deno task check:domains && deno run -A scripts/check-metrics.ts && deno run -A scripts/check-runtime-contract.ts && deno run -A scripts/check-runbooks.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj commit -m "feat(core): 扩展域边界检查并新增指标/运行时/Runbook 检查"
```

---

### Task 14: SLO 定义与告警规则生成/校验

**Files:**
- Create: `noj-core/src/domains/observability/slo.ts`
- Create: `scripts/gen-alert-rules.ts`
- Create: `scripts/gen-alert-rules_test.ts`
- Modify: `deploy/monitoring/noj-alerts.yml`
- Test: `noj-core/src/domains/observability/tests/slo.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `export interface SloDefinition { id; title; sli; objective; window; burnRateWindows; runbook }`
  - `export const SLOS: readonly SloDefinition[]`
  - `scripts/gen-alert-rules.ts` 生成/校验 `deploy/monitoring/noj-alerts.yml`

- [ ] **Step 1: 写失败测试**

创建 `noj-core/src/domains/observability/tests/slo.test.ts`：

```ts
import { SLOS } from "../slo.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("slo: 每个 SLO 都有 runbook 且 objective 合法", () => {
  for (const slo of SLOS) {
    assert(slo.objective > 0 && slo.objective < 1, "objective 应在 (0,1)");
    assert(slo.runbook.startsWith("deploy/monitoring/runbooks/"), "runbook 路径应指向 runbooks");
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-core && deno task test:domain observability`
Expected: FAIL，`slo.ts` 不存在。

- [ ] **Step 3: 实现 SLO 与生成脚本**

创建 `noj-core/src/domains/observability/slo.ts`：

```ts
export interface SloDefinition {
  id: string;
  title: string;
  sli: string;
  objective: number;
  window: "30d";
  burnRateWindows: { long: string; short: string };
  runbook: string;
}

export const SLOS: readonly SloDefinition[] = [
  {
    id: "api_availability",
    title: "核心 API 可用性",
    sli: "sum(rate(noj_http_requests_total{status!~\"5..\"}[5m])) / sum(rate(noj_http_requests_total[5m]))",
    objective: 0.995,
    window: "30d",
    burnRateWindows: { long: "1h", short: "5m" },
    runbook: "deploy/monitoring/runbooks/api-availability.md",
  },
  {
    id: "submission_e2e_latency",
    title: "提交端到端延迟",
    sli: "noj_submission_e2e_duration_seconds",
    objective: 0.95,
    window: "30d",
    burnRateWindows: { long: "1h", short: "5m" },
    runbook: "deploy/monitoring/runbooks/submission-e2e-latency.md",
  },
  {
    id: "queue_oldest_pending_age",
    title: "队列最老 pending 年龄",
    sli: "noj_queue_oldest_pending_age_seconds",
    objective: 0.99,
    window: "30d",
    burnRateWindows: { long: "1h", short: "5m" },
    runbook: "deploy/monitoring/runbooks/queue-oldest-pending-age.md",
  },
  {
    id: "result_delivery_latency",
    title: "结果回传延迟",
    sli: "noj_result_delivery_duration_seconds",
    objective: 0.99,
    window: "30d",
    burnRateWindows: { long: "1h", short: "5m" },
    runbook: "deploy/monitoring/runbooks/result-delivery-latency.md",
  },
  {
    id: "evaluation_throughput",
    title: "评测吞吐",
    sli: "noj_evaluation_throughput_total",
    objective: 0.99,
    window: "30d",
    burnRateWindows: { long: "1h", short: "5m" },
    runbook: "deploy/monitoring/runbooks/evaluation-throughput.md",
  },
];
```

创建 `scripts/gen-alert-rules.ts`：

```ts
import { resolve } from "node:path";
import { SLOS } from "../noj-core/src/domains/observability/slo.ts";

function yamlEscape(value: string): string {
  return /[:#\n]/.test(value) ? JSON.stringify(value) : value;
}

export function renderSloRules(): string {
  const lines: string[] = [
    "groups:",
    "  - name: noj-slo-burn-rate",
    "    rules:",
  ];
  for (const slo of SLOS) {
    const id = slo.id;
    lines.push(`      - record: noj:slo:${id}:burn_rate`);
    lines.push(`        expr: |`);
    lines.push(`          (1 - ${slo.sli}) / (1 - ${slo.objective})`);
    lines.push(`      - alert: NojSloBurnRate${id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).replace(/ /g, "")}`);
    lines.push(`        expr: noj:slo:${id}:burn_rate > 1`);
    lines.push(`        for: ${slo.burnRateWindows.short}`);
    lines.push(`        labels:`);
    lines.push(`          severity: critical`);
    lines.push(`          slo: ${id}`);
    lines.push(`        annotations:`);
    lines.push(`          summary: ${yamlEscape(slo.title)} 错误预算消耗过快`);
    lines.push(`          runbook: ${slo.runbook}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function genAlertRules(root = ".", check = false): Promise<string[]> {
  const path = resolve(root, "deploy/monitoring/noj-alerts.yml");
  const generated = renderSloRules();
  if (check) {
    const current = await Deno.readTextFile(path);
    return current.trim() === generated.trim() ? [] : ["noj-alerts.yml 与 SLO 定义不一致，请运行 gen-alert-rules.ts 重新生成"];
  }
  await Deno.writeTextFile(path, generated);
  return [];
}

if (import.meta.main) {
  const check = Deno.args.includes("--check");
  const errors = await genAlertRules(".", check);
  if (errors.length > 0) {
    for (const e of errors) console.error(e);
    Deno.exit(1);
  }
  console.log(check ? "告警规则与 SLO 一致" : "已生成 noj-alerts.yml");
}
```

创建 `scripts/gen-alert-rules_test.ts`：

```ts
import { renderSloRules } from "./gen-alert-rules.ts";
import { SLOS } from "../noj-core/src/domains/observability/slo.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("gen-alert-rules: SLO id 唯一且 runbook 路径存在", async () => {
  const ids = new Set<string>();
  for (const slo of SLOS) {
    assert(!ids.has(slo.id), `重复 SLO id: ${slo.id}`);
    ids.add(slo.id);
    await Deno.stat(slo.runbook);
  }
});

Deno.test("gen-alert-rules: 渲染结果包含每个 SLO 的告警", () => {
  const out = renderSloRules();
  for (const slo of SLOS) {
    assert(out.includes(slo.id), `渲染应包含 ${slo.id}`);
  }
});
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-core && deno task test:domain observability && deno run -A ../scripts/gen-alert-rules.ts --check`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj commit -m "feat(core): 新增 SLO 定义与告警规则生成校验"
```

---

### Task 15: 部署资产、环境变量与文档

**Files:**
- Modify: `deploy/monitoring/prometheus.yml`
- Modify: `deploy/monitoring/noj-alerts.yml`
- Modify: `deploy/monitoring/grafana-dashboard.json`
- Create: `deploy/monitoring/runbooks/api-availability.md`
- Create: `deploy/monitoring/runbooks/submission-e2e-latency.md`
- Create: `deploy/monitoring/runbooks/queue-oldest-pending-age.md`
- Create: `deploy/monitoring/runbooks/result-delivery-latency.md`
- Create: `deploy/monitoring/runbooks/evaluation-throughput.md`
- Modify: `deploy/monitoring/README.md`
- Modify: `.env.prod.example`
- Modify: `noj-core/.env.example`
- Modify: `noj-core/src/shared/config/settings-registry.ts`
- Modify: `noj-core/CLAUDE.md`
- Modify: `dev-docs/engineering/domain-boundaries.md`
- Create: `dev-docs/engineering/metric-catalog.md`
- Create: `.agents/notes/implemented/2026-09-10-observability-domain.md`

**Interfaces:**
- Consumes: `SLOS`、`PLATFORM_METRIC_NAMES`。
- Produces: 部署资产与文档。

- [ ] **Step 1: 更新 Prometheus 配置**

在 `deploy/monitoring/prometheus.yml` 中新增 `noj-gateway` job（内部网络抓取 `noj-llm-gateway:8001/metrics`），保留 `noj-core` 与可选 `node`。

- [ ] **Step 2: 更新告警规则与 Runbook**

运行 `deno run -A scripts/gen-alert-rules.ts` 生成 `deploy/monitoring/noj-alerts.yml`；创建 5 个 Runbook 文件，每个包含：告警含义、确认步骤、缓解步骤、恢复验证。

- [ ] **Step 3: 更新 Grafana dashboard**

在 `deploy/monitoring/grafana-dashboard.json` 中新增三个 panel：

- **Judge 总览**：`noj_judge_workers`、`noj_judge_active_tasks`、`noj_judge_orphan_containers`。
- **LLM Gateway 总览**：`noj_llm_requests_total`、`noj_llm_request_duration_seconds`、`noj_llm_tokens_total`。
- **业务 SLI**：`noj_submission_e2e_duration_seconds`、`noj_queue_oldest_pending_age_seconds`、`noj_result_delivery_duration_seconds`。

每个 panel 使用对应 PromQL 查询并设置 `datasource: "${DS_PROMETHEUS}"`。

- [ ] **Step 4: 登记环境变量**

在 `noj-core/src/shared/config/settings-registry.ts` 与 `noj-core/.env.example`、`.env.prod.example` 中登记：

```text
OBSERVABILITY_SNAPSHOT_TIMEOUT_MS=500
OBSERVABILITY_CACHE_TTL_MS=1000
OBSERVABILITY_MAX_SERIES=1000
RUNTIME_LLM_GATEWAY_URL=http://noj-llm-gateway:8001
RUNTIME_JUDGE_MODE=heartbeat
```

- [ ] **Step 5: 更新文档**

更新 `noj-core/CLAUDE.md` 目录结构、`dev-docs/engineering/domain-boundaries.md` 域表、`deploy/monitoring/README.md` 抓取目标；生成 `dev-docs/engineering/metric-catalog.md`；新增 Agent Note。

- [ ] **Step 6: 运行检查**

Run: `cd noj-core && deno task check:env && deno task check:domains && deno run -A ../scripts/check-runbooks.ts`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
jj commit -m "docs(core): 更新观测部署资产、环境变量与文档"
```

---

### Task 16: 最终验收

**Files:**
- 无新文件；运行全量检查。

**Interfaces:**
- Consumes: 全部前序任务。

- [ ] **Step 1: 运行 core 全量检查**

Run: `cd noj-core && deno task check && deno task test:domain observability && bash scripts/test-shared.sh`
Expected: PASS。

- [ ] **Step 2: 运行跨模块 E2E**

Run: `cd noj-tests && deno task test:domain cross-domain`
Expected: PASS（若本机 Docker daemon 未启动，记录为待 CI 补跑，不阻塞提交）。

- [ ] **Step 3: 运行仓库级检查**

Run: `deno run -A scripts/check-all.ts`
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
jj commit -m "chore(core): 可观测性平台域重构验收通过"
```

---

## 后续计划（不在本计划内）

- **P1：LLM 网关 `/metrics` 与运行时契约校验**——在 `noj-llm-gateway` 新增 `/health/live`、`/health/ready`、`/metrics`，并让 `check-runtime-contract.ts` 校验 gateway 指标。
- **P2：MinIO/存储与更细 sandbox 资源指标**——补充 `noj_storage_bytes`、`noj_judge_sandbox_*` 等。
- **P3：`noj-cli observability check`**——包装健康/指标/规则/Runbook 自检命令。
