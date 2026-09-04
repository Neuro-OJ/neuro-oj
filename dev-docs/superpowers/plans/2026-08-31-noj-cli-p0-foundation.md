# noj-cli P0 基础骨架 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 `noj-cli`（Deno + TypeScript）项目骨架，实现命令分发（doctor/deploy/maintain/run-server/version stub）、部署配置模型（load/save/validate/merge）与部署状态机（transition），并为上述模块补齐 Deno 单元测试。

**Architecture:** 在仓库根新建 `noj-cli/` 独立 Deno 项目（与 `noj-core/`、`noj-ui/` 并列）。命令分发 `src/cli.ts` 负责解析子命令并路由到各 stub 处理函数；配置层 `src/config/*` 负责两个 JSON 文件（`noj-deploy.json` + `noj-secrets.json`）的读写、校验与环境变量合并；状态层 `src/state/machine.ts` 实现纯函数 `transition(state, action)`；`src/util/find_deploy_dir.ts` 从当前目录向上查找部署目录。本计划只交付骨架与可测试的纯逻辑，不实现具体业务命令。

**Tech Stack:** Deno 2（TypeScript，deno.json）、Jujutsu (jj) 本地提交、`@std/assert`（内置）、Deno 内置 `Deno.test`。仅支持 `linux/amd64`。

**Spec:** `dev-docs/superpowers/specs/2026-08-31-noj-cli-design.md`（P0 子集：CLI 骨架 + 配置模型 + 状态机）

## Global Constraints

- 语言：代码标识符使用英文，注释与提交描述使用中文。
- 运行时：仅 Deno 2 + TypeScript 标准环境，不引入第三方运行时依赖（不锁 `deno.lock`，见仓库 `.gitignore` 注释）。
- 平台：仅支持 `linux/amd64`（对应 `x86_64`）；非该平台时 `doctor` 报错。
- 配置：`noj-deploy.json`（非敏感，权限 644）+ `noj-secrets.json`（敏感，权限 600）两个 JSON 文件；`schema_version: 1`。
- 命令树 stub 仅做参数解析与占位输出，不实现业务逻辑（doctor/init/up/logs/backup 等留到后续计划）。
- 环境变量合并规则：组件最终 env = 顶层 `env` + 组件 `env`（组件覆盖全局）；组件 `env` 中 `${KEY}` 从（全局 env + secrets）解析。
- 状态集合与转换必须与设计文档一致：`uninitialized` / `stopped` / `running` / `partial` / `error`。
- 测试通过 `deno task test`（`deno test -A`）运行；代码通过 `deno fmt` 与 `deno lint`。
- 提交使用 jj（`jj describe -m "<type>(<scope>): <中文描述>"`），scope 为 `cli`；GPG 签名在仓库已全局开启，无需额外操作。
- 不修改与 P0 无关的文件（不触碰 `AGENTS.md`、`noj-core/` 等既有业务代码）。

---

### Task 1: 初始化 noj-cli Deno 项目

**Files:**
- Create: `noj-cli/deno.json`
- Create: `noj-cli/src/mod.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `deno.json`：定义 `name`（`@noj/cli`）、`version`（`0.1.0`）、`tasks`（`test` / `fmt` / `lint` / `check`）、`imports`（`@std/assert`、`@std/path`）、`compilerOptions` 与 `lint`/`fmt` 配置。
  - `src/mod.ts`：导出 `export const VERSION = "0.1.0";`

- [ ] **Step 1: 创建 `noj-cli/deno.json`**

```json
{
  "name": "@noj/cli",
  "version": "0.1.0",
  "exports": "./src/mod.ts",
  "tasks": {
    "test": "deno test -A",
    "fmt": "deno fmt",
    "fmt:check": "deno fmt --check",
    "lint": "deno lint",
    "check": "deno fmt --check && deno lint && deno check src/mod.ts"
  },
  "imports": {
    "@std/assert": "jsr:@std/assert@^1",
    "@std/path": "jsr:@std/path@^1"
  },
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true
  },
  "fmt": {
    "semiColons": true,
    "singleQuote": false,
    "indentWidth": 2
  },
  "lint": {
    "rules": {
      "tags": ["recommended"]
    }
  }
}
```

- [ ] **Step 2: 创建 `noj-cli/src/mod.ts`**

```ts
/** noj-cli 版本号，与 deno.json 的 version 保持一致。 */
export const VERSION = "0.1.0";
```

- [ ] **Step 3: 编写失败测试（验证工具链可用）**

创建 `noj-cli/src/mod_test.ts`：

```ts
import { assertEquals } from "@std/assert";
import { VERSION } from "./mod.ts";

Deno.test("mod 导出版本号 0.1.0", () => {
  assertEquals(VERSION, "0.1.0");
});
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno task test`
Expected: PASS，`mod_test.ts` 通过。

- [ ] **Step 5: 运行格式与 lint 检查**

Run: `cd noj-cli && deno fmt --check && deno lint`
Expected: 通过（无报错）。

- [ ] **Step 6: 提交本任务**

```bash
jj split noj-cli/deno.json noj-cli/src/mod.ts noj-cli/src/mod_test.ts
jj describe -m "feat(cli): 初始化 noj-cli Deno 项目骨架"
```

---

### Task 2: 配置类型定义 `src/config/types.ts`

**Files:**
- Create: `noj-cli/src/config/types.ts`
- Create: `noj-cli/src/config/types_test.ts`

**Interfaces:**
- Consumes: 无（纯类型，无运行时依赖）。
- Produces（后续所有配置/状态任务都依赖这些类型）：
  - `export interface DeployConfig`：`schema_version: number`、`type: "dev" | "prod"`、`state: DeployState`、`created_at: string`、`updated_at: string`、`install_dir: string`、`version: { noj_cli: string; noj_server: string }`、`env: Record<string, string>`、`components: Record<string, ComponentConfig>`、`reverse_proxy: ReverseProxyConfig`
  - `export interface ComponentConfig`：`enabled: boolean`、`method: "docker" | "process"`、`image?: string`、`binary?: string | null`、`internal_port?: number`、`host_port?: number | null`、`host_api_port?: number | null`、`host_console_port?: number | null`、`api_port?: number`、`console_port?: number`、`port?: number`、`docker_socket?: string`、`docker_socket_gid?: number`、`queue?: string`、`result_queue?: string`、`max_concurrent?: number`、`dev_command?: string | null`、`env: Record<string, string>`
  - `export interface SecretsConfig`：`schema_version: number`、`created_at: string`、`updated_at: string`、`secrets: Record<string, string>`
  - `export type DeployState = "uninitialized" | "stopped" | "running" | "partial" | "error"`
  - `export interface ReverseProxyConfig`：`type: "nginx"`、`config_dir: string`、`domain: string`、`upstream_port: number`
  - `export const SCHEMA_VERSION = 1`

- [ ] **Step 1: 写失败测试**

创建 `noj-cli/src/config/types_test.ts`，用类型断言验证 `SCHEMA_VERSION === 1` 且 `DeployState` 字面量集合正确：

```ts
import { assertEquals } from "@std/assert";
import { SCHEMA_VERSION, type DeployState } from "./types.ts";

Deno.test("SCHEMA_VERSION 为 1", () => {
  assertEquals(SCHEMA_VERSION, 1);
});

Deno.test("DeployState 允许的取值", () => {
  const states: DeployState[] = [
    "uninitialized",
    "stopped",
    "running",
    "partial",
    "error",
  ];
  assertEquals(states.length, 5);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/config/types_test.ts`
Expected: FAIL，报 `Error: Cannot find module .../types.ts`（模块不存在）。

- [ ] **Step 3: 实现 `src/config/types.ts`**

```ts
/** 配置 schema 版本号。 */
export const SCHEMA_VERSION = 1;

/** 部署状态机的所有合法状态。 */
export type DeployState =
  | "uninitialized"
  | "stopped"
  | "running"
  | "partial"
  | "error";

/** 反向代理配置。 */
export interface ReverseProxyConfig {
  type: "nginx";
  config_dir: string;
  domain: string;
  upstream_port: number;
}

/** 单个组件的配置。不同组件使用不同的字段子集，全部字段可选除 enabled/method/env。 */
export interface ComponentConfig {
  enabled: boolean;
  method: "docker" | "process";
  image?: string;
  binary?: string | null;
  internal_port?: number;
  host_port?: number | null;
  host_api_port?: number | null;
  host_console_port?: number | null;
  api_port?: number;
  console_port?: number;
  port?: number;
  docker_socket?: string;
  docker_socket_gid?: number;
  queue?: string;
  result_queue?: string;
  max_concurrent?: number;
  dev_command?: string | null;
  env: Record<string, string>;
}

/** 部署元数据（非敏感，对应 noj-deploy.json，权限 644）。 */
export interface DeployConfig {
  schema_version: number;
  type: "dev" | "prod";
  state: DeployState;
  created_at: string;
  updated_at: string;
  install_dir: string;
  version: { noj_cli: string; noj_server: string };
  env: Record<string, string>;
  components: Record<string, ComponentConfig>;
  reverse_proxy: ReverseProxyConfig;
}

/** 敏感配置（对应 noj-secrets.json，权限 600）。 */
export interface SecretsConfig {
  schema_version: number;
  created_at: string;
  updated_at: string;
  secrets: Record<string, string>;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/config/types_test.ts`
Expected: PASS。

- [ ] **Step 5: 运行 check**

Run: `cd noj-cli && deno task check`
Expected: 通过。

- [ ] **Step 6: 提交本任务**

```bash
jj split noj-cli/src/config/types.ts noj-cli/src/config/types_test.ts
jj describe -m "feat(cli): 定义部署/组件/密钥/状态配置类型"
```

---

### Task 3: 状态机 `src/state/machine.ts`

**Files:**
- Create: `noj-cli/src/state/machine.ts`
- Create: `noj-cli/src/state/machine_test.ts`

**Interfaces:**
- Consumes: `type DeployState`（来自 `src/config/types.ts`，Task 2）。
- Produces：
  - `export type DeployAction = "init" | "up" | "down" | "restart" | "reset"`
  - `export interface TransitionResult { state: DeployState; changed: boolean; message: string }`
  - `export function transition(state: DeployState, action: DeployAction): TransitionResult`
  - 转换规则（与设计文档一致）：
    - `init`：任意状态 → `stopped`（`changed: true`）。
    - `up`：`running` → no-op（`changed: false`）；`stopped` / `partial` / `error` → `running`（`changed: true`）。
    - `down`：`stopped` → no-op；`running` / `partial` / `error` → `stopped`。
    - `restart`：`running` / `partial` → `running`；`stopped` → `running`；`error` → `running`（本计划把 restart 抽象为「最终进入 running」）。
    - `reset`：任意 → `stopped`（`--include-deploy-configs` 的 `uninitialized` 归到后续计划，P0 只返回 `stopped`）。

- [ ] **Step 1: 写失败测试**

创建 `noj-cli/src/state/machine_test.ts`：

```ts
import { assertEquals } from "@std/assert";
import { transition } from "./machine.ts";

Deno.test("init: 任意状态进入 stopped", () => {
  for (const s of ["uninitialized", "stopped", "running", "partial", "error"] as const) {
    const r = transition(s, "init");
    assertEquals(r.state, "stopped");
    assertEquals(r.changed, true);
  }
});

Deno.test("up: running 是 no-op", () => {
  const r = transition("running", "up");
  assertEquals(r.state, "running");
  assertEquals(r.changed, false);
});

Deno.test("up: stopped/partial/error 进入 running", () => {
  for (const s of ["stopped", "partial", "error"] as const) {
    const r = transition(s, "up");
    assertEquals(r.state, "running");
    assertEquals(r.changed, true);
  }
});

Deno.test("down: stopped 是 no-op", () => {
  const r = transition("stopped", "down");
  assertEquals(r.state, "stopped");
  assertEquals(r.changed, false);
});

Deno.test("down: running/partial/error 进入 stopped", () => {
  for (const s of ["running", "partial", "error"] as const) {
    const r = transition(s, "down");
    assertEquals(r.state, "stopped");
    assertEquals(r.changed, true);
  }
});

Deno.test("restart: 任意状态最终进入 running", () => {
  for (const s of ["stopped", "running", "partial", "error"] as const) {
    const r = transition(s, "restart");
    assertEquals(r.state, "running");
    assertEquals(r.changed, true);
  }
});

Deno.test("reset: 任意状态进入 stopped", () => {
  for (const s of ["uninitialized", "stopped", "running", "partial", "error"] as const) {
    const r = transition(s, "reset");
    assertEquals(r.state, "stopped");
    assertEquals(r.changed, true);
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/state/machine_test.ts`
Expected: FAIL，`Error: Cannot find module .../machine.ts`。

- [ ] **Step 3: 实现 `src/state/machine.ts`**

```ts
import type { DeployState } from "../config/types.ts";

export type DeployAction = "init" | "up" | "down" | "restart" | "reset";

export interface TransitionResult {
  state: DeployState;
  /** 状态是否发生变化；false 表示 no-op（如 running 时再 up）。 */
  changed: boolean;
  message: string;
}

const NO_OP_MSG: Record<string, string> = {
  up: "已处于 running，无需重复启动",
  down: "已处于 stopped，无需重复关闭",
};

export function transition(
  state: DeployState,
  action: DeployAction,
): TransitionResult {
  let next: DeployState;
  let changed = true;

  switch (action) {
    case "init":
      next = "stopped";
      break;
    case "up":
      if (state === "running") {
        next = "running";
        changed = false;
      } else {
        next = "running";
      }
      break;
    case "down":
      if (state === "stopped") {
        next = "stopped";
        changed = false;
      } else {
        next = "stopped";
      }
      break;
    case "restart":
      next = "running";
      break;
    case "reset":
      next = "stopped";
      break;
  }

  return {
    state: next,
    changed,
    message: changed
      ? `状态从 ${state} 转换为 ${next}`
      : (NO_OP_MSG[action] ?? `状态保持 ${next}`),
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/state/machine_test.ts`
Expected: PASS。

- [ ] **Step 5: 提交本任务**

```bash
jj split noj-cli/src/state/machine.ts noj-cli/src/state/machine_test.ts
jj describe -m "feat(cli): 实现部署状态机 transition 纯函数"
```

---

### Task 4: 配置加载与保存 `src/config/load.ts` + `src/config/save.ts`

**Files:**
- Create: `noj-cli/src/config/io.ts`（共享：权限常量 + 目录判定工具）
- Create: `noj-cli/src/config/load.ts`
- Create: `noj-cli/src/config/save.ts`
- Create: `noj-cli/src/config/load_test.ts`
- Create: `noj-cli/src/config/save_test.ts`

**Interfaces:**
- Consumes: `type DeployConfig`、`type DeployState`、`type ComponentConfig`、`type SecretsConfig`（Task 2）。
- Produces：
  - `const DEPLOY_FILE = "noj-deploy.json"`、`const SECRETS_FILE = "noj-secrets.json"`（在 `io.ts` 导出，供后续计划与 `findDeployDir` 复用）
  - `async function loadDeployment(dir: string): Promise<{ config: DeployConfig; secrets: SecretsConfig }>`（读两个 JSON；缺失时 `throw`）
  - `async function saveDeployment(dir: string, config: DeployConfig, secrets: SecretsConfig): Promise<void>`（先写临时文件再 rename，落盘前设置权限：deploy 644 / secrets 600；返回前更新 `updated_at`）
  - `export function updateUpdatedAt(config: DeployConfig): void`（把 `config.updated_at` 置为当前 UTC ISO 时间）

- [ ] **Step 1: 实现共享 `src/config/io.ts`（含先写测试）**

创建 `noj-cli/src/config/io_test.ts`：

```ts
import { assertEquals } from "@std/assert";
import { DEPLOY_FILE, SECRETS_FILE, DEPLOY_FILE_MODE, SECRETS_FILE_MODE } from "./io.ts";

Deno.test("文件命名与权限常量", () => {
  assertEquals(DEPLOY_FILE, "noj-deploy.json");
  assertEquals(SECRETS_FILE, "noj-secrets.json");
  assertEquals(DEPLOY_FILE_MODE, 0o644);
  assertEquals(SECRETS_FILE_MODE, 0o600);
});
```

运行失败：`cd noj-cli && deno test -A src/config/io_test.ts` → FAIL（模块不存在）。

实现 `noj-cli/src/config/io.ts`：

```ts
/** 非敏感部署元数据文件名。 */
export const DEPLOY_FILE = "noj-deploy.json";
/** 敏感密钥文件名。 */
export const SECRETS_FILE = "noj-secrets.json";
/** noj-deploy.json 权限：644。 */
export const DEPLOY_FILE_MODE = 0o644;
/** noj-secrets.json 权限：600。 */
export const SECRETS_FILE_MODE = 0o600;
```

运行通过：`cd noj-cli && deno test -A src/config/io_test.ts` → PASS。

- [ ] **Step 2: 写 load 失败测试**

创建 `noj-cli/src/config/load_test.ts`：

```ts
import { assertRejects } from "@std/assert";
import { assertEquals } from "@std/assert";
import type { DeployConfig, SecretsConfig } from "./types.ts";
import { loadDeployment } from "./load.ts";
import { SCHEMA_VERSION } from "./types.ts";

const TMP = await Deno.makeTempDir();

function sampleConfig(): DeployConfig {
  return {
    schema_version: SCHEMA_VERSION,
    type: "prod",
    state: "stopped",
    created_at: "2026-08-31T00:00:00Z",
    updated_at: "2026-08-31T00:00:00Z",
    install_dir: "/opt/neuro-oj",
    version: { noj_cli: "0.1.0", noj_server: "0.1.0" },
    env: {},
    components: {},
    reverse_proxy: { type: "nginx", config_dir: "/etc/nginx/conf.d", domain: "oj.example.com", upstream_port: 8080 },
  };
}

function sampleSecrets(): SecretsConfig {
  return {
    schema_version: SCHEMA_VERSION,
    created_at: "2026-08-31T00:00:00Z",
    updated_at: "2026-08-31T00:00:00Z",
    secrets: { "POSTGRES_PASSWORD": "secret" },
  };
}

Deno.test("loadDeployment 在文件缺失时抛错", async () => {
  const dir = await Deno.makeTempDir();
  await assertRejects(() => loadDeployment(dir), Error, /noj-deploy\.json/);
});

Deno.test("loadDeployment 读取两个 JSON 并解析类型", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${dir}/noj-deploy.json`, JSON.stringify(sampleConfig(), null, 2));
  await Deno.writeTextFile(`${dir}/noj-secrets.json`, JSON.stringify(sampleSecrets(), null, 2));
  const { config, secrets } = await loadDeployment(dir);
  assertEquals(config.schema_version, SCHEMA_VERSION);
  assertEquals(config.state, "stopped");
  assertEquals(secrets.secrets["POSTGRES_PASSWORD"], "secret");
});
```

- [ ] **Step 3: 运行 load 测试确认失败**

Run: `cd noj-cli && deno test -A src/config/load_test.ts`
Expected: FAIL，`Cannot find module .../load.ts`。

- [ ] **Step 4: 实现 `src/config/load.ts`**

```ts
import type { DeployConfig, SecretsConfig } from "./types.ts";
import { DEPLOY_FILE, SECRETS_FILE } from "./io.ts";

/** 从目录读取部署配置与密钥；任一文件缺失/损坏即抛错。 */
export async function loadDeployment(
  dir: string,
): Promise<{ config: DeployConfig; secrets: SecretsConfig }> {
  const deployPath = `${dir}/${DEPLOY_FILE}`;
  const secretsPath = `${dir}/${SECRETS_FILE}`;

  const rawDeploy = await Deno.readTextFile(deployPath).catch((e) => {
    throw new Error(`无法读取部署配置 ${deployPath}: ${e.message}`);
  });
  const rawSecrets = await Deno.readTextFile(secretsPath).catch((e) => {
    throw new Error(`无法读取密钥配置 ${secretsPath}: ${e.message}`);
  });

  const config = JSON.parse(rawDeploy) as DeployConfig;
  const secrets = JSON.parse(rawSecrets) as SecretsConfig;
  return { config, secrets };
}
```

- [ ] **Step 5: 运行 load 测试确认通过**

Run: `cd noj-cli && deno test -A src/config/load_test.ts`
Expected: PASS。

- [ ] **Step 6: 写 save 失败测试**

创建 `noj-cli/src/config/save_test.ts`：

```ts
import { assertEquals } from "@std/assert";
import type { DeployConfig, SecretsConfig } from "./types.ts";
import { saveDeployment } from "./save.ts";
import { DEPLOY_FILE_MODE, SECRETS_FILE_MODE } from "./io.ts";

const config: DeployConfig = {
  schema_version: 1,
  type: "prod",
  state: "stopped",
  created_at: "2026-08-31T00:00:00Z",
  updated_at: "2026-08-31T00:00:00Z",
  install_dir: "/opt/neuro-oj",
  version: { noj_cli: "0.1.0", noj_server: "0.1.0" },
  env: {},
  components: {},
  reverse_proxy: { type: "nginx", config_dir: "/etc/nginx/conf.d", domain: "oj.example.com", upstream_port: 8080 },
};

const secrets: SecretsConfig = {
  schema_version: 1,
  created_at: "2026-08-31T00:00:00Z",
  updated_at: "2026-08-31T00:00:00Z",
  secrets: { "POSTGRES_PASSWORD": "secret" },
};

Deno.test("saveDeployment 写出两个文件并设置权限", async () => {
  const dir = await Deno.makeTempDir();
  await saveDeployment(dir, config, secrets);

  const deployStat = await Deno.stat(`${dir}/noj-deploy.json`);
  const secretsStat = await Deno.stat(`${dir}/noj-secrets.json`);
  assertEquals(deployStat.mode! & 0o777, DEPLOY_FILE_MODE);
  assertEquals(secretsStat.mode! & 0o777, SECRETS_FILE_MODE);

  const written = JSON.parse(await Deno.readTextFile(`${dir}/noj-deploy.json`)) as DeployConfig;
  assertEquals(written.type, "prod");
  const writtenSecrets = JSON.parse(await Deno.readTextFile(`${dir}/noj-secrets.json`)) as SecretsConfig;
  assertEquals(writtenSecrets.secrets["POSTGRES_PASSWORD"], "secret");
});

Deno.test("saveDeployment 更新 updated_at 为 UTC ISO", async () => {
  const dir = await Deno.makeTempDir();
  const cfg = structuredClone(config);
  cfg.updated_at = "1970-01-01T00:00:00Z";
  await saveDeployment(dir, cfg, secrets);
  const written = JSON.parse(await Deno.readTextFile(`${dir}/noj-deploy.json`)) as DeployConfig;
  assertEquals(new Date(written.updated_at).toISOString(), written.updated_at);
  assertEquals(written.updated_at.endsWith("Z"), true);
});
```

- [ ] **Step 7: 运行 save 测试确认失败**

Run: `cd noj-cli && deno test -A src/config/save_test.ts`
Expected: FAIL，`Cannot find module .../save.ts`。

- [ ] **Step 8: 实现 `src/config/save.ts`**

```ts
import type { DeployConfig, SecretsConfig } from "./types.ts";
import { DEPLOY_FILE, SECRETS_FILE, DEPLOY_FILE_MODE, SECRETS_FILE_MODE } from "./io.ts";

async function atomicWrite(path: string, data: string, mode: number): Promise<void> {
  const tmp = `${path}.tmp-${Deno.pid}-${crypto.randomUUID()}`;
  await Deno.writeTextFile(tmp, data);
  await Deno.chmod(tmp, mode);
  await Deno.rename(tmp, path);
}

function utcNow(): string {
  return new Date().toISOString();
}

/** 将部署配置与密钥原子写入目录，并设置权限（deploy 644 / secrets 600）。 */
export async function saveDeployment(
  dir: string,
  config: DeployConfig,
  secrets: SecretsConfig,
): Promise<void> {
  const cfg = structuredClone(config);
  cfg.updated_at = utcNow();
  const sec = structuredClone(secrets);
  sec.updated_at = utcNow();

  await atomicWrite(`${dir}/${DEPLOY_FILE}`, JSON.stringify(cfg, null, 2) + "\n", DEPLOY_FILE_MODE);
  await atomicWrite(`${dir}/${SECRETS_FILE}`, JSON.stringify(sec, null, 2) + "\n", SECRETS_FILE_MODE);
}
```

- [ ] **Step 9: 运行 save 测试确认通过**

Run: `cd noj-cli && deno test -A src/config/save_test.ts`
Expected: PASS。

- [ ] **Step 10: 运行全量测试与 check**

Run: `cd noj-cli && deno task test && deno task check`
Expected: 全部 PASS。

- [ ] **Step 11: 提交本任务**

```bash
jj split noj-cli/src/config/io.ts noj-cli/src/config/io_test.ts \
  noj-cli/src/config/load.ts noj-cli/src/config/load_test.ts \
  noj-cli/src/config/save.ts noj-cli/src/config/save_test.ts
jj describe -m "feat(cli): 实现部署配置读写（load/save）与文件权限"
```

---

### Task 5: 配置校验 `src/config/validate.ts`

**Files:**
- Create: `noj-cli/src/config/validate.ts`
- Create: `noj-cli/src/config/validate_test.ts`

**Interfaces:**
- Consumes: `type DeployConfig`、`type SecretsConfig`、`SCHEMA_VERSION`（Task 2）。
- Produces：
  - `export interface ValidationIssue { path: string; message: string }`
  - `export function validateConfig(config: DeployConfig, secrets: SecretsConfig): ValidationIssue[]`
  - 校验规则（P0 子集，覆盖设计文档"配置校验补齐"中的可纯函数部分）：
    - `schema_version` 必须为 `SCHEMA_VERSION`（1）
    - 必须有 `env` 与 `components`
    - 每个组件必须有 `enabled`、`method`
    - `JWT_SECRET`、`TFA_ENCRYPTION_KEY` 若被组件 env 引用（`${KEY}`），则 secrets 中对应 key 必须存在且长度 ≥ 32
    - 无违规返回 `[]`

- [ ] **Step 1: 写失败测试**

创建 `noj-cli/src/config/validate_test.ts`：

```ts
import { assertEquals } from "@std/assert";
import type { DeployConfig, SecretsConfig } from "./types.ts";
import { validateConfig } from "./validate.ts";
import { SCHEMA_VERSION } from "./types.ts";

function baseConfig(): DeployConfig {
  return {
    schema_version: SCHEMA_VERSION,
    type: "prod",
    state: "stopped",
    created_at: "2026-08-31T00:00:00Z",
    updated_at: "2026-08-31T00:00:00Z",
    install_dir: "/opt/neuro-oj",
    version: { noj_cli: "0.1.0", noj_server: "0.1.0" },
    env: {},
    components: {
      server: { enabled: true, method: "docker", env: { "JWT_SECRET": "${JWT_SECRET}" } },
    },
    reverse_proxy: { type: "nginx", config_dir: "/etc/nginx/conf.d", domain: "oj.example.com", upstream_port: 8080 },
  };
}

function baseSecrets(): SecretsConfig {
  return {
    schema_version: SCHEMA_VERSION,
    created_at: "2026-08-31T00:00:00Z",
    updated_at: "2026-08-31T00:00:00Z",
    secrets: { "JWT_SECRET": "x".repeat(32) },
  };
}

Deno.test("合法配置无问题", () => {
  assertEquals(validateConfig(baseConfig(), baseSecrets()), []);
});

Deno.test("schema_version 错误时报告", () => {
  const cfg = baseConfig();
  cfg.schema_version = 2;
  const issues = validateConfig(cfg, baseSecrets());
  assertEquals(issues.some((i) => i.path === "schema_version"), true);
});

Deno.test("被引用 secret 缺失时报告", () => {
  const cfg = baseConfig();
  cfg.components["server"]!.env["TFA_ENCRYPTION_KEY"] = "${TFA_ENCRYPTION_KEY}";
  const issues = validateConfig(cfg, baseSecrets());
  assertEquals(issues.some((i) => i.path.includes("TFA_ENCRYPTION_KEY")), true);
});

Deno.test("secret 长度不足 32 时报告", () => {
  const secrets = baseSecrets();
  secrets.secrets["JWT_SECRET"] = "short";
  const issues = validateConfig(cfgForShort(), secrets);
  assertEquals(issues.some((i) => i.path.includes("JWT_SECRET")), true);

  function cfgForShort(): DeployConfig {
    const c = baseConfig();
    c.components["server"]!.env["JWT_SECRET"] = "${JWT_SECRET}";
    return c;
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/config/validate_test.ts`
Expected: FAIL，`Cannot find module .../validate.ts`。

- [ ] **Step 3: 实现 `src/config/validate.ts`**

```ts
import type { DeployConfig, SecretsConfig } from "./types.ts";
import { SCHEMA_VERSION } from "./types.ts";

export interface ValidationIssue {
  path: string;
  message: string;
}

/** 提取字符串中所有 ${KEY} 占位符引用的 key。 */
function referencedKeys(env: Record<string, string>): string[] {
  const keys = new Set<string>();
  for (const value of Object.values(env)) {
    for (const m of value.matchAll(/\$\{([A-Z0-9_]+)\}/g)) {
      keys.add(m[1]);
    }
  }
  return [...keys];
}

/** 校验敏感项：被引用的 secret 必须存在且（对 JWT/TFA）长度 ≥ 32。 */
function validateSecrets(
  cfg: DeployConfig,
  secrets: SecretsConfig,
  issues: ValidationIssue[],
): void {
  const longKeys = new Set(["JWT_SECRET", "TFA_ENCRYPTION_KEY"]);
  for (const [comp, compCfg] of Object.entries(cfg.components)) {
    if (!compCfg.enabled) continue;
    for (const key of referencedKeys(compCfg.env)) {
      const value = secrets.secrets[key];
      if (value === undefined) {
        issues.push({
          path: `components.${comp}.env.${key}`,
          message: `组件 ${comp} 引用了缺失的 secret ${key}`,
        });
        continue;
      }
      if (longKeys.has(key) && value.length < 32) {
        issues.push({
          path: `secrets.${key}`,
          message: `secret ${key} 长度不足 32，当前 ${value.length}`,
        });
      }
    }
  }
}

/** 校验部署配置与密钥；返回问题列表，合法时为空数组。 */
export function validateConfig(
  config: DeployConfig,
  secrets: SecretsConfig,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (config.schema_version !== SCHEMA_VERSION) {
    issues.push({
      path: "schema_version",
      message: `期望 ${SCHEMA_VERSION}，实际 ${config.schema_version}`,
    });
  }
  if (config.env === undefined) {
    issues.push({ path: "env", message: "缺少 env 字段" });
  }
  if (config.components === undefined || typeof config.components !== "object") {
    issues.push({ path: "components", message: "缺少 components 字段" });
  } else {
    for (const [name, comp] of Object.entries(config.components)) {
      if (typeof comp.enabled !== "boolean") {
        issues.push({ path: `components.${name}.enabled`, message: "enabled 必须为布尔值" });
      }
      if (comp.method !== "docker" && comp.method !== "process") {
        issues.push({ path: `components.${name}.method`, message: "method 必须为 docker 或 process" });
      }
    }
  }

  validateSecrets(config, secrets, issues);
  return issues;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/config/validate_test.ts`
Expected: PASS。

- [ ] **Step 5: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj split noj-cli/src/config/validate.ts noj-cli/src/config/validate_test.ts
jj describe -m "feat(cli): 实现配置与密钥校验 validateConfig"
```

---

### Task 6: 环境变量合并 `src/config/merge.ts`

**Files:**
- Create: `noj-cli/src/config/merge.ts`
- Create: `noj-cli/src/config/merge_test.ts`

**Interfaces:**
- Consumes: `type DeployConfig`、`type SecretsConfig`、`type ComponentConfig`（Task 2）。
- Produces：
  - `export function resolveComponentEnv(config: DeployConfig, secrets: SecretsConfig, componentName: string): Record<string, string>`
  - 语义：返回 `component.env` 与顶层 `config.env` 合并后的结果（组件覆盖全局），并解析 `${KEY}` 占位符；KEY 来自（全局 env + secrets），全局 env 优先于 secrets；未被替换的占位符保留原样。
  - 若 `componentName` 不存在，抛 `Error`。

- [ ] **Step 1: 写失败测试**

创建 `noj-cli/src/config/merge_test.ts`：

```ts
import { assertEquals, assertRejects } from "@std/assert";
import type { DeployConfig, SecretsConfig } from "./types.ts";
import { resolveComponentEnv } from "./merge.ts";
import { SCHEMA_VERSION } from "./types.ts";

const config: DeployConfig = {
  schema_version: SCHEMA_VERSION,
  type: "prod",
  state: "stopped",
  created_at: "2026-08-31T00:00:00Z",
  updated_at: "2026-08-31T00:00:00Z",
  install_dir: "/opt/neuro-oj",
  version: { noj_cli: "0.1.0", noj_server: "0.1.0" },
  env: { "LOG_LEVEL": "info", "PORT": "8000" },
  components: {
    server: {
      enabled: true,
      method: "docker",
      env: {
        "PORT": "9000",
        "DATABASE_URL": "postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres/${POSTGRES_DB}",
        "JWT_SECRET": "${JWT_SECRET}",
      },
    },
  },
  reverse_proxy: { type: "nginx", config_dir: "/etc/nginx/conf.d", domain: "oj.example.com", upstream_port: 8080 },
};

const secrets: SecretsConfig = {
  schema_version: SCHEMA_VERSION,
  created_at: "2026-08-31T00:00:00Z",
  updated_at: "2026-08-31T00:00:00Z",
  secrets: {
    "POSTGRES_PASSWORD": "pw",
    "POSTGRES_DB": "nojdb",
    "JWT_SECRET": "x".repeat(32),
  },
};

Deno.test("组件 env 覆盖全局 env", () => {
  const env = resolveComponentEnv(config, secrets, "server");
  assertEquals(env["PORT"], "9000"); // 组件覆盖全局
  assertEquals(env["LOG_LEVEL"], "info"); // 全局保留
});

Deno.test("占位符从 secrets 解析", () => {
  const env = resolveComponentEnv(config, secrets, "server");
  assertEquals(env["DATABASE_URL"], "postgres://noj:pw@postgres/nojdb");
  assertEquals(env["JWT_SECRET"], "x".repeat(32));
});

Deno.test("未知组件抛错", async () => {
  await assertRejects(
    async () => resolveComponentEnv(config, secrets, "nonexistent"),
    Error,
    /组件.*不存在/,
  );
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/config/merge_test.ts`
Expected: FAIL，`Cannot find module .../merge.ts`。

- [ ] **Step 3: 实现 `src/config/merge.ts`**

```ts
import type { DeployConfig, SecretsConfig } from "./types.ts";

/**
 * 解析组件最终环境变量：
 * 最终 env = 全局 env + 组件 env（组件覆盖全局），
 * 组件 env 中的 ${KEY} 从（全局 env → secrets）依次解析。
 */
export function resolveComponentEnv(
  config: DeployConfig,
  secrets: SecretsConfig,
  componentName: string,
): Record<string, string> {
  const component = config.components[componentName];
  if (component === undefined) {
    throw new Error(`组件 ${componentName} 不存在`);
  }

  // 合并：先全局后组件，组件覆盖全局。
  const merged: Record<string, string> = { ...config.env, ...component.env };

  // 解析占位符：KEY 优先取全局 env，其次取 secrets。
  const lookup = (key: string): string | undefined =>
    config.env[key] ?? secrets.secrets[key];

  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) {
    out[k] = v.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, key: string) => {
      const val = lookup(key);
      return val === undefined ? `\${${key}}` : val;
    });
  }
  return out;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/config/merge_test.ts`
Expected: PASS。

- [ ] **Step 5: 提交本任务**

```bash
jj split noj-cli/src/config/merge.ts noj-cli/src/config/merge_test.ts
jj describe -m "feat(cli): 实现组件环境变量合并 resolveComponentEnv"
```

---

### Task 7: 部署目录查找 `src/util/find_deploy_dir.ts`

**Files:**
- Create: `noj-cli/src/util/find_deploy_dir.ts`
- Create: `noj-cli/src/util/find_deploy_dir_test.ts`

**Interfaces:**
- Consumes: `DEPLOY_FILE` 常量（来自 `src/config/io.ts`，Task 4）。
- Produces：
  - `export function findDeployDir(start?: string): string | null`
  - 行为：从 `start`（缺省为当前工作目录）向上逐级查找包含 `noj-deploy.json` 的目录；找到返回该目录绝对路径；到文件系统根仍未找到返回 `null`。

- [ ] **Step 1: 写失败测试**

创建 `noj-cli/src/util/find_deploy_dir_test.ts`：

```ts
import { assertEquals } from "@std/assert";
import { findDeployDir } from "./find_deploy_dir.ts";

Deno.test("从子目录向上找到含 noj-deploy.json 的父目录", async () => {
  const dir = await Deno.makeTempDir();
  const nested = `${dir}/a/b/c`;
  await Deno.mkdir(nested, { recursive: true });
  await Deno.writeTextFile(`${dir}/noj-deploy.json`, "{}");
  assertEquals(findDeployDir(nested), dir);
});

Deno.test("目录内直接存在 noj-deploy.json 时返回该目录", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${dir}/noj-deploy.json`, "{}");
  assertEquals(findDeployDir(dir), dir);
});

Deno.test("向上找不到时返回 null", async () => {
  const dir = await Deno.makeTempDir();
  assertEquals(findDeployDir(dir), null);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/util/find_deploy_dir_test.ts`
Expected: FAIL，`Cannot find module .../find_deploy_dir.ts`。

- [ ] **Step 3: 实现 `src/util/find_deploy_dir.ts`**

```ts
import { DEPLOY_FILE } from "../config/io.ts";

/** 从 start（缺省当前工作目录）向上查找含 noj-deploy.json 的目录；找到返回绝对路径，否则 null。 */
export function findDeployDir(start?: string): string | null {
  let current = start ?? Deno.cwd();
  current = Deno.realPathSync(current);

  while (true) {
    try {
      Deno.statSync(`${current}/${DEPLOY_FILE}`);
      return current;
    } catch {
      // 无该文件，继续向上。
    }
    const parent = Deno.dirname(current);
    if (parent === null || parent === current) return null;
    current = parent;
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno task test`
Expected: 全部 PASS。

- [ ] **Step 5: 提交本任务**

```bash
jj split noj-cli/src/util/find_deploy_dir.ts noj-cli/src/util/find_deploy_dir_test.ts
jj describe -m "feat(cli): 实现部署目录向上查找 findDeployDir"
```

---

### Task 8: CLI 命令分发 `src/cli.ts`

**Files:**
- Create: `noj-cli/src/cli.ts`
- Create: `noj-cli/src/cli_test.ts`

**Interfaces:**
- Consumes: `Dep.ExitCode` 无；`findDeployDir`（Task 7，供 `deploy` stub 展示定位）；`VERSION`（Task 1）。
- Produces：
  - `export interface CommandContext { cwd: string; deployDir: string | null }`
  - `export async function run(argv: string[]): Promise<number>`（解析并分发，返回进程退出码；`help`/`--help`/未知命令返回 0 或 1 见下）
  - `export function printHelp(): string`
  - `export function dispatchCommand(command: string, args: string[], ctx: CommandContext): Promise<number>`（每个命令的 stub 处理函数，供测试直接调用）
  - 命令树 stub 映射：`doctor`、`deploy`、`maintain`、`run-server`、`version`，以及子命令 `init/up/down/restart/status`、`logs/backup/restore/verify/reset/config`。
  - 行为：`version` 打印 `noj-cli 0.1.0`；其余 stub 打印占位消息并返回 `0`；未知命令打印错误到 stderr 并返回 `1`。
  - 若 `argv[0]` 为 `--help`/`-h`/`help`，打印帮助并返回 `0`。

- [ ] **Step 1: 写失败测试**

创建 `noj-cli/src/cli_test.ts`：

```ts
import { assertEquals } from "@std/assert";
import { dispatchCommand, printHelp, run } from "./cli.ts";
import type { CommandContext } from "./cli.ts";

const ctx: CommandContext = { cwd: "/tmp", deployDir: null };

Deno.test("printHelp 包含全部顶层命令", () => {
  const help = printHelp();
  for (const c of ["doctor", "deploy", "maintain", "run-server", "version"]) {
    assertEquals(help.includes(c), true, `help 应包含 ${c}`);
  }
});

Deno.test("version stub 返回 0", async () => {
  assertEquals(await dispatchCommand("version", [], ctx), 0);
});

Deno.test("doctor/deploy/maintain/run-server stub 返回 0", async () => {
  assertEquals(await dispatchCommand("doctor", [], ctx), 0);
  assertEquals(await dispatchCommand("deploy", [], ctx), 0);
  assertEquals(await dispatchCommand("maintain", [], ctx), 0);
  assertEquals(await dispatchCommand("run-server", [], ctx), 0);
});

Deno.test("deploy 子命令 init/up/down/restart/status 返回 0", async () => {
  for (const sub of ["init", "up", "down", "restart", "status"]) {
    assertEquals(await dispatchCommand("deploy", [sub], ctx), 0, `deploy ${sub}`);
  }
});

Deno.test("maintain 子命令返回 0", async () => {
  for (const sub of ["logs", "backup", "restore", "verify", "reset", "config"]) {
    assertEquals(await dispatchCommand("maintain", [sub], ctx), 0, `maintain ${sub}`);
  }
});

Deno.test("未知命令返回 1", async () => {
  assertEquals(await dispatchCommand("bogus", [], ctx), 1);
});

Deno.test("run 识别 --help 返回 0", async () => {
  assertEquals(await run(["--help"]), 0);
});

Deno.test("run 识别 version 返回 0", async () => {
  assertEquals(await run(["version"]), 0);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/cli_test.ts`
Expected: FAIL，`Cannot find module .../cli.ts`。

- [ ] **Step 3: 实现 `src/cli.ts`**

```ts
import { findDeployDir } from "./util/find_deploy_dir.ts";
import { VERSION } from "./mod.ts";

/** CLI 执行上下文，供各子命令共享。 */
export interface CommandContext {
  cwd: string;
  /** 向上查找到的部署目录，找不到为 null。 */
  deployDir: string | null;
}

/** 顶层命令分发。返回进程退出码。 */
export async function run(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    console.log(printHelp());
    return 0;
  }

  const ctx: CommandContext = {
    cwd: Deno.cwd(),
    deployDir: findDeployDir(),
  };
  return await dispatchCommand(command, rest, ctx);
}

/** 生成帮助文本。 */
export function printHelp(): string {
  return [
    "noj-cli - Neuro OJ 统一部署与运维 CLI",
    "",
    "用法: noj-cli <命令> [子命令] [选项]",
    "",
    "命令:",
    "  doctor        环境检测（stub）",
    "  deploy        部署生命周期 init/up/down/restart/status（stub）",
    "  maintain      运维 logs/backup/restore/verify/reset/config（stub）",
    "  run-server    运行 noj-server（stub）",
    "  version       显示版本",
    "",
  ].join("\n");
}

const DEPLOY_SUBCOMMANDS = ["init", "up", "down", "restart", "status"];
const MAINTAIN_SUBCOMMANDS = ["logs", "backup", "restore", "verify", "reset", "config"];

const KNOWN_TOP = new Set(["doctor", "deploy", "maintain", "run-server", "version"]);

/** 将命令分发到对应 stub 处理函数。供测试与 run 共用。 */
export async function dispatchCommand(
  command: string,
  args: string[],
  ctx: CommandContext,
): Promise<number> {
  switch (command) {
    case "version":
      console.log(`noj-cli ${VERSION}`);
      return 0;
    case "doctor":
      console.log("doctor: 环境检测（P0 占位，逻辑留待后续计划）");
      return 0;
    case "deploy": {
      const sub = args[0] ?? "";
      if (DEPLOY_SUBCOMMANDS.includes(sub)) {
        console.log(`deploy ${sub}: 生命周期逻辑留待后续计划（部署目录: ${ctx.deployDir ?? "未找到"}）`);
      } else {
        console.log("deploy: 需要子命令 init/up/down/restart/status（P0 占位）");
      }
      return 0;
    }
    case "maintain": {
      const sub = args[0] ?? "";
      if (MAINTAIN_SUBCOMMANDS.includes(sub)) {
        console.log(`maintain ${sub}: 运维逻辑留待后续计划`);
      } else {
        console.log("maintain: 需要子命令 logs/backup/restore/verify/reset/config（P0 占位）");
      }
      return 0;
    }
    case "run-server":
      console.log("run-server: 运行 noj-server 逻辑留待后续计划");
      return 0;
    default:
      console.error(`未知命令: ${command}`);
      if (!KNOWN_TOP.has(command)) {
        console.error("运行 'noj-cli --help' 查看可用命令。");
      }
      return 1;
  }
}

// 直接执行时作为程序入口。
if (import.meta.main) {
  Deno.exit(await run(Deno.args));
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno task test`
Expected: 全部 PASS。

- [ ] **Step 5: 手动冒烟验证**

Run: `cd noj-cli && deno run -A src/cli.ts version`
Expected: 输出 `noj-cli 0.1.0`。

Run: `cd noj-cli && deno run -A src/cli.ts --help`
Expected: 打印帮助文本。

- [ ] **Step 6: 运行 check**

Run: `cd noj-cli && deno task check`
Expected: 通过。

- [ ] **Step 7: 提交本任务**

```bash
jj split noj-cli/src/cli.ts noj-cli/src/cli_test.ts
jj describe -m "feat(cli): 实现命令分发骨架（doctor/deploy/maintain/run-server/version）"
```

---

### Task 9: P0 收尾 —— 全量验证与导出入口

**Files:**
- Modify: `noj-cli/src/mod.ts`（导出 P0 公共接口）
- Create: `noj-cli/README.md`

**Interfaces:**
- Consumes: 全部 Task 1–8 的产物。
- Produces：`src/mod.ts` 作为项目公共导出面，供后续计划 import；`README.md` 说明 P0 范围与运行方式。

- [ ] **Step 1: 更新 `src/mod.ts` 聚合导出**

将 `noj-cli/src/mod.ts` 整体替换为：

```ts
/** noj-cli 版本号，与 deno.json 的 version 保持一致。 */
export const VERSION = "0.1.0";

// 配置模型
export * from "./config/types.ts";
export { loadDeployment } from "./config/load.ts";
export { saveDeployment } from "./config/save.ts";
export { validateConfig } from "./config/validate.ts";
export { resolveComponentEnv } from "./config/merge.ts";
export { DEPLOY_FILE, SECRETS_FILE, DEPLOY_FILE_MODE, SECRETS_FILE_MODE } from "./config/io.ts";

// 状态机与工具
export { transition } from "./state/machine.ts";
export type { DeployAction, TransitionResult } from "./state/machine.ts";
export { findDeployDir } from "./util/find_deploy_dir.ts";
```

- [ ] **Step 2: 验证导出的类型检查**

Run: `cd noj-cli && deno task check`
Expected: 通过。

- [ ] **Step 3: 全量测试**

Run: `cd noj-cli && deno task test`
Expected: 全部 PASS。

- [ ] **Step 4: 创建 `noj-cli/README.md`**

```markdown
# noj-cli

Neuro OJ 统一部署与运维 CLI（Deno + TypeScript，仅支持 linux/amd64）。

## 状态

P0 骨架：命令分发（doctor/deploy/maintain/run-server/version stub）、配置模型
（load/save/validate/merge）、状态机（transition）、部署目录查找（findDeployDir）。
具体业务命令（doctor 检测、init/up/logs/backup 等）留待后续计划。

## 运行

```bash
cd noj-cli
deno run -A src/cli.ts --help
deno run -A src/cli.ts version
```

## 测试

```bash
cd noj-cli
deno task test
deno task check
```

## 目录

- `src/cli.ts` 命令分发入口
- `src/config/` 配置模型（types/load/save/validate/merge/io）
- `src/state/machine.ts` 部署状态机
- `src/util/find_deploy_dir.ts` 部署目录查找
```

- [ ] **Step 5: 全量验证**

Run: `cd noj-cli && deno task test && deno task check`
Expected: 全部通过。

- [ ] **Step 6: 提交本任务**

```bash
jj split noj-cli/src/mod.ts noj-cli/README.md
jj describe -m "feat(cli): 聚合 P0 公共导出并补充项目说明"
```

---

## 自审清单

- **范围**：P0 只交付项目骨架、命令分发 stub、配置模型（types/load/save/validate/merge）、状态机 transition、findDeployDir 与单元测试；未实现任何具体业务命令（doctor 检测、init/up/logs/backup 等均留 stub）。
- **接口一致**：`loadDeployment(dir)`、`saveDeployment(dir, config, secrets)`、`resolveComponentEnv(config, secrets, componentName)`、`transition(state, action)`、`findDeployDir(start?)` 的签名与需求指定的 P0 公共接口逐字吻合，并在 `src/mod.ts` 聚合导出。
- **约束落实**：Deno + TypeScript；linux/amd64 约束在 Global Constraints 中声明；无第三方运行时依赖；不锁 `deno.lock`；测试经 `deno task test` / `deno task check` 运行；提交用 jj + 中文描述 + `feat(cli)` scope。
- **配置与状态**：schema_version=1、DeployState 五态、状态转换表、env 合并规则与设计文档一致。
- **每个任务** 都以 失败测试→跑失败→实现→跑通过→提交 的 bite-sized 步骤组织，且每个步骤给出真实代码或命令。
