# noj-cli judge 命令族（Phase 2）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 noj-cli 中新增 `judge` 命令族，直接 Deno 化移植 `scripts/deploy/judge-install.sh`，覆盖独立 Judge Worker 的 install/install-env/check/start/stop/status/logs/upgrade/download。

**Architecture:** 新增 `noj-cli/src/judge/` 模块。`options.ts` 负责参数解析；`env.ts` 负责 `.env.judge` 读写；`checks.ts` 负责环境/配置/socket/Redis/镜像检查；`compose.ts` 负责生成并执行 `docker-compose.judge.yml`；`commands.ts` 聚合为 `runJudgeCommand`。CLI 挂载顶层 `judge` 命令。

**Tech Stack:** Deno 2 + TypeScript、`@std/assert`、`@std/path`、现有 `CommandRunner` 与 `PromptIO` 抽象，不新增第三方运行时依赖。

**Spec:** `dev-docs/superpowers/specs/2026-09-07-noj-cli-script-sync-design.md`

## Global Constraints

- 语言：代码标识符使用英文，注释与提交描述使用中文。
- 运行环境：仅 Deno 2 + TypeScript 标准环境；不新增第三方运行时依赖。
- 提交：使用 jj；提交信息格式 `<type>(<scope>): <中文描述>`，scope 使用 `cli`。
- 测试：通过 `cd noj-cli && deno task test` 运行；代码通过 `deno fmt` 与 `deno lint`。
- 所有改动必须位于当前 worktree（`.worktrees/noj-cli-improves/`）内，禁止修改主仓库。
- 不修改 `scripts/deploy/*.sh` 等脚本侧实现；脚本保留为兜底。
- 行为基线：`scripts/deploy/judge-install.sh` 是权威行为来源；Deno 移植必须保留其安全边界（禁止 `/var/run/docker.sock`、配置文件 600/400、密码不回显、非交互必填校验）。

---

## 文件结构

```
noj-cli/src/judge/
├── options.ts          # JudgeOptions + parseJudgeArgs
├── options_test.ts
├── env.ts              # JudgeEnv 读写/校验
├── env_test.ts
├── checks.ts           # 环境/配置/socket/Redis/镜像检查
├── checks_test.ts
├── compose.ts          # Compose 生成与 docker compose 执行
├── compose_test.ts
├── redis.ts            # 本机 Redis 创建/连接信息（可选）
├── redis_test.ts
├── commands.ts         # runJudgeCommand 聚合
└── commands_test.ts
```

## Task 1: Judge 参数解析

**Files:**
- Create: `noj-cli/src/judge/options.ts`
- Create: `noj-cli/src/judge/options_test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `export interface JudgeOptions { command: "install" | "install-env" | "check" | "start" | "stop" | "status" | "logs" | "upgrade" | "download"; dir: string; envFile: string; composeFile: string; repo: string; ref: string; version?: string; redisContainer: string; redisPort: number; panel: "auto" | "baota" | "none"; nonInteractive: boolean; downloadOnly: boolean; dryRun: boolean; follow: boolean }`
  - `export function parseJudgeArgs(args: string[]): JudgeOptions`
  - `export const DEFAULT_JUDGE_DIR = "/srv/noj-judge"`

- [ ] **Step 1: 写失败测试**

创建 `noj-cli/src/judge/options_test.ts`：

```ts
import { assertEquals, assertThrows } from "@std/assert";
import { DEFAULT_JUDGE_DIR, parseJudgeArgs } from "./options.ts";

Deno.test("parseJudgeArgs: 缺省值", () => {
  const o = parseJudgeArgs(["install"]);
  assertEquals(o.command, "install");
  assertEquals(o.dir, DEFAULT_JUDGE_DIR);
  assertEquals(o.envFile, `${DEFAULT_JUDGE_DIR}/.env.judge`);
  assertEquals(o.composeFile, `${DEFAULT_JUDGE_DIR}/docker-compose.judge.yml`);
  assertEquals(o.repo, "https://github.com/Neuro-OJ/neuro-oj");
  assertEquals(o.ref, "main");
  assertEquals(o.nonInteractive, false);
  assertEquals(o.dryRun, false);
  assertEquals(o.follow, false);
});

Deno.test("parseJudgeArgs: 解析选项", () => {
  const o = parseJudgeArgs([
    "check",
    "--dir", "/srv/noj",
    "--env-file", "/tmp/env",
    "--compose-file", "/tmp/compose.yml",
    "--version", "v0.2.0",
    "--panel", "none",
    "--non-interactive",
    "--dry-run",
    "--follow",
  ]);
  assertEquals(o.command, "check");
  assertEquals(o.dir, "/srv/noj");
  assertEquals(o.envFile, "/tmp/env");
  assertEquals(o.composeFile, "/tmp/compose.yml");
  assertEquals(o.version, "v0.2.0");
  assertEquals(o.panel, "none");
  assertEquals(o.nonInteractive, true);
  assertEquals(o.dryRun, true);
  assertEquals(o.follow, true);
});

Deno.test("parseJudgeArgs: 非法 panel 抛错", () => {
  assertThrows(() => parseJudgeArgs(["install", "--panel", "bad"]));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/judge/options_test.ts`
Expected: FAIL，报找不到 `./options.ts`。

- [ ] **Step 3: 实现 `src/judge/options.ts`**

```ts
export const DEFAULT_JUDGE_DIR = "/srv/noj-judge";
export const DEFAULT_JUDGE_REPO = "https://github.com/Neuro-OJ/neuro-oj";
export const DEFAULT_JUDGE_REF = "main";
export const DEFAULT_REDIS_CONTAINER = "noj-judge-redis";
export const DEFAULT_REDIS_PORT = 16379;

export interface JudgeOptions {
  command: "install" | "install-env" | "check" | "start" | "stop" | "status" | "logs" | "upgrade" | "download";
  dir: string;
  envFile: string;
  composeFile: string;
  repo: string;
  ref: string;
  version: string | undefined;
  redisContainer: string;
  redisPort: number;
  panel: "auto" | "baota" | "none";
  nonInteractive: boolean;
  downloadOnly: boolean;
  dryRun: boolean;
  follow: boolean;
}

const COMMANDS = new Set([
  "install",
  "install-env",
  "check",
  "start",
  "stop",
  "status",
  "logs",
  "upgrade",
  "download",
]);

export function parseJudgeArgs(args: string[]): JudgeOptions {
  const out: JudgeOptions = {
    command: "check",
    dir: DEFAULT_JUDGE_DIR,
    envFile: "",
    composeFile: "",
    repo: DEFAULT_JUDGE_REPO,
    ref: DEFAULT_JUDGE_REF,
    version: undefined,
    redisContainer: DEFAULT_REDIS_CONTAINER,
    redisPort: DEFAULT_REDIS_PORT,
    panel: "auto",
    nonInteractive: false,
    downloadOnly: false,
    dryRun: false,
    follow: false,
  };
  let commandSet = false;
  const takeValue = (flag: string): string => {
    const i = args.indexOf(flag);
    if (i === -1) throw new Error(`judge: ${flag} 缺少参数`);
    const value = args[i + 1];
    if (value === undefined) throw new Error(`judge: ${flag} 缺少参数`);
    return value;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (COMMANDS.has(a) && !commandSet) {
      out.command = a as JudgeOptions["command"];
      commandSet = true;
      continue;
    }
    if (a.startsWith("--dir=")) {
      out.dir = a.slice(6);
    } else if (a === "--dir") {
      out.dir = takeValue(a);
      i++;
    } else if (a.startsWith("--env-file=")) {
      out.envFile = a.slice(11);
    } else if (a === "--env-file") {
      out.envFile = takeValue(a);
      i++;
    } else if (a.startsWith("--compose-file=")) {
      out.composeFile = a.slice(15);
    } else if (a === "--compose-file") {
      out.composeFile = takeValue(a);
      i++;
    } else if (a.startsWith("--repo=")) {
      out.repo = a.slice(7);
    } else if (a === "--repo") {
      out.repo = takeValue(a);
      i++;
    } else if (a.startsWith("--ref=")) {
      out.ref = a.slice(6);
    } else if (a === "--ref") {
      out.ref = takeValue(a);
      i++;
    } else if (a.startsWith("--version=")) {
      out.version = a.slice(10);
    } else if (a === "--version") {
      out.version = takeValue(a);
      i++;
    } else if (a.startsWith("--redis-container=")) {
      out.redisContainer = a.slice(18);
    } else if (a === "--redis-container") {
      out.redisContainer = takeValue(a);
      i++;
    } else if (a.startsWith("--redis-port=")) {
      out.redisPort = Number(a.slice(13));
    } else if (a === "--redis-port") {
      out.redisPort = Number(takeValue(a));
      i++;
    } else if (a.startsWith("--panel=")) {
      out.panel = a.slice(8) as JudgeOptions["panel"];
    } else if (a === "--panel") {
      out.panel = takeValue(a) as JudgeOptions["panel"];
      i++;
    } else if (a === "--non-interactive") {
      out.nonInteractive = true;
    } else if (a === "--download-only") {
      out.downloadOnly = true;
    } else if (a === "--dry-run") {
      out.dryRun = true;
    } else if (a === "--follow" || a === "-f") {
      out.follow = true;
    } else if (a === "--help" || a === "-h") {
      throw new Error("judge --help");
    } else {
      throw new Error(`未知 judge 参数: ${a}`);
    }
  }
  if (!commandSet) throw new Error("judge: 需要子命令");
  if (out.panel !== "auto" && out.panel !== "baota" && out.panel !== "none") {
    throw new Error(`judge: 非法 panel 模式: ${out.panel}`);
  }
  if (out.envFile === "") out.envFile = `${out.dir}/.env.judge`;
  if (out.composeFile === "") out.composeFile = `${out.dir}/docker-compose.judge.yml`;
  return out;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/judge/options_test.ts`
Expected: PASS。

- [ ] **Step 5: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj commit -m "feat(cli): 新增 judge 参数解析"
```

---

## Task 2: Judge 环境文件读写

**Files:**
- Create: `noj-cli/src/judge/env.ts`
- Create: `noj-cli/src/judge/env_test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `export interface JudgeEnv { values: Record<string, string> }`
  - `export function loadJudgeEnv(file: string): JudgeEnv`
  - `export function saveJudgeEnv(file: string, values: Record<string, string>): void`
  - `export function setJudgeEnv(file: string, key: string, value: string): void`
  - `export function envValue(env: JudgeEnv, key: string): string | undefined`

- [ ] **Step 1: 写失败测试**

```ts
import { assertEquals, assertThrows } from "@std/assert";
import { loadJudgeEnv, saveJudgeEnv, setJudgeEnv } from "./env.ts";

Deno.test("loadJudgeEnv: 解析 KEY=VALUE", () => {
  const dir = Deno.makeTempDirSync();
  const file = `${dir}/.env.judge`;
  Deno.writeTextFileSync(file, "NOJ_VERSION=v0.1.0\nREDIS_URL=redis://x/0\n");
  const env = loadJudgeEnv(file);
  assertEquals(envValue(env, "NOJ_VERSION"), "v0.1.0");
  assertEquals(envValue(env, "REDIS_URL"), "redis://x/0");
});

Deno.test("saveJudgeEnv: 写文件并保留权限 600", () => {
  const dir = Deno.makeTempDirSync();
  const file = `${dir}/.env.judge`;
  saveJudgeEnv(file, { NOJ_VERSION: "v0.1.0" });
  assertEquals(Deno.readTextFileSync(file), "NOJ_VERSION=v0.1.0\n");
  const mode = Deno.statSync(file).mode! & 0o777;
  assertEquals(mode, 0o600);
});

Deno.test("setJudgeEnv: 更新已有键", () => {
  const dir = Deno.makeTempDirSync();
  const file = `${dir}/.env.judge`;
  saveJudgeEnv(file, { A: "1" });
  setJudgeEnv(file, "A", "2");
  setJudgeEnv(file, "B", "3");
  const text = Deno.readTextFileSync(file);
  assertEquals(text.includes("A=2"), true);
  assertEquals(text.includes("B=3"), true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/judge/env_test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 `src/judge/env.ts`**

```ts
export interface JudgeEnv {
  values: Record<string, string>;
}

export function envValue(env: JudgeEnv, key: string): string | undefined {
  return env.values[key];
}

export function loadJudgeEnv(file: string): JudgeEnv {
  const values: Record<string, string> = {};
  try {
    const text = Deno.readTextFileSync(file);
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes("=")) continue;
      const eq = line.indexOf("=");
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key) values[key] = value;
    }
  } catch {
    // 文件不存在时返回空
  }
  return { values };
}

export function saveJudgeEnv(
  file: string,
  values: Record<string, string>,
): void {
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`);
  Deno.writeTextFileSync(file, lines.join("\n") + "\n");
  Deno.chmodSync(file, 0o600);
}

export function setJudgeEnv(file: string, key: string, value: string): void {
  const env = loadJudgeEnv(file);
  env.values[key] = value;
  saveJudgeEnv(file, env.values);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/judge/env_test.ts`
Expected: PASS。

- [ ] **Step 5: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj commit -m "feat(cli): 新增 judge 环境文件读写"
```

---

## Task 3: Judge 基础环境与配置检查

**Files:**
- Create: `noj-cli/src/judge/checks.ts`
- Create: `noj-cli/src/judge/checks_test.ts`

**Interfaces:**
- Consumes: `JudgeEnv`, `JudgeOptions`, `CommandRunner`（`noj-cli/src/runtime/command.ts`）。
- Produces:
  - `export function checkBaseEnvironment(opts: JudgeOptions, runner?: CommandRunner): Promise<void>`
  - `export function checkConfigValues(env: JudgeEnv): string[]` （返回问题列表）
  - `export function checkSocket(env: JudgeEnv, runner?: CommandRunner): Promise<string[]>` （返回问题列表）
  - `export function checkRedis(env: JudgeEnv, runner?: CommandRunner): Promise<string[]>` （返回问题列表）
  - `export function checkImageArchitecture(env: JudgeEnv, runner?: CommandRunner): Promise<string[]>` （返回问题列表）

- [ ] **Step 1: 写失败测试**

```ts
import { assertEquals } from "@std/assert";
import type { CommandRunner } from "../runtime/command.ts";
import {
  checkConfigValues,
  checkSocket,
  checkBaseEnvironment,
} from "./checks.ts";
import type { JudgeOptions } from "./options.ts";
import type { JudgeEnv } from "./env.ts";

function fakeRunner(): CommandRunner {
  return {
    async run() {
      return { code: 0, stdout: "", stderr: "" };
    },
    spawn() {
      throw new Error("not used");
    },
  };
}

const baseOpts: JudgeOptions = {
  command: "check",
  dir: "/srv/noj-judge",
  envFile: "/srv/noj-judge/.env.judge",
  composeFile: "/srv/noj-judge/docker-compose.judge.yml",
  repo: "https://github.com/Neuro-OJ/neuro-oj",
  ref: "main",
  version: undefined,
  redisContainer: "noj-judge-redis",
  redisPort: 16379,
  panel: "none",
  nonInteractive: true,
  downloadOnly: false,
  dryRun: false,
  follow: false,
};

function env(values: Record<string, string>): JudgeEnv {
  return { values };
}

Deno.test("checkConfigValues: 完整配置无问题", () => {
  const issues = checkConfigValues(env({
    NOJ_VERSION: "v0.1.0",
    REDIS_URL: "redis://127.0.0.1:6379/0",
    JUDGE_QUEUE: "noj:judge:queue",
    RESULT_QUEUE: "noj:judge:results",
    WORK_DIR: "/tmp/noj-judge",
    JUDGE_MAX_CONCURRENT_JUDGES: "2",
    JUDGE_IMAGE_PREFIX: "noj-",
    JUDGE_IMAGE_REGISTRY: "ghcr.io/neuro-oj",
    JUDGE_DOCKER_SOCKET: "/run/noj-judge/docker.sock",
    JUDGE_DOCKER_SOCKET_GID: "10001",
    JUDGE_UID: "10001",
    JUDGE_GID: "10001",
    JUDGE_DOCKER_HOST: "unix:///run/noj-judge/docker.sock",
    JUDGE_REQUIRE_ISOLATED_DOCKER: "true",
  }));
  assertEquals(issues, []);
});

Deno.test("checkConfigValues: 禁止的 socket 与占位值", () => {
  const issues = checkConfigValues(env({
    NOJ_VERSION: "latest",
    REDIS_URL: "change-me",
    JUDGE_DOCKER_SOCKET: "/var/run/docker.sock",
    JUDGE_DOCKER_SOCKET_GID: "abc",
    JUDGE_UID: "0",
    JUDGE_GID: "0",
    JUDGE_DOCKER_HOST: "unix:///var/run/docker.sock",
    JUDGE_REQUIRE_ISOLATED_DOCKER: "false",
  }));
  assertEquals(issues.length > 0, true);
});

Deno.test("checkBaseEnvironment: Linux + docker ok 不抛错", async () => {
  await checkBaseEnvironment(baseOpts, fakeRunner());
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/judge/checks_test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 `src/judge/checks.ts`**

参照 `scripts/deploy/judge-install.sh` 的函数：
- `check_base_environment`（第 636-682 行）
- `check_config_values`（第 665-695 行）
- `check_socket`（第 693-725 行）
- `check_redis`（第 726-756 行）
- `check_image_architecture`（第 759-785 行）

实现时使用 `runner.run` 调用 `docker`, `docker compose version`, `docker info`, `redis-cli`/`docker run`，并把 bash `fail` 改为返回 `string[]` 或抛错。`checkConfigValues` 等纯函数返回问题列表；涉及 I/O 的检查返回 Promise<string[]>。`checkBaseEnvironment` 抛错表示阻断。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/judge/checks_test.ts`
Expected: PASS。

- [ ] **Step 5: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj commit -m "feat(cli): 实现 judge 环境与配置检查"
```

---

## Task 4: Judge Compose 生成与执行

**Files:**
- Create: `noj-cli/src/judge/compose.ts`
- Create: `noj-cli/src/judge/compose_test.ts`

**Interfaces:**
- Consumes: `JudgeOptions`, `JudgeEnv`, `CommandRunner`。
- Produces:
  - `export function renderJudgeCompose(): string` （返回和 `judge-install.sh` 相同模板）
  - `export function writeJudgeCompose(file: string, dryRun: boolean): void`
  - `export function composeArgs(opts: JudgeOptions): string[]`
  - `export async function runJudgeCompose(opts: JudgeOptions, args: string[], runner?: CommandRunner): Promise<number>`

- [ ] **Step 1: 写失败测试**

```ts
import { assertEquals } from "@std/assert";
import { renderJudgeCompose, composeArgs, writeJudgeCompose } from "./compose.ts";
import type { JudgeOptions } from "./options.ts";

const opts: JudgeOptions = {
  command: "start",
  dir: "/srv/noj-judge",
  envFile: "/srv/noj-judge/.env.judge",
  composeFile: "/srv/noj-judge/docker-compose.judge.yml",
  repo: "https://github.com/Neuro-OJ/neuro-oj",
  ref: "main",
  version: undefined,
  redisContainer: "noj-judge-redis",
  redisPort: 16379,
  panel: "none",
  nonInteractive: true,
  downloadOnly: false,
  dryRun: false,
  follow: false,
};

Deno.test("renderJudgeCompose: 包含 noj-judge 镜像与安全配置", () => {
  const text = renderJudgeCompose();
  assertEquals(text.includes("noj-judge"), true);
  assertEquals(text.includes("cap_drop"), true);
  assertEquals(text.includes("no-new-privileges"), true);
  assertEquals(text.includes("JUDGE_REQUIRE_ISOLATED_DOCKER"), true);
});

Deno.test("composeArgs: 使用 project-name/env-file/file", () => {
  const args = composeArgs(opts);
  assertEquals(args.includes("--project-name"), true);
  assertEquals(args.includes("noj-judge-standalone"), true);
  assertEquals(args.includes("--env-file"), true);
  assertEquals(args.includes(opts.envFile), true);
  assertEquals(args.includes("-f"), true);
  assertEquals(args.includes(opts.composeFile), true);
});

Deno.test("writeJudgeCompose: 权限 600", () => {
  const file = `${Deno.makeTempDirSync()}/docker-compose.judge.yml`;
  writeJudgeCompose(file, false);
  const mode = Deno.statSync(file).mode! & 0o777;
  assertEquals(mode, 0o600);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/judge/compose_test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 `src/judge/compose.ts`**

将 `scripts/deploy/judge-install.sh` 中的 `write_compose` 模板原文复制为 `renderJudgeCompose()` 返回值（保持缩进和变量名一致）。`writeJudgeCompose` 用 `Deno.writeTextFileSync` + `chmod 600`。`composeArgs` 返回：

```ts
[
  "compose",
  "--project-name", "noj-judge-standalone",
  "--env-file", opts.envFile,
  "-f", opts.composeFile,
  ...args,
]
```

`runJudgeCompose` 在 `dryRun` 时打印命令并返回 0，否则 `runner.run("docker", composeArgs(...))` 并返回 code。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/judge/compose_test.ts`
Expected: PASS。

- [ ] **Step 5: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj commit -m "feat(cli): 实现 judge compose 生成与执行"
```

---

## Task 5: Judge Redis 本机创建

**Files:**
- Create: `noj-cli/src/judge/redis.ts`
- Create: `noj-cli/src/judge/redis_test.ts`

**Interfaces:**
- Consumes: `JudgeOptions`, `JudgeEnv`, `CommandRunner`。
- Produces:
  - `export interface RedisConnection { runtimeUrl: string; checkUrl: string; source: "existing" | "local" | "pending" }`
  - `export function generateRedisPassword(): string`
  - `export function validateRedisPort(port: number): void`
  - `export async function createLocalRedis(opts: JudgeOptions, runner?: CommandRunner): Promise<void>` （写入 `.redis-connection.env` 与 `redis-connection.txt`）
  - `export function redisConnectionFiles(opts: JudgeOptions): { metadata: string; guide: string }`

- [ ] **Step 1: 写失败测试**

```ts
import { assertEquals, assertThrows } from "@std/assert";
import { generateRedisPassword, validateRedisPort } from "./redis.ts";

Deno.test("generateRedisPassword: 长度大于 32", () => {
  assertEquals(generateRedisPassword().length >= 32, true);
});

Deno.test("validateRedisPort: 合法范围", () => {
  validateRedisPort(16379);
  assertThrows(() => validateRedisPort(80));
  assertThrows(() => validateRedisPort(70000));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/judge/redis_test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 `src/judge/redis.ts`**

移植 `scripts/deploy/judge-install.sh` 的 `generate_redis_password`、`validate_redis_port`、`create_local_redis`、`write_redis_connection_files`。用 `crypto.getRandomValues` 生成随机字节，`Deno.writeTextFileSync` 写文件并 `chmod 600`。`runner.run("docker", [...])` 创建容器。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/judge/redis_test.ts`
Expected: PASS。

- [ ] **Step 5: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj commit -m "feat(cli): 实现 judge 本机 Redis 管理"
```

---

## Task 6: Judge 命令聚合实现

**Files:**
- Create: `noj-cli/src/judge/commands.ts`
- Create: `noj-cli/src/judge/commands_test.ts`

**Interfaces:**
- Consumes: `JudgeOptions`, `JudgeEnv`, checks/compose/redis 模块。
- Produces:
  - `export async function runJudgeCommand(opts: JudgeOptions, runner?: CommandRunner): Promise<number>`

- [ ] **Step 1: 写失败测试**

```ts
import { assertEquals } from "@std/assert";
import type { CommandRunner } from "../runtime/command.ts";
import { runJudgeCommand } from "./commands.ts";
import type { JudgeOptions } from "./options.ts";

function fakeRunner(): CommandRunner {
  return {
    async run() {
      return { code: 0, stdout: "", stderr: "" };
    },
    spawn() {
      throw new Error("not used");
    },
  };
}

const opts: JudgeOptions = {
  command: "check",
  dir: "/srv/noj-judge",
  envFile: "/srv/noj-judge/.env.judge",
  composeFile: "/srv/noj-judge/docker-compose.judge.yml",
  repo: "https://github.com/Neuro-OJ/neuro-oj",
  ref: "main",
  version: undefined,
  redisContainer: "noj-judge-redis",
  redisPort: 16379,
  panel: "none",
  nonInteractive: true,
  downloadOnly: false,
  dryRun: true,
  follow: false,
};

Deno.test("judge check dry-run 返回 0", async () => {
  const code = await runJudgeCommand({ ...opts, dryRun: true }, fakeRunner());
  assertEquals(code, 0);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/judge/commands_test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 `src/judge/commands.ts`**

按 `scripts/deploy/judge-install.sh` 的 `main()` 映射：

| 命令 | 行为 |
|---|---|
| `install` | 初始化 env → 写 compose → check → pull → up |
| `install-env` | 检查 Docker/Compose 并输出 rootless 准备指引 |
| `check` | check_base_environment + check_configuration |
| `start` | check + compose up |
| `stop` | compose stop |
| `status` | check + 打印摘要 + compose ps |
| `logs` | compose logs --tail=200 [--follow] |
| `upgrade` | 可选更新 NOJ_VERSION → 写 compose → check → pull → up |
| `download` | 下载 `judge-install.sh` 到目标目录（保留兜底） |

`runJudgeCommand` 返回 0 或非零；错误打印 `judge: ...`。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/judge/commands_test.ts`
Expected: PASS。

- [ ] **Step 5: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj commit -m "feat(cli): 实现 judge 命令聚合"
```

---

## Task 7: CLI 挂载 judge 命令

**Files:**
- Modify: `noj-cli/src/cli.ts`
- Modify: `noj-cli/src/cli_test.ts`

**Interfaces:**
- Consumes: `parseJudgeArgs`, `runJudgeCommand`。
- Produces: `dispatchCommand("judge", args, ctx)` 返回退出码。

- [ ] **Step 1: 写失败测试**

在 `noj-cli/src/cli_test.ts` 追加：

```ts
Deno.test("judge 需要子命令时返回非零", async () => {
  // 无子命令应返回 1
  assertEquals(await dispatchCommand("judge", [], ctx), 1);
});
```

同时更新 `printHelp` 测试，使断言包含 `judge`（建议用 `judge <cmd>` 避免与现有文本误匹配）。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/cli_test.ts`
Expected: 当前 `judge` 未挂载，测试失败或 help 断言失败。

- [ ] **Step 3: 实现 CLI 挂载**

- `import { parseJudgeArgs } from "./judge/options.ts";`
- `import { runJudgeCommand } from "./judge/commands.ts";`
- 将 `"judge"` 加入 `KNOWN_TOP`。
- 在 `dispatchCommand` 新增：

```ts
case "judge": {
  try {
    const opts = parseJudgeArgs(args);
    return await runJudgeCommand(opts);
  } catch (e) {
    console.error(`judge: ${(e as Error).message}`);
    return 1;
  }
}
```

- 在 `printHelp()` 增加：

```text
"  judge <cmd>            独立 Judge Worker 管理（install/check/start/stop/status/logs/upgrade/download）",
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/cli_test.ts`
Expected: PASS。

- [ ] **Step 5: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj commit -m "feat(cli): 挂载 judge 命令"
```

---

## Task 8: 更新 README 与帮助

**Files:**
- Modify: `noj-cli/README.md`
- Modify: `noj-cli/src/cli.ts`（如帮助文本不完整）

**Interfaces:**
- Consumes: 前序任务产出的 `judge` 命令。
- Produces: 用户可读文档。

- [ ] **Step 1: 在 README 增加 judge 命令说明**

在 `noj-cli/README.md` 的“新增运维命令（Phase 1）”之后追加：

```markdown
## 独立 Judge 管理（Phase 2）

```bash
noj-cli judge install [--dir /srv/noj-judge]
noj-cli judge install-env
noj-cli judge check
noj-cli judge start
noj-cli judge stop
noj-cli judge status
noj-cli judge logs [--follow]
noj-cli judge upgrade [--version v0.2.0]
noj-cli judge download [--dir /srv/noj-judge]
```
```

- [ ] **Step 2: 运行验证**

Run: `cd noj-cli && deno task test && deno task check`
Run: `deno run -A scripts/verify-md-links.ts`
Expected: 全部通过。

- [ ] **Step 3: 提交**

```bash
jj commit -m "docs(cli): 更新 judge 命令说明"
```

---

## 后续

- Phase 3：`restore-drill`
- Phase 4：production Deno 化与旧命令别名统一
- Phase 5：脚本弃用与清理
