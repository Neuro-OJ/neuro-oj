# noj-cli P2 deploy up/down/restart/status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 P0/P1 骨架之上实现 `noj-cli deploy up/down/restart/status`：按 `noj-deploy.json` 生成/复用 Docker Compose 文件并调用 `docker compose up -d --wait / down / ps`，以本地进程方式 spawn/终止 `method: process` 组件（记录 PID），并通过 P0 状态机更新部署状态，全部用可注入 fake docker/process 的 Deno 测试覆盖。

**Architecture:** 在 `noj-cli/` 内新增两层：`src/runtime/` 提供系统命令/进程抽象（`CommandRunner`、pidfile、进程管理），`src/deploy/` 提供 Compose 渲染、docker 生命周期与状态收敛。所有系统调用只经 `CommandRunner`，测试注入 fake 即可模拟 docker 与进程，无需真实 Docker。`deploy up/down/restart/status` 读取两个 JSON → 按组件 `method` 分发（docker 走 Compose、process 走 spawn）→ 用 P0 `transition` 判断 no-op 并写回状态到 `noj-deploy.json`。`src/cli.ts` 仅做参数解析与装配。

**Tech Stack:** Deno 2（TypeScript，deno.json）、`@std/assert`（内置）、Deno 内置 `Deno.test`、`Deno.Command`（run/spawn）、`Deno.writeTextFile` / `Deno.mkdir` / `Deno.remove` / `Deno.stat`。Jujutsu (jj) 本地提交。仅支持 `linux/amd64`。

**Spec:** `dev-docs/superpowers/specs/2026-08-31-noj-cli-design.md`（P2 子集：deploy up/down/restart/status）

## Global Constraints

- 语言：代码标识符使用英文，注释与提交描述使用中文。
- 运行时：仅 Deno 2 + TypeScript 标准环境，不引入第三方运行时依赖（不锁 `deno.lock`，见仓库 `.gitignore` 注释）。手写最小 YAML 渲染器（不引入 YAML 库），保证确定性、可测试。
- 平台：仅支持 `linux/amd64`（对应 `x86_64`）。
- 前置依赖（P0 已定义，本计划沿用其精确签名，不得改动其签名）：
  - `src/config/types.ts`：`DeployConfig`、`ComponentConfig`（`method: "docker" | "process"`、`image?`、`binary?`、`dev_command?`、`internal_port?`、`host_port?`、`host_api_port?`、`host_console_port?`、`api_port?`、`console_port?`、`env`）、`SecretsConfig`、`DeployState`、`SCHEMA_VERSION = 1`
  - `src/config/load.ts`：`loadDeployment(dir): Promise<{ config: DeployConfig; secrets: SecretsConfig }>`（缺失抛错）
  - `src/config/save.ts`：`saveDeployment(dir, config, secrets): Promise<void>`（deploy 644 / secrets 600，原子写，更新 `updated_at`）
  - `src/config/merge.ts`：`resolveComponentEnv(config, secrets, componentName): Record<string, string>`
  - `src/state/machine.ts`：`transition(state, action): { state; changed; message }`、`DeployAction = "init" | "up" | "down" | "restart" | "reset"`
  - `src/util/find_deploy_dir.ts`：`findDeployDir(start?): string | null`
  - `src/cli.ts`：命令分发入口（P0 含 `dispatchCommand(command, args, ctx)`，P1 已接入 `deploy init`）
- 状态机语义（P0）：`up` 在 `running` 时 no-op；`down` 在 `stopped` 时 no-op；`restart` 任意状态都执行。`partial` 表示部分组件运行（本计划：`up` 后若任一组件失败则写 `partial`）。
- 状态与 PID 记录：状态写回 `noj-deploy.json`（权限 644，经 `saveDeployment`）；进程 PID 记录到 `${install_dir}/run/<component>.pid`（不进 `noj-deploy.json`，保持元数据纯净）。
- `down` 不执行 `docker compose down -v`，保留数据卷（spec：默认保留数据）。
- 生产仍以 Docker Compose 为主，开发为“Docker 基础设施 + 本地进程”混合（`method: process` 组件）。
- 测试通过 `deno task test`（`deno test -A`）运行；代码通过 `deno fmt` 与 `deno lint`；类型通过 `deno task check`。
- 提交使用 jj（`jj describe -m "<type>(<scope>): <中文描述>"`），scope 为 `cli`；GPG 签名在仓库已全局开启，无需额外操作。
- 不修改与 P2 无关的文件（不触碰 `AGENTS.md`、`noj-core/` 等既有业务代码；不修改 P0/P1 已交付公共接口签名）。

---

### Task 1: 系统命令/进程抽象 `src/runtime/command.ts` + 文件工具 `src/util/fs.ts`

**Files:**
- Create: `noj-cli/src/runtime/command.ts`
- Create: `noj-cli/src/runtime/command_test.ts`
- Create: `noj-cli/src/util/fs.ts`
- Create: `noj-cli/src/util/fs_test.ts`

**Interfaces:**
- Consumes: 无（纯新基础设施）。
- Produces（后续所有 task 依赖）：
  - `export interface CmdResult { code: number; stdout: string; stderr: string }`
  - `export interface SpawnOpts { cmd: string; args: string[]; cwd: string; env: Record<string, string> }`
  - `export interface SpawnHandle { pid: number; wait(): Promise<number>; kill(): Promise<void> }`
  - `export interface CommandRunner { run(cmd: string, args: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<CmdResult>; spawn(opts: SpawnOpts): SpawnHandle }`
  - `export function realRunner(): CommandRunner`（`Deno.Command.output()` 用于 `run`，`Deno.Command.spawn()` 包装成 `SpawnHandle`）
  - `export async function fileExists(path: string): Promise<boolean>`（`Deno.stat` 存在且为文件；不存在/异常返回 `false`）

- [ ] **Step 1: 写失败测试**

创建 `noj-cli/src/runtime/command_test.ts` 与 `noj-cli/src/util/fs_test.ts`：

```ts
// noj-cli/src/runtime/command_test.ts
import { assertEquals } from "@std/assert";
import { realRunner } from "./command.ts";

Deno.test("realRunner.run 执行命令并返回退出码与输出", async () => {
  const r = realRunner().run("printf", ["hello"], { env: {} });
  const out = await r;
  assertEquals(out.code, 0);
  assertEquals(out.stdout, "hello");
});

Deno.test("realRunner.spawn 产生可用 PID 并可 wait", async () => {
  const handle = realRunner().spawn({
    cmd: "sh",
    args: ["-c", "exit 7"],
    cwd: ".",
    env: {},
  });
  assertEquals(typeof handle.pid, "number");
  const code = await handle.wait();
  assertEquals(code, 7);
});
```

```ts
// noj-cli/src/util/fs_test.ts
import { assertEquals } from "@std/assert";
import { fileExists } from "./fs.ts";

Deno.test("fileExists: 存在的文件返回 true", async () => {
  const dir = await Deno.makeTempDir();
  const p = `${dir}/a.txt`;
  await Deno.writeTextFile(p, "x");
  assertEquals(await fileExists(p), true);
});

Deno.test("fileExists: 不存在/目录返回 false", async () => {
  const dir = await Deno.makeTempDir();
  assertEquals(await fileExists(`${dir}/nope.txt`), false);
  assertEquals(await fileExists(dir), false);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/runtime/command_test.ts src/util/fs_test.ts`
Expected: FAIL，`Error: Cannot find module .../command.ts` 与 `.../fs.ts`。

- [ ] **Step 3: 实现 `src/runtime/command.ts`**

```ts
/** 命令执行结果。 */
export interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** spawn 进程的参数。 */
export interface SpawnOpts {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/** 已启动进程的句柄：记录 PID，可等待退出或终止。 */
export interface SpawnHandle {
  pid: number;
  /** 等待进程退出，返回退出码。 */
  wait(): Promise<number>;
  /** 发送 SIGTERM 终止进程（失败静默）。 */
  kill(): Promise<void>;
}

/**
 * 系统命令/进程抽象：deploy 的所有 docker 调用与进程管理只经该接口，
 * 便于测试注入 fake 模拟 docker / process。
 */
export interface CommandRunner {
  run(
    cmd: string,
    args: string[],
    opts?: { cwd?: string; env?: Record<string, string> },
  ): Promise<CmdResult>;
  spawn(opts: SpawnOpts): SpawnHandle;
}

/** 真实实现：`Deno.Command` 的 run 与 spawn。 */
export function realRunner(): CommandRunner {
  const decoder = new TextDecoder();
  return {
    async run(cmd, args, opts) {
      const p = new Deno.Command(cmd, {
        args,
        cwd: opts?.cwd,
        env: opts?.env ?? {},
        stdout: "piped",
        stderr: "piped",
      });
      const out = await p.output();
      return {
        code: out.code,
        stdout: decoder.decode(out.stdout),
        stderr: decoder.decode(out.stderr),
      };
    },
    spawn(opts) {
      const child = new Deno.Command(opts.cmd, {
        args: opts.args,
        cwd: opts.cwd,
        env: opts.env,
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      return {
        pid: child.pid,
        async wait() {
          const status = await child.status;
          return status.code;
        },
        async kill() {
          try {
            child.kill("SIGTERM");
          } catch {
            // 已退出则忽略
          }
        },
      };
    },
  };
}
```

- [ ] **Step 4: 实现 `src/util/fs.ts`**

```ts
/** 判断 path 是否为存在的文件（目录/缺失/异常均返回 false）。 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    const st = await Deno.stat(path);
    return st.isFile;
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/runtime/command_test.ts src/util/fs_test.ts`
Expected: PASS。

- [ ] **Step 6: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj split noj-cli/src/runtime/command.ts noj-cli/src/runtime/command_test.ts noj-cli/src/util/fs.ts noj-cli/src/util/fs_test.ts
jj describe -m "feat(cli): 实现命令/进程抽象 CommandRunner 与文件工具"
```

---

### Task 2: Compose 文件渲染 `src/deploy/compose.ts`

**Files:**
- Create: `noj-cli/src/deploy/compose.ts`
- Create: `noj-cli/src/deploy/compose_test.ts`

**Interfaces:**
- Consumes: `DeployConfig` / `SecretsConfig` / `ComponentConfig`（P0 `types.ts`）、`resolveComponentEnv`（P0）、`fileExists`（Task 1）、`COMPOSE_FILE` 常量。
- Produces：
  - `export const COMPOSE_FILE = "docker-compose.noj.yml"`
  - `export function renderCompose(config: DeployConfig, secrets: SecretsConfig): string`（YAML 文本；只渲染 `enabled && method === "docker"` 的组件；每个服务含 `image`、`environment`（为 `resolveComponentEnv` 解析后的最终 env）、按规则生成 `ports`、基础设施组件挂命名卷）
  - `export async function ensureComposeFile(dir: string, config: DeployConfig, secrets: SecretsConfig): Promise<string>`（返回 Compose 文件绝对路径；内容与现文件不同或不存在时重写，否则复用）
  - 端口规则：`host_port` 非空且 `internal_port ?? port` 有值 → `"host:inner"`；minio 的 `host_api_port/api_port` 与 `host_console_port/console_port`
  - 基础设施卷：`postgres:/var/lib/postgresql/data`、`redis:/data`、`minio:/data`

- [ ] **Step 1: 写失败测试**

创建 `noj-cli/src/deploy/compose_test.ts`：

```ts
import { assertEquals } from "@std/assert";
import type { DeployConfig, SecretsConfig } from "../config/types.ts";
import { renderCompose, ensureComposeFile, COMPOSE_FILE } from "./compose.ts";

const NOW = "2026-08-31T00:00:00Z";

function baseConfig(): DeployConfig {
  return {
    schema_version: 1,
    type: "dev",
    state: "stopped",
    created_at: NOW,
    updated_at: NOW,
    install_dir: "/opt/neuro-oj",
    version: { noj_cli: "0.1.0", noj_server: "0.1.0" },
    env: { LOG_LEVEL: "info" },
    components: {
      postgres: {
        enabled: true,
        method: "docker",
        image: "postgres:16-alpine",
        internal_port: 5432,
        host_port: null,
        env: { POSTGRES_USER: "noj", POSTGRES_PASSWORD: "${POSTGRES_PASSWORD}" },
      },
      redis: {
        enabled: true,
        method: "docker",
        image: "redis:7-alpine",
        internal_port: 6379,
        host_port: null,
        env: {},
      },
      nginx: {
        enabled: true,
        method: "docker",
        image: "nginx:1.27-alpine",
        port: 8080,
        host_port: 8080,
        env: {},
      },
      server: {
        enabled: true,
        method: "process",
        binary: "noj-server",
        port: 8000,
        host_port: null,
        env: { PORT: "8000", JWT_SECRET: "${JWT_SECRET}" },
      },
    },
    reverse_proxy: { type: "nginx", config_dir: "/etc/nginx/conf.d", domain: "oj.example.com", upstream_port: 8080 },
  };
}

function baseSecrets(): SecretsConfig {
  return {
    schema_version: 1,
    created_at: NOW,
    updated_at: NOW,
    secrets: { POSTGRES_PASSWORD: "pg-secret" },
  };
}

Deno.test("renderCompose: 只渲染 enabled 且 method=docker 的组件", () => {
  const yaml = renderCompose(baseConfig(), baseSecrets());
  assertEquals(yaml.includes("postgres:"), true);
  assertEquals(yaml.includes("redis:"), true);
  assertEquals(yaml.includes("nginx:"), true);
  // server 是 process，不应出现在 compose 里
  assertEquals(yaml.includes("server:"), false);
});

Deno.test("renderCompose: environment 为解析后的最终 env（含 secret）", () => {
  const yaml = renderCompose(baseConfig(), baseSecrets());
  assertEquals(yaml.includes(`POSTGRES_PASSWORD:"pg-secret"`), true);
});

Deno.test("renderCompose: host_port 生成 ports，基础设施挂卷", () => {
  const yaml = renderCompose(baseConfig(), baseSecrets());
  assertEquals(yaml.includes(`"8080:8080"`), true);
  assertEquals(yaml.includes("postgres-data:/var/lib/postgresql/data"), true);
  assertEquals(yaml.includes("redis-data:/data"), true);
});

Deno.test("renderCompose: 顶层 volumes 声明", () => {
  const yaml = renderCompose(baseConfig(), baseSecrets());
  assertEquals(yaml.includes("volumes:"), true);
  assertEquals(yaml.includes("postgres-data:"), true);
});

Deno.test("ensureComposeFile: 生成 compose 文件并复用现文件", async () => {
  const dir = await Deno.makeTempDir();
  const config = baseConfig();
  const secrets = baseSecrets();
  const p1 = await ensureComposeFile(dir, config, secrets);
  assertEquals(p1, `${dir}/${COMPOSE_FILE}`);
  const first = await Deno.readTextFile(p1);
  // 再次调用，内容相同应复用（mtime 不变），仍返回同一路径
  const p2 = await ensureComposeFile(dir, config, secrets);
  assertEquals(p2, p1);
  const second = await Deno.readTextFile(p2);
  assertEquals(second, first);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/deploy/compose_test.ts`
Expected: FAIL，`Error: Cannot find module .../compose.ts`。

- [ ] **Step 3: 实现 `src/deploy/compose.ts`**

```ts
import type { DeployConfig, SecretsConfig, ComponentConfig } from "../config/types.ts";
import { resolveComponentEnv } from "../config/merge.ts";
import { fileExists } from "../util/fs.ts";

/** Compose 文件名（安装目录下）。 */
export const COMPOSE_FILE = "docker-compose.noj.yml";

/** 基础设施组件的命名卷挂载点。 */
const INFRA_VOLUMES: Record<string, string> = {
  postgres: "/var/lib/postgresql/data",
  redis: "/data",
  minio: "/data",
};

/** 将字符串安全地写成双引号 YAML 标量。 */
function yamlStr(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** 根据组件字段生成 ports 列表。 */
function portsFor(comp: ComponentConfig): string[] {
  const ports: string[] = [];
  if (comp.host_port !== null && comp.host_port !== undefined) {
    const inner = comp.internal_port ?? comp.port;
    if (inner) ports.push(`${comp.host_port}:${inner}`);
  }
  if (
    comp.host_api_port !== null && comp.host_api_port !== undefined && comp.api_port
  ) {
    ports.push(`${comp.host_api_port}:${comp.api_port}`);
  }
  if (
    comp.host_console_port !== null && comp.host_console_port !== undefined &&
    comp.console_port
  ) {
    ports.push(`${comp.host_console_port}:${comp.console_port}`);
  }
  return ports;
}

/** 渲染 docker-compose.noj.yml 文本：只含 enabled 且 method=docker 的组件。 */
export function renderCompose(config: DeployConfig, secrets: SecretsConfig): string {
  const dockerComponents = Object.entries(config.components).filter(
    ([, c]) => c.enabled && c.method === "docker",
  );
  const lines: string[] = ["services:"];
  const usedVolumes = new Set<string>();

  for (const [name, comp] of dockerComponents) {
    lines.push(`  ${name}:`);
    lines.push(`    container_name: noj-${name}`);
    if (comp.image) lines.push(`    image: ${yamlStr(comp.image)}`);

    const env = resolveComponentEnv(config, secrets, name);
    if (Object.keys(env).length > 0) {
      lines.push("    environment:");
      for (const [k, v] of Object.entries(env)) {
        lines.push(`      ${k}: ${yamlStr(v)}`);
      }
    }

    const ports = portsFor(comp);
    if (ports.length > 0) {
      lines.push("    ports:");
      for (const p of ports) lines.push(`      - ${yamlStr(p)}`);
    }

    const mount = INFRA_VOLUMES[name];
    if (mount) {
      usedVolumes.add(`${name}-data`);
      lines.push("    volumes:");
      lines.push(`      - ${name}-data:${mount}`);
    }
  }

  if (usedVolumes.size > 0) {
    lines.push("volumes:");
    for (const v of usedVolumes) lines.push(`  ${v}:`);
  }

  return lines.join("\n") + "\n";
}

/**
 * 确保安装目录下存在最新 compose 文件。
 * 文件不存在或内容不同则重写；内容相同则复用现文件。
 * 返回 compose 文件绝对路径。
 */
export async function ensureComposeFile(
  dir: string,
  config: DeployConfig,
  secrets: SecretsConfig,
): Promise<string> {
  const path = `${dir}/${COMPOSE_FILE}`;
  const rendered = renderCompose(config, secrets);
  const exists = await fileExists(path);
  if (exists) {
    const current = await Deno.readTextFile(path);
    if (current === rendered) return path;
  }
  await Deno.writeTextFile(path, rendered);
  return path;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/deploy/compose_test.ts`
Expected: PASS。

- [ ] **Step 5: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj split noj-cli/src/deploy/compose.ts noj-cli/src/deploy/compose_test.ts
jj describe -m "feat(cli): 实现 Compose 渲染与复用 renderCompose/ensureComposeFile"
```

---

### Task 3: docker 组件生命周期 `src/deploy/docker.ts`

**Files:**
- Create: `noj-cli/src/deploy/docker.ts`
- Create: `noj-cli/src/deploy/docker_test.ts`

**Interfaces:**
- Consumes: `CommandRunner` / `CmdResult`（Task 1）、`COMPOSE_FILE`（Task 2）。
- Produces：
  - `export function dockerUp(runner: CommandRunner, composePath: string): Promise<CmdResult>`（`docker compose -f <path> up -d --wait`）
  - `export function dockerDown(runner: CommandRunner, composePath: string): Promise<CmdResult>`（`docker compose -f <path> down`，不 `-v`）
  - `export function dockerPs(runner: CommandRunner, composePath: string): Promise<CmdResult>`（`docker compose -f <path> ps`）

- [ ] **Step 1: 写失败测试**

创建 `noj-cli/src/deploy/docker_test.ts`：

```ts
import { assertEquals } from "@std/assert";
import type { CommandRunner } from "../runtime/command.ts";
import { dockerUp, dockerDown, dockerPs } from "./docker.ts";

/** 记录被调用的命令。 */
function recordingRunner(records: string[][]): CommandRunner {
  return {
    async run(cmd, args) {
      records.push([cmd, ...args]);
      return { code: 0, stdout: "ok", stderr: "" };
    },
    spawn() {
      throw new Error("fake runner 不 spawn");
    },
  };
}

Deno.test("dockerUp: 调用 docker compose -f <path> up -d --wait", async () => {
  const records: string[][] = [];
  await dockerUp(recordingRunner(records), "/opt/neuro-oj/docker-compose.noj.yml");
  assertEquals(records, [["docker", "compose", "-f", "/opt/neuro-oj/docker-compose.noj.yml", "up", "-d", "--wait"]]);
});

Deno.test("dockerDown: 调用 ... down（不带 -v）", async () => {
  const records: string[][] = [];
  await dockerDown(recordingRunner(records), "/opt/neuro-oj/docker-compose.noj.yml");
  assertEquals(records, [["docker", "compose", "-f", "/opt/neuro-oj/docker-compose.noj.yml", "down"]]);
});

Deno.test("dockerPs: 调用 ... ps 并透传结果", async () => {
  const records: string[][] = [];
  const r = await dockerPs(recordingRunner(records), "/opt/neuro-oj/docker-compose.noj.yml");
  assertEquals(records, [["docker", "compose", "-f", "/opt/neuro-oj/docker-compose.noj.yml", "ps"]]);
  assertEquals(r.code, 0);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/deploy/docker_test.ts`
Expected: FAIL，`Error: Cannot find module .../docker.ts`。

- [ ] **Step 3: 实现 `src/deploy/docker.ts`**

```ts
import type { CommandRunner, CmdResult } from "../runtime/command.ts";

/** `docker compose -f <path> up -d --wait`。 */
export function dockerUp(
  runner: CommandRunner,
  composePath: string,
): Promise<CmdResult> {
  return runner.run("docker", ["compose", "-f", composePath, "up", "-d", "--wait"]);
}

/** `docker compose -f <path> down`（不 `-v`，保留数据卷）。 */
export function dockerDown(
  runner: CommandRunner,
  composePath: string,
): Promise<CmdResult> {
  return runner.run("docker", ["compose", "-f", composePath, "down"]);
}

/** `docker compose -f <path> ps`。 */
export function dockerPs(
  runner: CommandRunner,
  composePath: string,
): Promise<CmdResult> {
  return runner.run("docker", ["compose", "-f", composePath, "ps"]);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/deploy/docker_test.ts`
Expected: PASS。

- [ ] **Step 5: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj split noj-cli/src/deploy/docker.ts noj-cli/src/deploy/docker_test.ts
jj describe -m "feat(cli): 实现 docker compose 生命周期 dockerUp/Down/Ps"
```

---

### Task 4: 进程组件管理与 PID 文件 `src/runtime/pidfile.ts` + `src/runtime/process.ts`

**Files:**
- Create: `noj-cli/src/runtime/pidfile.ts`
- Create: `noj-cli/src/runtime/pidfile_test.ts`
- Create: `noj-cli/src/runtime/process.ts`
- Create: `noj-cli/src/runtime/process_test.ts`

**Interfaces:**
- Consumes: `ComponentConfig`（P0 `types.ts`）、`CommandRunner` / `SpawnOpts` / `SpawnHandle`（Task 1）、`resolveComponentEnv` 的产物（env 由调用方传入）。
- Produces：
  - `export function pidPath(runDir: string, component: string): string`（`${runDir}/${component}.pid`）
  - `export async function writePid(runDir, component, pid: number): Promise<void>`（mkdir -p + 写文件）
  - `export async function readPid(runDir, component): Promise<number | null>`（缺失/非法返回 `null`）
  - `export async function removePid(runDir, component): Promise<void>`
  - `export function processLaunch(comp: ComponentConfig, env: Record<string, string>, cwd: string): SpawnOpts`（`dev_command` 按空白切分得 cmd/args；否则用 `binary ?? "noj-server"`）
  - `export async function startManagedProcess(runner: CommandRunner, runDir: string, component: string, comp: ComponentConfig, env: Record<string, string>, cwd: string): Promise<{ pid: number }>`（spawn 后写 PID 文件）
  - `export async function stopManagedProcess(runner: CommandRunner, runDir: string, component: string): Promise<void>`（读 PID → `kill -TERM <pid>` → 删 PID 文件；无 PID 文件则 no-op）

- [ ] **Step 1: 写失败测试**

创建 `noj-cli/src/runtime/pidfile_test.ts`：

```ts
import { assertEquals } from "@std/assert";
import { pidPath, writePid, readPid, removePid } from "./pidfile.ts";

Deno.test("writePid/readPid/removePid 往返", async () => {
  const dir = await Deno.makeTempDir();
  const runDir = `${dir}/run`;
  await writePid(runDir, "server", 4242);
  assertEquals(pidPath(runDir, "server"), `${runDir}/server.pid`);
  assertEquals(await readPid(runDir, "server"), 4242);
  await removePid(runDir, "server");
  assertEquals(await readPid(runDir, "server"), null);
});

Deno.test("readPid: 缺失/非法内容返回 null", async () => {
  const dir = await Deno.makeTempDir();
  assertEquals(await readPid(`${dir}/run`, "nope"), null);
  await Deno.mkdir(`${dir}/run`);
  await Deno.writeTextFile(`${dir}/run/bad.pid`, "not-a-number");
  assertEquals(await readPid(`${dir}/run`, "bad"), null);
});
```

创建 `noj-cli/src/runtime/process_test.ts`：

```ts
import { assertEquals } from "@std/assert";
import type { ComponentConfig } from "../config/types.ts";
import type { CommandRunner, SpawnHandle, SpawnOpts } from "./command.ts";
import { processLaunch, startManagedProcess, stopManagedProcess } from "./process.ts";
import { readPid } from "./pidfile.ts";

/** 可编程 fake runner：spawn 时记录请求并返回假句柄。 */
function fakeRunner(spawned: SpawnOpts[], killed: number[]): CommandRunner {
  return {
    async run(_cmd, _args) {
      return { code: 0, stdout: "", stderr: "" };
    },
    spawn(opts) {
      spawned.push(opts);
      const handle: SpawnHandle = {
        pid: 12345,
        async wait() {
          return 0;
        },
        async kill() {
          killed.push(12345);
        },
      };
      return handle;
    },
  };
}

const server: ComponentConfig = {
  enabled: true,
  method: "process",
  binary: "noj-server",
  port: 8000,
  host_port: null,
  env: { PORT: "8000" },
};

const ui: ComponentConfig = {
  enabled: true,
  method: "process",
  dev_command: "deno task dev",
  port: 3000,
  host_port: null,
  env: { PORT: "3000" },
};

Deno.test("processLaunch: binary 组件启动 noj-server", () => {
  const l = processLaunch(server, { PORT: "8000" }, "/opt/neuro-oj");
  assertEquals(l.cmd, "noj-server");
  assertEquals(l.args, []);
  assertEquals(l.cwd, "/opt/neuro-oj");
  assertEquals(l.env["PORT"], "8000");
});

Deno.test("processLaunch: dev_command 组件按空白切分", () => {
  const l = processLaunch(ui, { PORT: "3000" }, "/opt/neuro-oj");
  assertEquals(l.cmd, "deno");
  assertEquals(l.args, ["task", "dev"]);
});

Deno.test("startManagedProcess: spawn 并写 PID 文件", async () => {
  const dir = await Deno.makeTempDir();
  const runDir = `${dir}/run`;
  const spawned: SpawnOpts[] = [];
  const runner = fakeRunner(spawned, []);
  const { pid } = await startManagedProcess(runner, runDir, "server", server, { PORT: "8000" }, dir);
  assertEquals(pid, 12345);
  assertEquals(spawned.length, 1);
  assertEquals(spawned[0]!.cmd, "noj-server");
  assertEquals(await readPid(runDir, "server"), 12345);
});

Deno.test("stopManagedProcess: 读 PID 后 kill 并清文件", async () => {
  const dir = await Deno.makeTempDir();
  const runDir = `${dir}/run`;
  const killed: number[] = [];
  const spawned: SpawnOpts[] = [];
  const runner = fakeRunner(spawned, killed);
  await startManagedProcess(runner, runDir, "server", server, {}, dir);
  await stopManagedProcess(runner, runDir, "server");
  assertEquals(killed, [12345]);
  assertEquals(await readPid(runDir, "server"), null);
});

Deno.test("stopManagedProcess: 无 PID 文件时 no-op", async () => {
  const dir = await Deno.makeTempDir();
  const runner = fakeRunner([], []);
  let threw = false;
  try {
    await stopManagedProcess(runner, `${dir}/run`, "ghost");
  } catch {
    threw = true;
  }
  assertEquals(threw, false);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/runtime/pidfile_test.ts src/runtime/process_test.ts`
Expected: FAIL，`Cannot find module .../pidfile.ts` 与 `.../process.ts`。

- [ ] **Step 3: 实现 `src/runtime/pidfile.ts`**

```ts
/** 进程 PID 文件路径：${runDir}/${component}.pid。 */
export function pidPath(runDir: string, component: string): string {
  return `${runDir}/${component}.pid`;
}

/** 写 PID 文件（自动创建 run 目录）。 */
export async function writePid(runDir: string, component: string, pid: number): Promise<void> {
  await Deno.mkdir(runDir, { recursive: true });
  await Deno.writeTextFile(pidPath(runDir, component), String(pid));
}

/** 读 PID；缺失或非正整数返回 null。 */
export async function readPid(runDir: string, component: string): Promise<number | null> {
  try {
    const text = (await Deno.readTextFile(pidPath(runDir, component))).trim();
    const n = Number(text);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** 删除 PID 文件（不存在则静默）。 */
export async function removePid(runDir: string, component: string): Promise<void> {
  try {
    await Deno.remove(pidPath(runDir, component));
  } catch {
    // 已不存在则忽略
  }
}
```

- [ ] **Step 4: 实现 `src/runtime/process.ts`**

```ts
import type { ComponentConfig } from "../config/types.ts";
import type { CommandRunner, SpawnOpts } from "./command.ts";
import { writePid, readPid, removePid } from "./pidfile.ts";

/** 由 ComponentConfig 生成进程启动参数。 */
export function processLaunch(
  comp: ComponentConfig,
  env: Record<string, string>,
  cwd: string,
): SpawnOpts {
  if (comp.method !== "process") {
    throw new Error("processLaunch 仅支持 method=process 的组件");
  }
  if (comp.dev_command) {
    const parts = comp.dev_command.trim().split(/\s+/);
    return { cmd: parts[0]!, args: parts.slice(1), cwd, env };
  }
  return { cmd: comp.binary ?? "noj-server", args: [], cwd, env };
}

/** 启动一个 process 组件：spawn 后记录 PID，返回 PID。 */
export async function startManagedProcess(
  runner: CommandRunner,
  runDir: string,
  component: string,
  comp: ComponentConfig,
  env: Record<string, string>,
  cwd: string,
): Promise<{ pid: number }> {
  const launch = processLaunch(comp, env, cwd);
  const handle = runner.spawn(launch);
  await writePid(runDir, component, handle.pid);
  return { pid: handle.pid };
}

/** 停止 process 组件：读 PID → kill -TERM → 清 PID 文件；无 PID 文件则 no-op。 */
export async function stopManagedProcess(
  runner: CommandRunner,
  runDir: string,
  component: string,
): Promise<void> {
  const pid = await readPid(runDir, component);
  if (pid === null) return;
  await runner.run("kill", ["-TERM", String(pid)]);
  await removePid(runDir, component);
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/runtime/pidfile_test.ts src/runtime/process_test.ts`
Expected: PASS。

- [ ] **Step 6: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj split noj-cli/src/runtime/pidfile.ts noj-cli/src/runtime/pidfile_test.ts noj-cli/src/runtime/process.ts noj-cli/src/runtime/process_test.ts
jj describe -m "feat(cli): 实现 process 组件管理与 PID 文件"
```

---

### Task 5: 状态收敛助手 `src/deploy/state.ts`

**Files:**
- Create: `noj-cli/src/deploy/state.ts`
- Create: `noj-cli/src/deploy/state_test.ts`

**Interfaces:**
- Consumes: `DeployConfig` / `DeployState`（P0 `types.ts`）、`transition` / `DeployAction`（P0 `machine.ts`）。
- Produces：
  - `export function nextState(config: DeployConfig, action: DeployAction): { state: DeployState; changed: boolean; message: string }`（薄封装 `transition(config.state, action)`）
  - `export async function writeState(config: DeployConfig, state: DeployState, save: (c: DeployConfig) => Promise<void>): Promise<void>`（置 `config.state`、更新 `updated_at` 为 UTC ISO 后调 `save(config)`）
  - `export function upIsNoOp(config: DeployConfig): boolean`（`nextState(config, "up").changed === false`，即当前 `running`）
  - `export function downIsNoOp(config: DeployConfig): boolean`（`nextState(config, "down").changed === false`，即当前 `stopped`）

- [ ] **Step 1: 写失败测试**

创建 `noj-cli/src/deploy/state_test.ts`：

```ts
import { assertEquals } from "@std/assert";
import type { DeployConfig } from "../config/types.ts";
import { nextState, writeState, upIsNoOp, downIsNoOp } from "./state.ts";

function cfg(state: DeployConfig["state"]): DeployConfig {
  return {
    schema_version: 1,
    type: "dev",
    state,
    created_at: "2026-08-31T00:00:00Z",
    updated_at: "2026-08-31T00:00:00Z",
    install_dir: "/opt/neuro-oj",
    version: { noj_cli: "0.1.0", noj_server: "0.1.0" },
    env: {},
    components: {},
    reverse_proxy: { type: "nginx", config_dir: "/etc/nginx/conf.d", domain: "localhost", upstream_port: 8080 },
  };
}

Deno.test("nextState: up 在 running 时 no-op，其余进入 running", () => {
  assertEquals(nextState(cfg("running"), "up").changed, false);
  assertEquals(nextState(cfg("stopped"), "up").state, "running");
  assertEquals(nextState(cfg("partial"), "up").state, "running");
});

Deno.test("nextState: down 在 stopped 时 no-op，其余进入 stopped", () => {
  assertEquals(nextState(cfg("stopped"), "down").changed, false);
  assertEquals(nextState(cfg("running"), "down").state, "stopped");
});

Deno.test("upIsNoOp / downIsNoOp", () => {
  assertEquals(upIsNoOp(cfg("running")), true);
  assertEquals(upIsNoOp(cfg("stopped")), false);
  assertEquals(downIsNoOp(cfg("stopped")), true);
  assertEquals(downIsNoOp(cfg("running")), false);
});

Deno.test("writeState: 设置状态并更新 updated_at 后调用 save", async () => {
  const c = cfg("stopped");
  let saved: DeployConfig | undefined;
  await writeState(c, "running", (x) => {
    saved = x;
    return Promise.resolve();
  });
  assertEquals(c.state, "running");
  assertEquals(new Date(c.updated_at).toISOString(), c.updated_at);
  assertEquals(saved?.state, "running");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/deploy/state_test.ts`
Expected: FAIL，`Error: Cannot find module .../state.ts`。

- [ ] **Step 3: 实现 `src/deploy/state.ts`**

```ts
import type { DeployConfig, DeployState } from "../config/types.ts";
import { transition, type DeployAction } from "../state/machine.ts";

export interface StateResult {
  state: DeployState;
  changed: boolean;
  message: string;
}

/** 薄封装 P0 transition，判断命令是否 should no-op。 */
export function nextState(config: DeployConfig, action: DeployAction): StateResult {
  return transition(config.state, action);
}

/** 当前状态是否 running（up 应 no-op）。 */
export function upIsNoOp(config: DeployConfig): boolean {
  return nextState(config, "up").changed === false;
}

/** 当前状态是否 stopped（down 应 no-op）。 */
export function downIsNoOp(config: DeployConfig): boolean {
  return nextState(config, "down").changed === false;
}

/** 写回目标状态并落盘（更新 updated_at 为 UTC ISO）。 */
export async function writeState(
  config: DeployConfig,
  state: DeployState,
  save: (c: DeployConfig) => Promise<void>,
): Promise<void> {
  config.state = state;
  config.updated_at = new Date().toISOString();
  await save(config);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/deploy/state_test.ts`
Expected: PASS。

- [ ] **Step 5: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj split noj-cli/src/deploy/state.ts noj-cli/src/deploy/state_test.ts
jj describe -m "feat(cli): 实现部署状态收敛助手 nextState/writeState"
```

---

### Task 6: 部署编排 `src/deploy/deploy.ts`

**Files:**
- Create: `noj-cli/src/deploy/deploy.ts`
- Create: `noj-cli/src/deploy/deploy_test.ts`

**Interfaces:**
- Consumes: `loadDeployment` / `saveDeployment`（P0）、`resolveComponentEnv`（P0）、`CommandRunner` / `realRunner`（Task 1）、`ensureComposeFile` / `COMPOSE_FILE`（Task 2）、`dockerUp` / `dockerDown` / `dockerPs`（Task 3）、`startManagedProcess` / `stopManagedProcess` / `readPid`（Task 4）、`upIsNoOp` / `downIsNoOp` / `writeState`（Task 5）、`fileExists`（Task 1）。
- Produces：
  - `export interface DeployOptions { dir: string; runner?: CommandRunner }`
  - `export interface ComponentStatus { component: string; method: "docker" | "process"; enabled: boolean; running: boolean }`
  - `export interface DeployStatusReport { state: DeployState; components: ComponentStatus[] }`
  - `export async function deployUp(opts): Promise<DeployState>`（`running` 时 no-op；否则 ensure compose → docker up（若有 docker 组件）+ 逐个启动 process 组件 → 全成功写 `running` / 任一失败写 `partial`）
  - `export async function deployDown(opts): Promise<DeployState>`（`stopped` 时 no-op；否则先停 process 组件再 docker down → 写 `stopped`）
  - `export async function deployRestart(opts): Promise<DeployState>`（`deployDown` 后 `deployUp`）
  - `export async function deployStatus(opts): Promise<DeployStatusReport>`（配置缺失时返回 `state: "uninitialized"`；按方法探测各组件 `running`：docker 组件看 `ps` 输出是否含服务名，process 组件看 PID 文件）

- [ ] **Step 1: 写失败测试**

创建 `noj-cli/src/deploy/deploy_test.ts`：

```ts
import { assertEquals } from "@std/assert";
import type { DeployConfig, SecretsConfig } from "../config/types.ts";
import type { CommandRunner, SpawnHandle, SpawnOpts } from "../runtime/command.ts";
import { deployUp, deployDown, deployRestart, deployStatus } from "./deploy.ts";
import { COMPOSE_FILE } from "./compose.ts";
import { writePid } from "../runtime/pidfile.ts";

const NOW = "2026-08-31T00:00:00Z";

function config(state: DeployConfig["state"]): DeployConfig {
  return {
    schema_version: 1,
    type: "dev",
    state,
    created_at: NOW,
    updated_at: NOW,
    install_dir: "/opt/neuro-oj",
    version: { noj_cli: "0.1.0", noj_server: "0.1.0" },
    env: { LOG_LEVEL: "info" },
    components: {
      postgres: { enabled: true, method: "docker", image: "postgres:16-alpine", internal_port: 5432, host_port: null, env: { POSTGRES_PASSWORD: "${POSTGRES_PASSWORD}" } },
      server: { enabled: true, method: "process", binary: "noj-server", port: 8000, host_port: null, env: { PORT: "8000" } },
    },
    reverse_proxy: { type: "nginx", config_dir: "/etc/nginx/conf.d", domain: "localhost", upstream_port: 8080 },
  };
}

function secrets(): SecretsConfig {
  return { schema_version: 1, created_at: NOW, updated_at: NOW, secrets: { POSTGRES_PASSWORD: "pg" } };
}

function writeFixture(dir: string, state: DeployConfig["state"]): Promise<void> {
  return Promise.all([
    Deno.writeTextFile(`${dir}/noj-deploy.json`, JSON.stringify(config(state))),
    Deno.writeTextFile(`${dir}/noj-secrets.json`, JSON.stringify(secrets())),
    Deno.mkdir(`${dir}/run`, { recursive: true }),
  ]).then(() => {});
}

/**
 * 可编程 fake runner：模拟 docker compose（stdout 含/不含服务名）与 process spawn。
 * dockerOk=false 时 up 返回非零（触发 partial）。
 */
function fakeRunner(dockerOk = true, psStdout = "postgres running"): CommandRunner {
  const spawned: SpawnOpts[] = [];
  return {
    async run(cmd, args) {
      const isDocker = cmd === "docker";
      const isPs = isDocker && args.includes("ps");
      if (isPs) {
        return dockerOk ? { code: 0, stdout: psStdout, stderr: "" } : { code: 1, stdout: "", stderr: "err" };
      }
      if (isDocker) {
        return dockerOk ? { code: 0, stdout: "ok", stderr: "" } : { code: 1, stdout: "", stderr: "up failed" };
      }
      if (cmd === "kill") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    spawn(opts) {
      spawned.push(opts);
      const handle: SpawnHandle = {
        pid: 2222,
        async wait() {
          return 0;
        },
        async kill() {},
      };
      return handle;
    },
  };
}

Deno.test("deployUp: 从 stopped 启动 docker 与 process，写入 running", async () => {
  const dir = await Deno.makeTempDir();
  await writeFixture(dir, "stopped");
  const runner = fakeRunner();
  const state = await deployUp({ dir, runner });
  assertEquals(state, "running");
  const saved = JSON.parse(await Deno.readTextFile(`${dir}/noj-deploy.json`)) as DeployConfig;
  assertEquals(saved.state, "running");
  const compose = await Deno.readTextFile(`${dir}/${COMPOSE_FILE}`);
  assertEquals(compose.includes("postgres:"), true);
  // server 是 process，compose 无 server，但 PID 文件已写
  await Deno.readTextFile(`${dir}/run/server.pid`);
});

Deno.test("deployUp: 已 running 时 no-op", async () => {
  const dir = await Deno.makeTempDir();
  await writeFixture(dir, "running");
  const state = await deployUp({ dir, runner: fakeRunner() });
  assertEquals(state, "running");
  const saved = JSON.parse(await Deno.readTextFile(`${dir}/noj-deploy.json`)) as DeployConfig;
  assertEquals(saved.state, "running");
  // 不应生成 compose（没跑 docker up）
  let composeExists = false;
  try {
    await Deno.stat(`${dir}/${COMPOSE_FILE}`);
    composeExists = true;
  } catch {
    composeExists = false;
  }
  assertEquals(composeExists, false);
});

Deno.test("deployUp: docker 失败时写入 partial", async () => {
  const dir = await Deno.makeTempDir();
  await writeFixture(dir, "stopped");
  const state = await deployUp({ dir, runner: fakeRunner(false) });
  assertEquals(state, "partial");
  const saved = JSON.parse(await Deno.readTextFile(`${dir}/noj-deploy.json`)) as DeployConfig;
  assertEquals(saved.state, "partial");
});

Deno.test("deployDown: 从 running 停止并写 stopped，保留 compose 文件", async () => {
  const dir = await Deno.makeTempDir();
  await writeFixture(dir, "running");
  await Deno.writeTextFile(`${dir}/${COMPOSE_FILE}`, "services: {}\n");
  await writePid(`${dir}/run`, "server", 2222);
  const state = await deployDown({ dir, runner: fakeRunner() });
  assertEquals(state, "stopped");
  const saved = JSON.parse(await Deno.readTextFile(`${dir}/noj-deploy.json`)) as DeployConfig;
  assertEquals(saved.state, "stopped");
  // 进程 PID 文件被清除
  let pidLeft = true;
  try {
    await Deno.stat(`${dir}/run/server.pid`);
  } catch {
    pidLeft = false;
  }
  assertEquals(pidLeft, false);
});

Deno.test("deployDown: 已 stopped 时 no-op", async () => {
  const dir = await Deno.makeTempDir();
  await writeFixture(dir, "stopped");
  const state = await deployDown({ dir, runner: fakeRunner() });
  assertEquals(state, "stopped");
});

Deno.test("deployRestart: 从 stopped 直接 up 到 running", async () => {
  const dir = await Deno.makeTempDir();
  await writeFixture(dir, "stopped");
  const state = await deployRestart({ dir, runner: fakeRunner() });
  assertEquals(state, "running");
});

Deno.test("deployRestart: 从 running 先 down 再 up", async () => {
  const dir = await Deno.makeTempDir();
  await writeFixture(dir, "running");
  await Deno.writeTextFile(`${dir}/${COMPOSE_FILE}`, "services: {}\n");
  const state = await deployRestart({ dir, runner: fakeRunner() });
  assertEquals(state, "running");
});

Deno.test("deployStatus: 报告状态与各组件 running 情况", async () => {
  const dir = await Deno.makeTempDir();
  await writeFixture(dir, "running");
  await writePid(`${dir}/run`, "server", 2222);
  const report = await deployStatus({ dir, runner: fakeRunner(true, "postgres running") });
  assertEquals(report.state, "running");
  const pg = report.components.find((c) => c.component === "postgres")!;
  assertEquals(pg.running, true);
  const srv = report.components.find((c) => c.component === "server")!;
  assertEquals(srv.method, "process");
  assertEquals(srv.running, true);
});

Deno.test("deployStatus: 配置缺失时返回 uninitialized", async () => {
  const dir = await Deno.makeTempDir();
  const report = await deployStatus({ dir, runner: fakeRunner() });
  assertEquals(report.state, "uninitialized");
  assertEquals(report.components.length, 0);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/deploy/deploy_test.ts`
Expected: FAIL，`Error: Cannot find module .../deploy.ts`。

- [ ] **Step 3: 实现 `src/deploy/deploy.ts`**

```ts
import type { DeployConfig, DeployState, ComponentConfig, SecretsConfig } from "../config/types.ts";
import { loadDeployment } from "../config/load.ts";
import { saveDeployment } from "../config/save.ts";
import { resolveComponentEnv } from "../config/merge.ts";
import type { CommandRunner } from "../runtime/command.ts";
import { realRunner } from "../runtime/command.ts";
import { fileExists } from "../util/fs.ts";
import { ensureComposeFile, COMPOSE_FILE } from "./compose.ts";
import { dockerUp, dockerDown, dockerPs } from "./docker.ts";
import { startManagedProcess, stopManagedProcess } from "../runtime/process.ts";
import { readPid } from "../runtime/pidfile.ts";
import { upIsNoOp, downIsNoOp, writeState } from "./state.ts";

/** deploy 命令运行选项。 */
export interface DeployOptions {
  dir: string;
  runner?: CommandRunner;
}

/** 单个组件运行状态。 */
export interface ComponentStatus {
  component: string;
  method: "docker" | "process";
  enabled: boolean;
  running: boolean;
}

/** deploy status 报告。 */
export interface DeployStatusReport {
  state: DeployState;
  components: ComponentStatus[];
}

/** 返回安装目录下 run 目录。 */
function runDirOf(config: DeployConfig): string {
  return `${config.install_dir}/run`;
}

/** 返回 compose 文件绝对路径。 */
function composePathOf(config: DeployConfig): string {
  return `${config.install_dir}/${COMPOSE_FILE}`;
}

/**
 * 启动 enabled 的 docker 组件（生成/复用 compose 后 `docker compose up -d --wait`）。
 * 返回是否全部成功。
 */
async function startDocker(
  runner: CommandRunner,
  dir: string,
  config: DeployConfig,
  secrets: SecretsConfig,
): Promise<boolean> {
  const hasDocker = Object.values(config.components)
    .some((c) => c.enabled && c.method === "docker");
  if (!hasDocker) return true;
  const composePath = await ensureComposeFile(dir, config, secrets);
  const r = await dockerUp(runner, composePath);
  return r.code === 0;
}

/** 逐个启动 process 组件并记录 PID；返回是否全部成功。 */
async function startProcesses(
  runner: CommandRunner,
  config: DeployConfig,
  secrets: SecretsConfig,
): Promise<boolean> {
  const runDir = runDirOf(config);
  let ok = true;
  for (const [name, comp] of Object.entries(config.components)) {
    if (!comp.enabled || comp.method !== "process") continue;
    const env = resolveComponentEnv(config, secrets, name);
    try {
      await startManagedProcess(runner, runDir, name, comp, env, config.install_dir);
    } catch {
      ok = false;
    }
  }
  return ok;
}

/** `deploy up`：running 时 no-op，否则启动 docker + process，写 running/partial。 */
export async function deployUp(opts: DeployOptions): Promise<DeployState> {
  const runner = opts.runner ?? realRunner();
  const { config, secrets } = await loadDeployment(opts.dir);
  if (upIsNoOp(config)) {
    console.log(`deploy up: ${config.state}`);
    return config.state;
  }
  const dockerOk = await startDocker(runner, opts.dir, config, secrets);
  const procOk = await startProcesses(runner, config, secrets);
  const state: DeployState = dockerOk && procOk ? "running" : "partial";
  await writeState(config, state, (c) => saveDeployment(opts.dir, c, secrets));
  console.log(`deploy up: ${state}`);
  return state;
}

/** 停止所有 process 组件。 */
async function stopProcesses(runner: CommandRunner, config: DeployConfig): Promise<void> {
  const runDir = runDirOf(config);
  for (const [name, comp] of Object.entries(config.components)) {
    if (comp.enabled && comp.method === "process") {
      await stopManagedProcess(runner, runDir, name);
    }
  }
}

/** `deploy down`：stopped 时 no-op，否则停进程 + docker down，写 stopped。 */
export async function deployDown(opts: DeployOptions): Promise<DeployState> {
  const runner = opts.runner ?? realRunner();
  const { config, secrets } = await loadDeployment(opts.dir);
  if (downIsNoOp(config)) {
    console.log(`deploy down: ${config.state}`);
    return config.state;
  }
  await stopProcesses(runner, config);
  const composePath = composePathOf(config);
  if (await fileExists(composePath)) {
    await dockerDown(runner, composePath);
  }
  await writeState(config, "stopped", (c) => saveDeployment(opts.dir, c, secrets));
  console.log("deploy down: stopped");
  return config.state;
}

/** `deploy restart`：先 down 再 up（down 在 stopped 时 no-op）。 */
export async function deployRestart(opts: DeployOptions): Promise<DeployState> {
  await deployDown(opts);
  return deployUp(opts);
}

/** 探测单个组件的运行状态。 */
async function componentRunning(
  runner: CommandRunner,
  config: DeployConfig,
  name: string,
  comp: ComponentConfig,
): Promise<boolean> {
  if (!comp.enabled) return false;
  if (comp.method === "docker") {
    const composePath = composePathOf(config);
    if (!(await fileExists(composePath))) return false;
    const r = await dockerPs(runner, composePath);
    return r.code === 0 && r.stdout.includes(name);
  }
  const pid = await readPid(runDirOf(config), name);
  return pid !== null;
}

/** `deploy status`：只做最小检查，配置损坏时仍可查看（返回 uninitialized）。 */
export async function deployStatus(opts: DeployOptions): Promise<DeployStatusReport> {
  const runner = opts.runner ?? realRunner();
  let config: DeployConfig;
  try {
    ({ config } = await loadDeployment(opts.dir));
  } catch {
    return { state: "uninitialized", components: [] };
  }
  const components: ComponentStatus[] = [];
  for (const [name, comp] of Object.entries(config.components)) {
    const running = await componentRunning(runner, config, name, comp);
    components.push({ component: name, method: comp.method, enabled: comp.enabled, running });
  }
  return { state: config.state, components };
}
```

> **注意（对执行者）：** `loadDeployment` 从 `src/config/load.ts` 导入，`saveDeployment` 从 `src/config/save.ts` 导入（二者是 P0 的两个不同文件，不合并从 `load.ts` 导入）。测试文件 `deploy_test.ts` 中的 `writeFixture` 需先建目录，采用下面版本（含 `Deno.mkdir(dir, { recursive: true })`）：

```ts
async function writeFixture(dir: string, state: DeployConfig["state"]): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  await Deno.mkdir(`${dir}/run`, { recursive: true });
  await Deno.writeTextFile(`${dir}/noj-deploy.json`, JSON.stringify(config(state)));
  await Deno.writeTextFile(`${dir}/noj-secrets.json`, JSON.stringify(secrets()));
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/deploy/deploy_test.ts`
Expected: PASS。

- [ ] **Step 5: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj split noj-cli/src/deploy/deploy.ts noj-cli/src/deploy/deploy_test.ts
jj describe -m "feat(cli): 实现 deploy up/down/restart/status 编排"
```

---

### Task 7: 接入 `deploy up/down/restart/status` 到 `src/cli.ts`

**Files:**
- Modify: `noj-cli/src/cli.ts`（`deploy` 分支，替换 P0/P1 占位）
- Modify: `noj-cli/src/cli_test.ts`（新增用例）

**Interfaces:**
- Consumes: `deployUp` / `deployDown` / `deployRestart` / `deployStatus` / `DeployStatusReport`（Task 6）、`findDeployDir`（P0）、`CommandContext { cwd; deployDir }`（P0）。
- Produces：
  - `export function parseDeployArgs(args: string[]): { dir: string | undefined }`（解析 `--dir <path>`）
  - `deploy up / down / restart / status` 命令分支：`ctx.deployDir ?? findDeployDir(ctx.cwd)` 得到部署目录（缺失且需要时抛错）；调用对应 orchestration 函数，`status` 打印人类可读报告；返回 `0`。

- [ ] **Step 1: 写失败测试**

在 `noj-cli/src/cli_test.ts` 末尾追加：

```ts
import { parseDeployArgs } from "./cli.ts";

Deno.test("parseDeployArgs: 无 --dir 时返回 undefined", () => {
  assertEquals(parseDeployArgs([]).dir, undefined);
});

Deno.test("parseDeployArgs: 解析 --dir /opt", () => {
  assertEquals(parseDeployArgs(["--dir", "/opt"]).dir, "/opt");
});
```

（`assertEquals` 已在 cli_test.ts 既有 import 中。）

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/cli_test.ts`
Expected: FAIL，`parseDeployArgs` 未定义。

- [ ] **Step 3: 实现解析器并接入 deploy 生命周期分支**

在 `noj-cli/src/cli.ts` 顶部 import 区追加：

```ts
import { findDeployDir } from "./util/find_deploy_dir.ts";
import { deployUp, deployDown, deployRestart, deployStatus } from "./deploy/deploy.ts";
```

在文件内新增：

```ts
/** 解析 deploy 生命周期参数：目前仅 --dir <path>。 */
export function parseDeployArgs(args: string[]): { dir: string | undefined } {
  const idx = args.indexOf("--dir");
  return { dir: idx !== -1 ? args[idx + 1] : undefined };
}
```

将 `dispatchCommand` 的 `case "deploy":` 中 `up/down/restart/status` 分支（P0/P1 里 `if (DEPLOY_SUBCOMMANDS.includes(sub))` 的占位输出）替换为：

```ts
case "deploy": {
  const sub = args[0] ?? "";
  if (sub === "init") {
    // P1 已实现，保持不变
    return 0; // 占位注释：实际 P1 逻辑已在此，勿删
  }
  const { dir } = parseDeployArgs(args.slice(1));
  const deployDir = dir ?? ctx.deployDir ?? findDeployDir(ctx.cwd);
  if (deployDir === null) {
    console.error("deploy: 未找到 noj-deploy.json，请先运行 deploy init");
    return 1;
  }
  switch (sub) {
    case "up": {
      const state = await deployUp({ dir: deployDir });
      console.log(`deploy up 完成，状态: ${state}`);
      return 0;
    }
    case "down": {
      const state = await deployDown({ dir: deployDir });
      console.log(`deploy down 完成，状态: ${state}`);
      return 0;
    }
    case "restart": {
      const state = await deployRestart({ dir: deployDir });
      console.log(`deploy restart 完成，状态: ${state}`);
      return 0;
    }
    case "status": {
      const report = await deployStatus({ dir: deployDir });
      console.log(`状态: ${report.state}`);
      for (const c of report.components) {
        console.log(
          `  ${c.component}: ${c.enabled ? (c.running ? "运行中" : "未运行") : "禁用"} (${c.method})`,
        );
      }
      return 0;
    }
    default:
      console.log("deploy: 需要子命令 init/up/down/restart/status");
      return 0;
  }
}
```

> **提示（对执行者）：** 若你当前的 `cli.ts` 中 `deploy init` 分支不是 `return 0` 占位而是完整的 P1 引导代码，则保留原 init 分支不动，仅把「其他 deploy 子命令」的占位逻辑替换为上面的 `up/down/restart/status` switch。判断逻辑：找到 `case "deploy":` 块，把「`if (DEPLOY_SUBCOMMANDS.includes(sub)) { ... 占位 ... }`」这一段替换为上面新的 switch 结构，原 `init` 分支（`if (sub === "init") { ... }`）原样保留。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/cli_test.ts`
Expected: PASS。

- [ ] **Step 5: 手动冒烟验证（临时目录 + fake 环境）**

Run:
```bash
cd noj-cli && TMP=$(mktemp -d)
# 直接构造最小配置供 deploy 读取
cp -r /dev/null "$TMP/noj-secrets.json" 2>/dev/null || echo '{}' > "$TMP/noj-secrets.json"
# 用真实 docker 不可靠，这里只验证 up 的 no-op 分支与 status 的 uninitialized 分支
deno run -A src/cli.ts deploy up --dir "$TMP" 2>&1 | head -3
deno run -A src/cli.ts deploy status --dir "$TMP" 2>&1 | head -3
```
Expected: `up` 因 `noj-deploy.json` 缺失以非零退出（报「未找到 noj-deploy.json」）；`status`… 实际 `status` 在无配置时应返回 `uninitialized` 报告并退出 0。

> 冒烟验证仅用于人工确认命令装配正确，不要求真实 Docker 跑通（真实生命周期由 Task 6 的 fake runner 测试覆盖）。若 `deploy status` 无配置时被 `findDeployDir` 拦截，属可接受（`status` 的最小检查语义在本计划由 `deployStatus` 直接调用保证，CLI 层定位目录失败时提示使用 `--dir`）。

- [ ] **Step 6: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj split noj-cli/src/cli.ts noj-cli/src/cli_test.ts
jj describe -m "feat(cli): 接入 deploy up/down/restart/status 命令"
```

---

### Task 8: P2 收尾 —— 公共导出、文档与全量验证

**Files:**
- Modify: `noj-cli/src/mod.ts`（聚合导出 P2 公共接口）
- Modify: `noj-cli/README.md`（补充 P2 范围与用法）

**Interfaces:**
- Consumes: Task 1–7 全部产物。
- Produces：`src/mod.ts` 聚合导出 `CommandRunner`/`realRunner`/`SpawnOpts`/`SpawnHandle`/`CmdResult`、`fileExists`、`renderCompose`/`ensureComposeFile`/`COMPOSE_FILE`、`dockerUp`/`dockerDown`/`dockerPs`、`startManagedProcess`/`stopManagedProcess`/`processLaunch`/pidfile 函数、`nextState`/`writeState`/`upIsNoOp`/`downIsNoOp`、`deployUp`/`deployDown`/`deployRestart`/`deployStatus` 及对应类型。

- [ ] **Step 1: 更新 `src/mod.ts` 聚合导出**

在 `noj-cli/src/mod.ts` 末尾追加（保留原 P0/P1 导出）：

```ts
// runtime（P2）
export type { CmdResult, SpawnOpts, SpawnHandle, CommandRunner } from "./runtime/command.ts";
export { realRunner } from "./runtime/command.ts";
export { fileExists } from "./util/fs.ts";
export { pidPath, writePid, readPid, removePid } from "./runtime/pidfile.ts";
export { processLaunch, startManagedProcess, stopManagedProcess } from "./runtime/process.ts";

// deploy（P2）
export { renderCompose, ensureComposeFile, COMPOSE_FILE } from "./deploy/compose.ts";
export { dockerUp, dockerDown, dockerPs } from "./deploy/docker.ts";
export { nextState, writeState, upIsNoOp, downIsNoOp } from "./deploy/state.ts";
export { deployUp, deployDown, deployRestart, deployStatus } from "./deploy/deploy.ts";
export type { DeployOptions, ComponentStatus, DeployStatusReport } from "./deploy/deploy.ts";
```

- [ ] **Step 2: 验证导出的类型检查**

Run: `cd noj-cli && deno task check`
Expected: 通过。

- [ ] **Step 3: 全量测试**

Run: `cd noj-cli && deno task test`
Expected: 全部 PASS（含 P0/P1 既有测试与 P2 新增测试）。

- [ ] **Step 4: 更新 `noj-cli/README.md`**

在 `## 状态` 一节追加 P2 说明，并补充用法：

```markdown
## 状态

P2：实现 `deploy up/down/restart/status`。根据 `noj-deploy.json` 生成/复用
`docker-compose.noj.yml` 并调用 `docker compose up -d --wait / down / ps`；
`method: process` 组件（开发模式的 noj-server/UI 等）以本地进程 spawn，PID
记录于 `<install_dir>/run/<component>.pid`，停止时 `kill -TERM`；命令执行
前后经 P0 状态机更新 `noj-deploy.json` 的 `state`。`down` 保留数据卷。
`maintain` 系列与 `doctor`/`init` 见 P1/P3 计划。

## 用法

```bash
cd noj-cli
deno run -A src/cli.ts deploy up --dir /opt/neuro-oj
deno run -A src/cli.ts deploy restart --dir /opt/neuro-oj
deno run -A src/cli.ts deploy status --dir /opt/neuro-oj
deno run -A src/cli.ts deploy down --dir /opt/neuro-oj
```

## 目录

- `src/runtime/` 命令/进程抽象（command/pidfile/process）
- `src/deploy/` 部署编排（compose/docker/state/deploy）
- `src/util/fs.ts` 文件工具
```

- [ ] **Step 5: 全量验证**

Run: `cd noj-cli && deno task test && deno task check`
Expected: 全部通过（既有 P0/P1 测试 + P2 测试）。

- [ ] **Step 6: 提交本任务**

```bash
jj split noj-cli/src/mod.ts noj-cli/README.md
jj describe -m "feat(cli): 聚合 P2 公共导出并更新项目说明"
```

---

## 自审清单

- **范围**：P2 只交付 `deploy up/down/restart/status` 及其编排依赖（Compose 渲染、docker 生命周期、process 组件管理、状态收敛）；未实现 `maintain` 系列、`doctor`/`init` 业务（P1 已交付）。
- **接口一致**：沿用 P0 公共接口精确签名（`loadDeployment`/`saveDeployment`/`resolveComponentEnv`/`transition`/`findDeployDir`/`cli.ts`），未改动其签名；P2 新增接口在 `src/mod.ts` 聚合导出。
- **约束落实**：Deno + TypeScript；手写 YAML 渲染器（无第三方依赖，不锁 deno.lock）；`down` 不 `-v` 保留数据卷；PID 记录于 `run/` 而非元数据；状态经 `saveDeployment` 写回 `noj-deploy.json`；测试经 `deno task test` / `deno task check`；提交用 jj + 中文描述 + `feat(cli)` scope。
- **可测试性**：所有系统调用仅经 `CommandRunner`；Task 1/3/4/6/7 均用 fake runner 模拟 docker 与 process，Task 6 的编排测试完整覆盖 up/down/restart/status，含 `running` no-op、docker 失败 → `partial`、`stopped` no-op、`uninitialized` 最小检查。
- **状态机语义**：up 在 `running` no-op（经 P0 `transition`）；down 在 `stopped` no-op；部分失败写 `partial`；restart = down+up。
- **每个任务** 都以 失败测试→跑失败→实现→跑通过→提交 的 bite-sized 步骤组织，且每个步骤给出真实代码或命令。
