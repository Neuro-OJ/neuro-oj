# noj-cli 统一命令树 + observability/server 命令（Phase 1）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 noj-cli 建立统一部署上下文解析骨架，并新增 `observability check/alert-drill` 与 `server` 两条 Deno 命令线，使脚本侧这两类能力首次被 CLI 直接支持。

**Architecture:** 新增 `src/context/` 统一识别 production/json/judge 上下文；新增 `src/observability/`（HTTP 客户端 + 健康检查 + 告警演练）和 `src/server_cmd/`（容器内 `/app/bin/noj` 命令包装）；在 `src/cli.ts` 中挂载新顶层命令。现有 JSON/production 命令保持不动，后续计划再逐步把 judge、restore-drill、production Deno 化接入统一命令树。

**Tech Stack:** Deno 2 + TypeScript、`@std/assert`、`@std/path`、Deno 内置 `fetch` / `Deno.Command`。

**Spec:** `dev-docs/superpowers/specs/2026-09-07-noj-cli-script-sync-design.md`

## Global Constraints

- 语言：代码标识符使用英文，注释与提交描述使用中文。
- 运行环境：仅 Deno 2 + TypeScript 标准环境；不新增第三方运行时依赖。
- 提交：使用 jj；提交信息格式 `<type>(<scope>): <中文描述>`，scope 使用 `cli`。
- 测试：通过 `cd noj-cli && deno task test` 运行；代码通过 `deno fmt` 与 `deno lint`。
- 所有改动必须位于当前 worktree（`.worktrees/noj-cli-improves/`）内，禁止修改主仓库。
- 不修改 `scripts/deploy/*.sh` 等脚本侧实现；脚本保留为兜底。

---

### Task 1: 部署上下文识别模块

**Files:**
- Create: `noj-cli/src/context/context.ts`
- Create: `noj-cli/src/context/context_test.ts`
- Modify: `noj-cli/src/mod.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `export type ContextKind = "production" | "json" | "judge" | "none"`
  - `export interface CliContext { cwd: string; kind: ContextKind; dir: string | null }`
  - `export function detectKind(dir: string): ContextKind | null`
  - `export function findContextDir(start?: string, kind?: ContextKind): string | null`
  - `export function resolveContext(opts: { cwd?: string; dir?: string; mode?: ContextKind }): CliContext`

- [ ] **Step 1: 写失败测试**

创建 `noj-cli/src/context/context_test.ts`：

```ts
import { assertEquals, assertThrows } from "@std/assert";
import {
  detectKind,
  findContextDir,
  type ContextKind,
  resolveContext,
} from "./context.ts";

function writeFixture(dir: string, files: Record<string, string>): void {
  Deno.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    Deno.writeTextFileSync(`${dir}/${name}`, content);
  }
}

Deno.test("detectKind: production/json/judge/none", () => {
  const dir = Deno.makeTempDirSync();
  writeFixture(dir, {
    ".env.prod": "NOJ_VERSION=v0.1.0\n",
    "docker-compose.prod.yml": "services: {}\n",
  });
  assertEquals(detectKind(dir), "production" as ContextKind);

  const jsonDir = Deno.makeTempDirSync();
  writeFixture(jsonDir, {
    "noj-deploy.json": "{}",
    "noj-secrets.json": "{}",
  });
  assertEquals(detectKind(jsonDir), "json" as ContextKind);

  const judgeDir = Deno.makeTempDirSync();
  writeFixture(judgeDir, {
    ".env.judge": "NOJ_VERSION=v0.1.0\n",
    "docker-compose.judge.yml": "services: {}\n",
  });
  assertEquals(detectKind(judgeDir), "judge" as ContextKind);

  const empty = Deno.makeTempDirSync();
  assertEquals(detectKind(empty), null);
});

Deno.test("findContextDir: 向上查找指定上下文", () => {
  const root = Deno.makeTempDirSync();
  const prod = `${root}/prod`;
  writeFixture(prod, {
    ".env.prod": "NOJ_VERSION=v0.1.0\n",
    "docker-compose.prod.yml": "services: {}\n",
  });
  const nested = `${prod}/nested/deep`;
  Deno.mkdirSync(nested, { recursive: true });
  assertEquals(findContextDir(nested, "production"), prod);
  assertEquals(findContextDir(nested), prod);
});

Deno.test("resolveContext: --dir 显式指定", () => {
  const dir = Deno.makeTempDirSync();
  writeFixture(dir, {
    ".env.prod": "NOJ_VERSION=v0.1.0\n",
    "docker-compose.prod.yml": "services: {}\n",
  });
  const ctx = resolveContext({ cwd: "/tmp", dir });
  assertEquals(ctx.kind, "production");
  assertEquals(ctx.dir, dir);
});

Deno.test("resolveContext: --mode 找不到对应上下文时 kind=none", () => {
  const dir = Deno.makeTempDirSync();
  const ctx = resolveContext({ cwd: "/tmp", dir, mode: "json" });
  assertEquals(ctx.kind, "none");
  assertEquals(ctx.dir, null);
});

Deno.test("resolveContext: 显式 dir 但 mode 不匹配时抛错", () => {
  const dir = Deno.makeTempDirSync();
  writeFixture(dir, {
    ".env.prod": "NOJ_VERSION=v0.1.0\n",
    "docker-compose.prod.yml": "services: {}\n",
  });
  assertThrows(() => resolveContext({ cwd: "/tmp", dir, mode: "json" }));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/context/context_test.ts`
Expected: FAIL，报找不到 `./context.ts`。

- [ ] **Step 3: 实现 `src/context/context.ts`**

```ts
import { dirname, resolve } from "@std/path";

export type ContextKind = "production" | "json" | "judge" | "none";

export interface CliContext {
  cwd: string;
  kind: ContextKind;
  dir: string | null;
}

function isFile(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

export function detectKind(dir: string): ContextKind | null {
  const prod = isFile(`${dir}/.env.prod`) &&
    isFile(`${dir}/docker-compose.prod.yml`);
  if (prod) return "production";
  const json = isFile(`${dir}/noj-deploy.json`) &&
    isFile(`${dir}/noj-secrets.json`);
  if (json) return "json";
  const judge = isFile(`${dir}/.env.judge`) &&
    isFile(`${dir}/docker-compose.judge.yml`);
  if (judge) return "judge";
  return null;
}

export function findContextDir(
  start?: string,
  kind?: ContextKind,
): string | null {
  let current = start ?? Deno.cwd();
  current = Deno.realPathSync(current);
  while (true) {
    const detected = detectKind(current);
    if (detected !== null && (kind === undefined || detected === kind)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === null || parent === current) return null;
    current = parent;
  }
}

export function resolveContext(opts: {
  cwd?: string;
  dir?: string;
  mode?: ContextKind;
}): CliContext {
  const cwd = opts.cwd ?? Deno.cwd();
  if (opts.dir !== undefined) {
    const abs = resolve(cwd, opts.dir);
    const kind = detectKind(abs);
    if (kind === null) return { cwd, kind: "none", dir: null };
    if (opts.mode !== undefined && kind !== opts.mode) {
      throw new Error(`目录 ${abs} 不是 ${opts.mode} 上下文`);
    }
    return { cwd, kind, dir: abs };
  }
  if (opts.mode !== undefined) {
    const dir = findContextDir(cwd, opts.mode);
    return { cwd, kind: dir ? opts.mode : "none", dir };
  }
  const dir = findContextDir(cwd);
  const kind = dir ? detectKind(dir) : "none";
  return { cwd, kind, dir };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/context/context_test.ts`
Expected: PASS。

- [ ] **Step 5: 在 `src/mod.ts` 导出 context 类型和函数**

在 `src/mod.ts` 末尾追加：

```ts
// context（Phase 1）
export type { CliContext, ContextKind } from "./context/context.ts";
export { detectKind, findContextDir, resolveContext } from "./context/context.ts";
```

- [ ] **Step 6: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj commit -m "feat(cli): 新增部署上下文识别模块"
```

---

### Task 2: 可注入 HTTP 客户端

**Files:**
- Create: `noj-cli/src/observability/http.ts`
- Create: `noj-cli/src/observability/http_test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `export interface HttpResult { status: number; body: string }`
  - `export interface HttpClient { get(url: string): Promise<HttpResult>; postJson(url: string, body: string): Promise<HttpResult> }`
  - `export function realHttp(): HttpClient`

- [ ] **Step 1: 写失败测试**

创建 `noj-cli/src/observability/http_test.ts`：

```ts
import { assertEquals } from "@std/assert";
import { realHttp } from "./http.ts";

Deno.test("realHttp: GET 返回状态与响应体", async () => {
  const http = realHttp();
  const res = await http.get("data:text/plain,hello");
  assertEquals(res.status, 200);
  assertEquals(res.body, "hello");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/observability/http_test.ts`
Expected: FAIL，报找不到 `./http.ts`。

- [ ] **Step 3: 实现 `src/observability/http.ts`**

```ts
export interface HttpResult {
  status: number;
  body: string;
}

export interface HttpClient {
  get(url: string): Promise<HttpResult>;
  postJson(url: string, body: string): Promise<HttpResult>;
}

export function realHttp(): HttpClient {
  return {
    async get(url) {
      const res = await fetch(url);
      return { status: res.status, body: await res.text() };
    },
    async postJson(url, body) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      return { status: res.status, body: await res.text() };
    },
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/observability/http_test.ts`
Expected: PASS。

- [ ] **Step 5: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj commit -m "feat(cli): 新增可注入 HTTP 客户端"
```

---

### Task 3: observability check 命令实现

**Files:**
- Create: `noj-cli/src/observability/check.ts`
- Create: `noj-cli/src/observability/check_test.ts`

**Interfaces:**
- Consumes: `HttpClient`（Task 2）。
- Produces:
  - `export interface ObservabilityCheckOptions { baseUrl?: string; checkNotifications?: boolean; alertmanagerUrl?: string; http?: HttpClient }`
  - `export interface CheckItem { name: string; ok: boolean; detail: string }`
  - `export interface ObservabilityReport { items: CheckItem[]; pass: boolean }`
  - `export async function observabilityCheck(opts?: ObservabilityCheckOptions): Promise<ObservabilityReport>`

- [ ] **Step 1: 写失败测试**

创建 `noj-cli/src/observability/check_test.ts`：

```ts
import { assertEquals } from "@std/assert";
import type { HttpClient, HttpResult } from "./http.ts";
import { observabilityCheck } from "./check.ts";

function fakeHttp(routes: Record<string, HttpResult>): HttpClient {
  return {
    async get(url) {
      const res = routes[url];
      if (!res) return { status: 404, body: "not found" };
      return res;
    },
    async postJson(_url, _body) {
      return { status: 200, body: "" };
    },
  };
}

Deno.test("observabilityCheck: 全部通过", async () => {
  const base = "http://noj.test";
  const http = fakeHttp({
    [`${base}/health/live`]: { status: 200, body: '{"status":"alive"}' },
    [`${base}/health/ready`]: { status: 200, body: '{"status":"ready"}' },
    [`${base}/metrics`]: {
      status: 200,
      body: "noj_database_up 1\nnoj_judge_workers 2\n",
    },
  });
  const report = await observabilityCheck({ baseUrl: base, http });
  assertEquals(report.pass, true);
  assertEquals(report.items.length, 3);
});

Deno.test("observabilityCheck: readiness 失败导致整体失败", async () => {
  const base = "http://noj.test";
  const http = fakeHttp({
    [`${base}/health/live`]: { status: 200, body: '{"status":"alive"}' },
    [`${base}/health/ready`]: { status: 503, body: '{"status":"not_ready"}' },
    [`${base}/metrics`]: { status: 200, body: "noj_database_up 1\n" },
  });
  const report = await observabilityCheck({ baseUrl: base, http });
  assertEquals(report.pass, false);
  assertEquals(report.items[1]?.ok, false);
});

Deno.test("observabilityCheck: --check-notifications 验证 Alertmanager", async () => {
  const base = "http://noj.test";
  const am = "http://alertmanager:9093";
  const http = fakeHttp({
    [`${base}/health/live`]: { status: 200, body: '{"status":"alive"}' },
    [`${base}/health/ready`]: { status: 200, body: '{"status":"ready"}' },
    [`${base}/metrics`]: { status: 200, body: "noj_database_up 1\n" },
    [`${am}/-/ready`]: { status: 200, body: "OK" },
  });
  const report = await observabilityCheck({
    baseUrl: base,
    checkNotifications: true,
    alertmanagerUrl: am,
    http,
  });
  assertEquals(report.pass, true);
  assertEquals(report.items.length, 4);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/observability/check_test.ts`
Expected: FAIL，报找不到 `./check.ts`。

- [ ] **Step 3: 实现 `src/observability/check.ts`**

```ts
import type { HttpClient } from "./http.ts";

export interface ObservabilityCheckOptions {
  baseUrl?: string;
  checkNotifications?: boolean;
  alertmanagerUrl?: string;
  http?: HttpClient;
}

export interface CheckItem {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ObservabilityReport {
  items: CheckItem[];
  pass: boolean;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:8000";

async function checkEndpoint(
  http: HttpClient,
  name: string,
  url: string,
  expected: string,
): Promise<CheckItem> {
  try {
    const res = await http.get(url);
    const ok = res.status === 200 && res.body.includes(expected);
    return {
      name,
      ok,
      detail: ok ? `${url} 正常` : `${url} 返回 ${res.status} 或缺少 ${expected}`,
    };
  } catch (e) {
    return { name, ok: false, detail: `${url} 访问失败: ${(e as Error).message}` };
  }
}

export async function observabilityCheck(
  opts: ObservabilityCheckOptions = {},
): Promise<ObservabilityReport> {
  const http = opts.http ?? (await import("./http.ts")).realHttp();
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const items: CheckItem[] = [];
  items.push(
    await checkEndpoint(http, "liveness", `${baseUrl}/health/live`, '"status":"alive"'),
  );
  items.push(
    await checkEndpoint(http, "readiness", `${baseUrl}/health/ready`, '"status":"ready"'),
  );

  const metrics = await http.get(`${baseUrl}/metrics`);
  const metricsOk = metrics.status === 200 &&
    metrics.body.includes("noj_database_up") &&
    metrics.body.includes("noj_judge_workers");
  items.push({
    name: "metrics",
    ok: metricsOk,
    detail: metricsOk ? "metrics 包含关键指标" : "metrics 缺少 noj_database_up 或 noj_judge_workers",
  });

  if (opts.checkNotifications) {
    if (!opts.alertmanagerUrl) {
      items.push({
        name: "notifications",
        ok: false,
        detail: "checkNotifications 需要 ALERTMANAGER_URL",
      });
    } else {
      const amRes = await http.get(`${opts.alertmanagerUrl}/-/ready`);
      const amOk = amRes.status === 200;
      items.push({
        name: "notifications",
        ok: amOk,
        detail: amOk ? `${opts.alertmanagerUrl} 就绪` : `${opts.alertmanagerUrl} 返回 ${amRes.status}`,
      });
    }
  }

  return { items, pass: items.every((i) => i.ok) };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/observability/check_test.ts`
Expected: PASS（若 `notifications` 断言因 detail 逻辑不匹配，可调整实现为显式检查状态码后继续）。

- [ ] **Step 5: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj commit -m "feat(cli): 实现 observability check"
```

---

### Task 4: observability alert-drill 命令实现

**Files:**
- Create: `noj-cli/src/observability/alert_drill.ts`
- Create: `noj-cli/src/observability/alert_drill_test.ts`

**Interfaces:**
- Consumes: `HttpClient`（Task 2）。
- Produces:
  - `export interface AlertDrillOptions { alertmanagerUrl?: string; holdSeconds?: number; http?: HttpClient }`
  - `export interface AlertDrillReport { injected: boolean; resolved: boolean; holdSeconds: number }`
  - `export async function alertDrill(opts?: AlertDrillOptions): Promise<AlertDrillReport>`

- [ ] **Step 1: 写失败测试**

创建 `noj-cli/src/observability/alert_drill_test.ts`：

```ts
import { assertEquals } from "@std/assert";
import type { HttpClient, HttpResult } from "./http.ts";
import { alertDrill } from "./alert_drill.ts";

function recordingHttp(calls: { url: string; body: string }[]): HttpClient {
  return {
    async get(url) {
      return { status: 200, body: url };
    },
    async postJson(url, body) {
      calls.push({ url, body });
      return { status: 200, body: "" };
    },
  };
}

Deno.test("alertDrill: 注入并恢复告警", async () => {
  const calls: { url: string; body: string }[] = [];
  const http = recordingHttp(calls);
  const report = await alertDrill({
    alertmanagerUrl: "http://alertmanager:9093",
    holdSeconds: 0,
    http,
  });
  assertEquals(report.injected, true);
  assertEquals(report.resolved, true);
  assertEquals(calls.length, 2);
  assertEquals(calls[0]?.url, "http://alertmanager:9093/api/v2/alerts");
  assertEquals(calls[1]?.url, "http://alertmanager:9093/api/v2/alerts");
  assertEquals(calls[0]?.body.includes("NojNotificationDrill"), true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/observability/alert_drill_test.ts`
Expected: FAIL，报找不到 `./alert_drill.ts`。

- [ ] **Step 3: 实现 `src/observability/alert_drill.ts`**

```ts
import type { HttpClient } from "./http.ts";

export interface AlertDrillOptions {
  alertmanagerUrl?: string;
  holdSeconds?: number;
  http?: HttpClient;
}

export interface AlertDrillReport {
  injected: boolean;
  resolved: boolean;
  holdSeconds: number;
}

const DEFAULT_ALERTMANAGER_URL = "http://alertmanager:9093";

function activePayload(startsAt: string): string {
  return JSON.stringify([
    {
      labels: {
        alertname: "NojNotificationDrill",
        severity: "critical",
        instance: "notification-drill",
      },
      annotations: {
        summary: "告警投递演练（critical）",
        description: `投递演练测试告警，无需处理；startsAt=${startsAt}`,
      },
      startsAt,
    },
    {
      labels: {
        alertname: "NojNotificationDrill",
        severity: "warning",
        instance: "notification-drill",
      },
      annotations: {
        summary: "告警投递演练（warning）",
        description: `投递演练测试告警，无需处理；startsAt=${startsAt}`,
      },
      startsAt,
    },
  ]);
}

function resolvedPayload(startsAt: string, endsAt: string): string {
  return JSON.stringify([
    {
      labels: {
        alertname: "NojNotificationDrill",
        severity: "critical",
        instance: "notification-drill",
      },
      annotations: { summary: "告警投递演练（critical）已恢复" },
      startsAt,
      endsAt,
    },
    {
      labels: {
        alertname: "NojNotificationDrill",
        severity: "warning",
        instance: "notification-drill",
      },
      annotations: { summary: "告警投递演练（warning）已恢复" },
      startsAt,
      endsAt,
    },
  ]);
}

export async function alertDrill(
  opts: AlertDrillOptions = {},
): Promise<AlertDrillReport> {
  const http = opts.http ?? (await import("./http.ts")).realHttp();
  const alertmanagerUrl = opts.alertmanagerUrl ?? DEFAULT_ALERTMANAGER_URL;
  const holdSeconds = opts.holdSeconds ?? 300;
  const startsAt = new Date().toISOString();
  const url = `${alertmanagerUrl}/api/v2/alerts`;

  const active = await http.postJson(url, activePayload(startsAt));
  if (active.status !== 200) {
    throw new Error(`注入告警失败：HTTP ${active.status}`);
  }

  if (holdSeconds > 0) {
    await new Promise((resolve) => setTimeout(resolve, holdSeconds * 1000));
  }

  const resolved = await http.postJson(
    url,
    resolvedPayload(startsAt, new Date().toISOString()),
  );
  if (resolved.status !== 200) {
    throw new Error(`恢复告警失败：HTTP ${resolved.status}`);
  }

  return { injected: true, resolved: true, holdSeconds };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/observability/alert_drill_test.ts`
Expected: PASS。

- [ ] **Step 5: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj commit -m "feat(cli): 实现 observability alert-drill"
```

---

### Task 5: CLI 挂载 observability 命令

**Files:**
- Modify: `noj-cli/src/cli.ts`
- Modify: `noj-cli/src/cli_test.ts`

**Interfaces:**
- Consumes: `observabilityCheck`、`alertDrill`（Task 3/4）。
- Produces:
  - `export interface ObservabilityArgs { sub: string; baseUrl?: string; checkNotifications: boolean; alertmanagerUrl?: string; holdSeconds: number }`
  - `export function parseObservabilityArgs(args: string[]): ObservabilityArgs`

- [ ] **Step 1: 写失败测试**

在 `noj-cli/src/cli_test.ts` 末尾追加：

```ts
Deno.test("parseObservabilityArgs: check 参数解析", () => {
  const a = parseObservabilityArgs([
    "check",
    "--base-url",
    "http://noj.test",
    "--check-notifications",
    "--alertmanager-url",
    "http://am:9093",
  ]);
  assertEquals(a.sub, "check");
  assertEquals(a.baseUrl, "http://noj.test");
  assertEquals(a.checkNotifications, true);
  assertEquals(a.alertmanagerUrl, "http://am:9093");
});

Deno.test("parseObservabilityArgs: alert-drill 参数解析", () => {
  const a = parseObservabilityArgs([
    "alert-drill",
    "--alertmanager-url",
    "http://am:9093",
    "--hold",
    "0",
  ]);
  assertEquals(a.sub, "alert-drill");
  assertEquals(a.alertmanagerUrl, "http://am:9093");
  assertEquals(a.holdSeconds, 0);
});

Deno.test("observability 无子命令返回 1", async () => {
  assertEquals(await dispatchCommand("observability", [], ctx), 1);
});
```

> 注：`observabilityCheck` / `alertDrill` 的真实行为已在 Task 3/4 测试；这里只验证 CLI 解析和错误码。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/cli_test.ts`
Expected: FAIL，报 `parseObservabilityArgs` 未定义。

- [ ] **Step 3: 实现 CLI 解析与分发**

在 `src/cli.ts` 顶部 import 后新增：

```ts
import { alertDrill } from "./observability/alert_drill.ts";
import { observabilityCheck } from "./observability/check.ts";
import { realHttp } from "./observability/http.ts";
```

在 `KNOW_TOP` 集合中加入 `"observability"`：

```ts
const KNOWN_TOP = new Set([
  "doctor",
  "deploy",
  "maintain",
  "run-server",
  "version",
  "observability",
]);
```

在 `parseBackupArgs` 之后新增：

```ts
export interface ObservabilityArgs {
  sub: string;
  baseUrl: string | undefined;
  checkNotifications: boolean;
  alertmanagerUrl: string | undefined;
  holdSeconds: number;
}

export function parseObservabilityArgs(args: string[]): ObservabilityArgs {
  const out: ObservabilityArgs = {
    sub: args[0] ?? "",
    baseUrl: undefined,
    checkNotifications: false,
    alertmanagerUrl: undefined,
    holdSeconds: 300,
  };
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "--base-url":
        out.baseUrl = args[++i];
        break;
      case "--check-notifications":
        out.checkNotifications = true;
        break;
      case "--alertmanager-url":
        out.alertmanagerUrl = args[++i];
        break;
      case "--hold":
        out.holdSeconds = Number(args[++i]);
        break;
      default:
        throw new Error(`未知 observability 参数: ${a}`);
    }
  }
  return out;
}
```

在 `dispatchCommand` 的 `switch (command)` 中新增分支：

```ts
case "observability": {
  const a = parseObservabilityArgs(args);
  try {
    if (a.sub === "check") {
      const report = await observabilityCheck({
        baseUrl: a.baseUrl,
        checkNotifications: a.checkNotifications,
        alertmanagerUrl: a.alertmanagerUrl,
        http: realHttp(),
      });
      for (const item of report.items) {
        console.log(`${item.ok ? "✓" : "✗"} ${item.name}: ${item.detail}`);
      }
      return report.pass ? 0 : 1;
    }
    if (a.sub === "alert-drill") {
      const report = await alertDrill({
        alertmanagerUrl: a.alertmanagerUrl,
        holdSeconds: a.holdSeconds,
        http: realHttp(),
      });
      console.log(`告警演练完成：注入=${report.injected} 恢复=${report.resolved}`);
      return 0;
    }
    console.error("observability: 需要子命令 check/alert-drill");
    return 1;
  } catch (e) {
    console.error(`observability: ${(e as Error).message}`);
    return 1;
  }
}
```

在 `printHelp()` 的 JSON 配置工具段落前追加：

```text
"  observability check       检查 liveness/readiness/metrics（可选通知链路）",
"  observability alert-drill 向 Alertmanager 注入告警并发送恢复事件",
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/cli_test.ts`
Expected: PASS。

- [ ] **Step 5: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj commit -m "feat(cli): 挂载 observability 命令"
```

---

### Task 6: server 命令运行器

**Files:**
- Create: `noj-cli/src/server_cmd/server_cmd.ts`
- Create: `noj-cli/src/server_cmd/server_cmd_test.ts`

**Interfaces:**
- Consumes: `CliContext`（Task 1）、`CommandRunner`（现有 `src/runtime/command.ts`）。
- Produces:
  - `export type ServerSubcommand = readonly [string, ...string[]]`
  - `export interface ServerCommandOptions { context: CliContext; args: string[]; runner?: CommandRunner }`
  - `export async function runServerCommand(opts: ServerCommandOptions): Promise<number>`

- [ ] **Step 1: 写失败测试**

创建 `noj-cli/src/server_cmd/server_cmd_test.ts`：

```ts
import { assertEquals } from "@std/assert";
import type { CliContext } from "../context/context.ts";
import type { CommandRunner, SpawnHandle, SpawnOpts } from "../runtime/command.ts";
import { runServerCommand } from "./server_cmd.ts";

function runnerWithLog(log: string[][]): CommandRunner {
  return {
    async run(cmd, args) {
      log.push([cmd, ...args]);
      return { code: 0, stdout: "", stderr: "" };
    },
    spawn(opts: SpawnOpts): SpawnHandle {
      log.push([opts.cmd, ...opts.args]);
      return {
        pid: 1,
        async wait() {
          return 0;
        },
        async kill() {},
      };
    },
  };
}

Deno.test("server: production 上下文调用 docker compose run", async () => {
  const log: string[][] = [];
  const runner = runnerWithLog(log);
  const ctx: CliContext = {
    cwd: "/tmp",
    kind: "production",
    dir: "/opt/neuro-oj",
  };
  const code = await runServerCommand({
    context: ctx,
    args: ["db", "migrate"],
    runner,
  });
  assertEquals(code, 0);
  const call = log[0]!;
  assertEquals(call[0], "docker");
  assertEquals(call.includes("compose"), true);
  assertEquals(call.includes("run"), true);
  assertEquals(call.includes("--entrypoint"), true);
  assertEquals(call.includes("/app/bin/noj"), true);
  assertEquals(call.includes("core"), true);
  assertEquals(call[call.length - 1], "migrate");
});

Deno.test("server: production 上下文透传 bootstrap 参数", async () => {
  const log: string[][] = [];
  const runner = runnerWithLog(log);
  const ctx: CliContext = {
    cwd: "/tmp",
    kind: "production",
    dir: "/opt/neuro-oj",
  };
  await runServerCommand({
    context: ctx,
    args: ["bootstrap", "first-admin", "--username", "admin"],
    runner,
  });
  const call = log[0]!;
  assertEquals(call.includes("bootstrap"), true);
  assertEquals(call.includes("first-admin"), true);
  assertEquals(call.includes("--username"), true);
  assertEquals(call.includes("admin"), true);
});

Deno.test("server: 源码上下文调用 deno task", async () => {
  const root = Deno.makeTempDirSync();
  Deno.mkdirSync(`${root}/noj-core`, { recursive: true });
  Deno.writeTextFileSync(`${root}/noj-core/deno.json`, "{}");
  const log: string[][] = [];
  const runner = runnerWithLog(log);
  const ctx: CliContext = { cwd: `${root}/noj-core`, kind: "none", dir: null };
  const code = await runServerCommand({
    context: ctx,
    args: ["db", "migrate"],
    runner,
  });
  assertEquals(code, 0);
  const call = log[0]!;
  assertEquals(call[0], "deno");
  assertEquals(call.includes("task"), true);
  assertEquals(call.includes("db:migrate"), true);
});

Deno.test("server: 无上下文且找不到源码根目录返回非零", async () => {
  const log: string[][] = [];
  const runner = runnerWithLog(log);
  const ctx: CliContext = { cwd: "/tmp", kind: "none", dir: null };
  const code = await runServerCommand({ context: ctx, args: ["db", "migrate"], runner });
  assertEquals(code, 1);
  assertEquals(log.length, 0);
});

Deno.test("server: judge 上下文返回非零", async () => {
  const log: string[][] = [];
  const runner = runnerWithLog(log);
  const ctx: CliContext = { cwd: "/tmp", kind: "judge", dir: "/srv/noj-judge" };
  const code = await runServerCommand({ context: ctx, args: ["db", "migrate"], runner });
  assertEquals(code, 1);
  assertEquals(log.length, 0);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/server_cmd/server_cmd_test.ts`
Expected: FAIL，报找不到 `./server_cmd.ts`。

- [ ] **Step 3: 实现 `src/server_cmd/server_cmd.ts`**

```ts
import { dirname } from "@std/path";
import type { CliContext } from "../context/context.ts";
import { realRunner, type CommandRunner } from "../runtime/command.ts";

export interface ServerCommandOptions {
  context: CliContext;
  args: string[];
  runner?: CommandRunner;
}

const VALID_SUBCOMMANDS = new Set([
  "db",
  "init",
  "bootstrap",
  "problems",
  "dev-setup",
]);

function validateArgs(args: string[]): void {
  if (args.length === 0) throw new Error("server: 缺少子命令");
  if (!VALID_SUBCOMMANDS.has(args[0]!)) {
    throw new Error(`server: 未知子命令 ${args[0]}`);
  }
}

function findSourceRoot(start: string): string | null {
  let current = Deno.realPathSync(start);
  while (true) {
    try {
      if (Deno.statSync(`${current}/noj-core/deno.json`).isFile) {
        return current;
      }
    } catch {
      // 继续向上
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function sourceCommand(args: string[]): { cmd: string; args: string[] } {
  const [sub, subsub, ...rest] = args;
  if (sub === "db" && subsub === "migrate") {
    return { cmd: "deno", args: ["task", "db:migrate"] };
  }
  if (sub === "init" && subsub === "system") {
    return { cmd: "deno", args: ["task", "init:system"] };
  }
  if (sub === "bootstrap") {
    if (!subsub) throw new Error("server: bootstrap 需要 first-admin 或 admin");
    return {
      cmd: "deno",
      args: [
        "run",
        "--env-file=.env",
        "-A",
        "scripts/noj.ts",
        "bootstrap",
        subsub,
        ...rest,
      ],
    };
  }
  if (sub === "problems") {
    if (subsub === "build") {
      return { cmd: "deno", args: ["task", "problems:build", "--", ...rest] };
    }
    if (subsub === "import") {
      return { cmd: "deno", args: ["task", "problems:import", "--", ...rest] };
    }
  }
  if (sub === "dev-setup") {
    return { cmd: "deno", args: ["task", "dev-setup"] };
  }
  throw new Error(`server: 不支持的源码子命令 ${args.join(" ")}`);
}

export async function runServerCommand(
  opts: ServerCommandOptions,
): Promise<number> {
  const runner = opts.runner ?? realRunner();
  const { context, args } = opts;
  try {
    validateArgs(args);
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }

  if (context.kind === "production" && context.dir !== null) {
    const fullArgs = [
      "compose",
      "--env-file",
      `${context.dir}/.env.prod`,
      "--file",
      `${context.dir}/docker-compose.prod.yml`,
      "run",
      "--rm",
      "--entrypoint",
      "/app/bin/noj",
      "core",
      ...args,
    ];
    const handle = runner.spawn({
      cmd: "docker",
      args: fullArgs,
      cwd: context.dir,
      env: {},
    });
    return await handle.wait();
  }

  const sourceRoot = findSourceRoot(context.cwd);
  if (sourceRoot !== null) {
    try {
      const launch = sourceCommand(args);
      const handle = runner.spawn({
        cmd: launch.cmd,
        args: launch.args,
        cwd: `${sourceRoot}/noj-core`,
        env: {},
      });
      return await handle.wait();
    } catch (e) {
      console.error((e as Error).message);
      return 1;
    }
  }

  console.error("server: 未找到 production 部署或 noj-core 源码目录");
  return 1;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/server_cmd/server_cmd_test.ts`
Expected: PASS。

- [ ] **Step 5: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj commit -m "feat(cli): 实现 server 命令运行器"
```

---

### Task 7: CLI 挂载 server 命令

**Files:**
- Modify: `noj-cli/src/cli.ts`
- Modify: `noj-cli/src/cli_test.ts`

**Interfaces:**
- Consumes: `runServerCommand`（Task 6）、`resolveContext`（Task 1）。
- Produces: 无新导出；`dispatchCommand("server", args, ctx)` 返回进程退出码。

- [ ] **Step 1: 写失败测试**

在 `noj-cli/src/cli_test.ts` 追加：

```ts
Deno.test("server 无上下文时返回 1", async () => {
  assertEquals(await dispatchCommand("server", ["db", "migrate"], ctx), 1);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/cli_test.ts`
Expected: 当前应 FAIL（`server` 不是已知命令，`dispatchCommand` 走 `switch` 默认返回 1？若现有未知命令测试已覆盖，则此测试实际可能通过；请同时添加 `printHelp` 包含 `server` 的断言确保未实现时失败）。

在 `printHelp` 测试中追加：

```ts
Deno.test("printHelp 包含 server", () => {
  assertEquals(printHelp().includes("server"), true);
});
```

预期 `server` 尚未加入 help，因此 FAIL。

- [ ] **Step 3: 实现 CLI 挂载**

在 `src/cli.ts`：

- import 增加：

```ts
import { runServerCommand } from "./server_cmd/server_cmd.ts";
import { resolveContext } from "./context/context.ts";
```

- `KNOWN_TOP` 增加 `"server"`：

```ts
const KNOWN_TOP = new Set([
  "doctor",
  "deploy",
  "maintain",
  "run-server",
  "version",
  "observability",
  "server",
]);
```

- 在 `dispatchCommand` 的 `switch` 中新增：

```ts
case "server": {
  const parsedDir = args.includes("--dir")
    ? args[args.indexOf("--dir") + 1]
    : undefined;
  const context = resolveContext({ cwd: ctx.cwd, dir: parsedDir });
  const serverArgs = args.filter((a) => a !== "--dir" && a !== parsedDir);
  return await runServerCommand({ context, args: serverArgs });
}
```

- 在 `printHelp()` 增加：

```text
"  server <cmd>            容器内服务端管理命令（db/init/bootstrap/problems/dev-setup）",
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/cli_test.ts`
Expected: PASS（`server 无上下文` 返回 1，`printHelp` 包含 `server`）。

- [ ] **Step 5: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj commit -m "feat(cli): 挂载 server 命令"
```

---

### Task 8: 更新命令帮助与 README

**Files:**
- Modify: `noj-cli/README.md`
- Modify: `noj-cli/src/cli.ts`（若帮助文本不完整）

**Interfaces:**
- Consumes: 前序任务产出的命令。
- Produces: 用户可读的命令文档。

- [ ] **Step 1: 在 README 增加新命令说明**

在 `noj-cli/README.md` 的“生产命令”或“开发与验证”之前补充：

```markdown
## 新增运维命令（Phase 1）

```bash
noj-cli observability check [--base-url URL] [--check-notifications]
noj-cli observability alert-drill [--alertmanager-url URL] [--hold SECONDS]
noj-cli server db migrate
noj-cli server init system
noj-cli server bootstrap first-admin --username <user> --email <email>
noj-cli server bootstrap admin [--email <email>]
noj-cli server problems build [--id <id>]
noj-cli server problems import [--dir <dir>]
noj-cli server dev-setup
```
```

- [ ] **Step 2: 运行仓库 Markdown 链接检查**

Run: `deno run -A scripts/verify-md-links.ts`
Expected: 通过。

- [ ] **Step 3: 运行全量测试并提交**

Run: `cd noj-cli && deno task test && deno task check`
Expected: 全部通过。

```bash
jj commit -m "docs(cli): 更新 observability/server 命令说明"
```

---

## 后续计划（不在本 Phase 1 内）

- Phase 2：`judge` 命令族（移植 `judge-install.sh`）。
- Phase 3：`restore-drill` 命令（移植 `restore-drill.sh`）。
- Phase 4：production Deno 化（移植 `deploy.sh` / `install.sh` / `backup.sh` 的生产路径），并逐步将旧命令别名统一到 `deploy`/`maintain`。
- Phase 5：脚本标记弃用与清理。
