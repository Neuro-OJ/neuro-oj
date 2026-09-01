# noj-cli P3 maintain logs + maintain config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 P0/P1/P2 骨架之上实现 `noj-cli maintain logs`（all 或逗号分隔模块、彩色模块前缀、`--follow`、Docker 与 process 日志统一输出）与 `noj-cli maintain config check/show/set`（校验、脱敏显示、修改 JSON 配置），全部用可注入 fake runner / 临时文件的 Deno 测试覆盖。

**Architecture:** 在 `noj-cli/` 内新增 `src/maintain/` 层：`logs.ts` 负责日志编排（Docker 组件走 `docker compose -f <compose> logs --no-color [--follow] <service>`，process 组件读/尾随其日志文件），`config.ts` 负责配置 check/show/set（复用 P0 `validateConfig` 与 `loadDeployment`/`saveDeployment`）。为让 process 日志可被读取，扩展 P2 的 `CommandRunner`：`SpawnOpts` 增加可选 `stdoutFile`/`stderrFile`（spawn 时把子进程输出追加写入日志文件），`CommandRunner` 增加可选 `stream?` 方法（供 `--follow` 流式读取 docker 日志）；`startManagedProcess` 内部把输出写入 `<install_dir>/run/logs/<component>.log`，签名不变。`src/cli.ts` 仅做参数解析与装配。

**Tech Stack:** Deno 2（TypeScript，deno.json）、`@std/assert`（内置）、Deno 内置 `Deno.test`、`Deno.Command`（run/spawn/output）、`Deno.open` / `Deno.readTextFile` / `Deno.stat` / `Deno.mkdir`。Jujutsu (jj) 本地提交。仅支持 `linux/amd64`。

**Spec:** `dev-docs/superpowers/specs/2026-08-31-noj-cli-design.md`（P3 子集：maintain logs + maintain config）

## Global Constraints

- 语言：代码标识符使用英文，注释与提交描述使用中文。
- 运行时：仅 Deno 2 + TypeScript 标准环境，不引入第三方运行时依赖（不锁 `deno.lock`，见仓库 `.gitignore` 注释）。
- 平台：仅支持 `linux/amd64`（对应 `x86_64`）。
- 前置依赖（P0/P1/P2 已定义，本计划沿用其精确签名，不得改动其签名）：
  - `src/config/types.ts`：`DeployConfig`、`ComponentConfig`（`method: "docker" | "process"`、`enabled`、`env` 等）、`SecretsConfig`、`DeployState`、`SCHEMA_VERSION = 1`
  - `src/config/load.ts`：`loadDeployment(dir): Promise<{ config: DeployConfig; secrets: SecretsConfig }>`（缺失抛错）
  - `src/config/save.ts`：`saveDeployment(dir, config, secrets): Promise<void>`（deploy 644 / secrets 600，原子写，更新 `updated_at`）
  - `src/config/merge.ts`：`resolveComponentEnv(config, secrets, componentName): Record<string, string>`
  - `src/config/validate.ts`：`validateConfig(config, secrets): ValidationIssue[]`、`ValidationIssue { path; message }`
  - `src/state/machine.ts`：`transition(state, action)`
  - `src/util/find_deploy_dir.ts`：`findDeployDir(start?): string | null`
  - `src/runtime/command.ts`：`CommandRunner`、`CmdResult`、`SpawnOpts`、`SpawnHandle`、`realRunner()`
  - `src/runtime/process.ts`：`processLaunch(comp, env, cwd): SpawnOpts`、`startManagedProcess(runner, runDir, component, comp, env, cwd): Promise<{ pid }>`、`stopManagedProcess(...)`
  - `src/runtime/pidfile.ts`：`pidPath` / `writePid` / `readPid` / `removePid`
  - `src/deploy/compose.ts`：`COMPOSE_FILE = "docker-compose.noj.yml"`
  - `src/cli.ts`：`dispatchCommand(command, args, ctx)`、`CommandContext { cwd; deployDir }`、`run(argv)`
- 本计划对 P2 公共接口的扩展**只增不改**：`SpawnOpts` 增加可选字段 `stdoutFile?`/`stderrFile?`，`CommandRunner` 增加可选方法 `stream?`（P2 既有 fake runner 不实现该可选方法仍可编译）；`startManagedProcess` 签名不变，仅内部把输出写入日志文件。
- 日志文件路径约定：`<install_dir>/run/logs/<component>.log`（追加写，stdout 与 stderr 合并到同一文件）。
- `maintain logs` 只做最小检查：配置损坏时仍可运维（读取失败按模块报错并继续，不整体崩溃）。
- `maintain config check` 只检查不改变服务状态；`config show` 敏感字段脱敏；`config set` 写入前校验、写入后保持权限（经 `saveDeployment`）。
- 测试通过 `deno task test`（`deno test -A`）运行；代码通过 `deno fmt` 与 `deno lint`；类型通过 `deno task check`。
- 提交使用 jj（`jj describe -m "<type>(<scope>): <中文描述>"`），scope 为 `cli`；GPG 签名在仓库已全局开启，无需额外操作。
- 不修改与 P3 无关的文件（不触碰 `AGENTS.md`、`noj-core/` 等既有业务代码；不修改 P0/P1/P2 已交付公共接口的既有签名）。

---

### Task 1: 颜色与日志前缀工具 `src/util/color.ts`

**Files:**
- Create: `noj-cli/src/util/color.ts`
- Create: `noj-cli/src/util/color_test.ts`

**Interfaces:**
- Consumes: 无（纯工具）。
- Produces（Task 3 `maintain logs` 依赖）：
  - `export const RESET = "\x1b[0m"`
  - `export function colorFor(name: string): string`（按名字哈希从固定调色板取一个 ANSI 前景色码，如 `"\x1b[36m"`；同名恒同色）
  - `export function prefixLine(module: string, line: string, color: string): string`（返回 `color + "[" + module + "] " + line + RESET`；`line` 去掉末尾换行）

- [ ] **Step 1: 写失败测试**

创建 `noj-cli/src/util/color_test.ts`：

```ts
import { assertEquals } from "@std/assert";
import { RESET, colorFor, prefixLine } from "./color.ts";

Deno.test("colorFor: 同名恒同色，不同名可能不同色", () => {
  assertEquals(colorFor("server"), colorFor("server"));
  const palette = new Set<string>();
  for (const n of ["server", "ui", "judge", "postgres", "redis"]) {
    palette.add(colorFor(n));
  }
  // 调色板至少两种不同颜色，保证"不同模块不同色"的语义可被观察
  assertEquals(palette.size >= 2, true);
});

Deno.test("colorFor: 返回 ANSI 前景色码并以 m 结尾", () => {
  const c = colorFor("server");
  assertEquals(c.startsWith("\x1b["), true);
  assertEquals(c.endsWith("m"), true);
});

Deno.test("prefixLine: 加彩色模块前缀并去掉行尾换行", () => {
  const out = prefixLine("server", "hello\n", "\x1b[36m");
  assertEquals(out, "\x1b[36m[server] hello\x1b[0m");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/util/color_test.ts`
Expected: FAIL，`Error: Cannot find module .../color.ts`。

- [ ] **Step 3: 实现 `src/util/color.ts`**

```ts
/** ANSI 重置码。 */
export const RESET = "\x1b[0m";

/** 固定调色板：8 种可读 ANSI 前景色。 */
const PALETTE = [
  "\x1b[36m", // cyan
  "\x1b[32m", // green
  "\x1b[33m", // yellow
  "\x1b[35m", // magenta
  "\x1b[34m", // blue
  "\x1b[31m", // red
  "\x1b[96m", // bright cyan
  "\x1b[92m", // bright green
];

/** 简单字符串哈希（FNV-1a 32 位），用于稳定取色。 */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 按模块名稳定取一个 ANSI 前景色码。 */
export function colorFor(name: string): string {
  return PALETTE[hash(name) % PALETTE.length]!;
}

/** 给一行日志加彩色模块前缀；line 末尾换行会被去掉。 */
export function prefixLine(module: string, line: string, color: string): string {
  const trimmed = line.endsWith("\n") ? line.slice(0, -1) : line;
  return `${color}[${module}] ${trimmed}${RESET}`;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/util/color_test.ts`
Expected: PASS。

- [ ] **Step 5: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj split noj-cli/src/util/color.ts noj-cli/src/util/color_test.ts
jj describe -m "feat(cli): 实现彩色日志前缀工具 colorFor/prefixLine"
```

---

### Task 2: 进程日志捕获 —— 扩展 `command.ts` + 新增 `logfile.ts` + 修改 `process.ts`

**Files:**
- Modify: `noj-cli/src/runtime/command.ts`（`SpawnOpts` 加可选 `stdoutFile`/`stderrFile`；`CommandRunner` 加可选 `stream?`；`realRunner()` 实现两者）
- Modify: `noj-cli/src/runtime/command_test.ts`（新增用例）
- Create: `noj-cli/src/runtime/logfile.ts`
- Create: `noj-cli/src/runtime/logfile_test.ts`
- Modify: `noj-cli/src/runtime/process.ts`（`startManagedProcess` 内部把输出写入日志文件）
- Modify: `noj-cli/src/runtime/process_test.ts`（新增断言日志文件被写入）

**Interfaces:**
- Consumes: `SpawnOpts` / `SpawnHandle` / `CommandRunner` / `realRunner`（P2）、`processLaunch` / `startManagedProcess`（P2）。
- Produces（Task 3 `maintain logs` 依赖）：
  - `SpawnOpts` 新增可选字段：`stdoutFile?: string`、`stderrFile?: string`（存在时把子进程对应流追加写入该文件）
  - `CommandRunner` 新增可选方法：`stream?(cmd: string, args: string[], onLine: (line: string) => void, opts?: { cwd?: string; env?: Record<string, string> }): Promise<number>`（逐行回调，返回退出码；`realRunner()` 实现，P2 既有 fake 不实现仍可编译）
  - `export function logPath(runDir: string, component: string): string`（`${runDir}/logs/${component}.log`）
  - `export async function readRecentLog(path: string, maxBytes: number): Promise<string>`（读文件末尾最多 `maxBytes` 字节；文件缺失返回 `""`）
  - `export async function followLogFile(path: string, onLine: (line: string) => void, signal?: { aborted: boolean }): Promise<void>`（从文件末尾开始轮询新内容，按行回调；`signal.aborted` 为 true 时退出）
  - `startManagedProcess` 签名不变，内部把 stdout/stderr 追加写入 `logPath(runDir, component)`（先 `mkdir -p` logs 目录）

- [ ] **Step 1: 写失败测试**

在 `noj-cli/src/runtime/command_test.ts` 末尾追加：

```ts
Deno.test("realRunner.spawn: stdoutFile 捕获子进程输出", async () => {
  const dir = await Deno.makeTempDir();
  const log = `${dir}/out.log`;
  const handle = realRunner().spawn({
    cmd: "sh",
    args: ["-c", "echo hello-captured"],
    cwd: ".",
    env: {},
    stdoutFile: log,
  });
  const code = await handle.wait();
  assertEquals(code, 0);
  const text = await Deno.readTextFile(log);
  assertEquals(text.includes("hello-captured"), true);
});

Deno.test("realRunner.stream: 逐行回调并返回退出码", async () => {
  const lines: string[] = [];
  const r = realRunner();
  const code = await r.stream!("sh", ["-c", "printf 'a\\nb\\n'"], (l) => lines.push(l));
  assertEquals(code, 0);
  assertEquals(lines, ["a", "b"]);
});
```

创建 `noj-cli/src/runtime/logfile_test.ts`：

```ts
import { assertEquals } from "@std/assert";
import { logPath, readRecentLog, followLogFile } from "./logfile.ts";

Deno.test("logPath: 返回 run/logs/<component>.log", () => {
  assertEquals(logPath("/opt/neuro-oj/run", "server"), "/opt/neuro-oj/run/logs/server.log");
});

Deno.test("readRecentLog: 读末尾 maxBytes 字节", async () => {
  const dir = await Deno.makeTempDir();
  const p = `${dir}/a.log`;
  await Deno.writeTextFile(p, "0123456789");
  assertEquals(await readRecentLog(p, 4), "6789");
});

Deno.test("readRecentLog: 文件缺失返回空串", async () => {
  const dir = await Deno.makeTempDir();
  assertEquals(await readRecentLog(`${dir}/nope.log`, 100), "");
});

Deno.test("followLogFile: 从末尾开始轮询新内容并按行回调", async () => {
  const dir = await Deno.makeTempDir();
  const p = `${dir}/a.log`;
  await Deno.writeTextFile(p, "old-line\n");
  const seen: string[] = [];
  const signal = { aborted: false };
  const done = followLogFile(p, (l) => seen.push(l), signal);
  // 追加两行后等待回调
  await Deno.writeTextFile(p, "old-line\nnew-1\nnew-2\n", { append: true });
  await new Promise((r) => setTimeout(r, 50));
  signal.aborted = true;
  await done;
  assertEquals(seen, ["new-1", "new-2"]);
});
```

在 `noj-cli/src/runtime/process_test.ts` 末尾追加：

```ts
Deno.test("startManagedProcess: 输出写入 run/logs/<component>.log", async () => {
  const dir = await Deno.makeTempDir();
  const runDir = `${dir}/run`;
  const spawned: SpawnOpts[] = [];
  const runner = fakeRunner(spawned, []);
  await startManagedProcess(runner, runDir, "server", server, { PORT: "8000" }, dir);
  assertEquals(spawned[0]!.stdoutFile, `${runDir}/logs/server.log`);
  assertEquals(spawned[0]!.stderrFile, `${runDir}/logs/server.log`);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/runtime/command_test.ts src/runtime/logfile_test.ts src/runtime/process_test.ts`
Expected: FAIL，`logfile.ts` 模块不存在；`SpawnOpts` 无 `stdoutFile`/`stderrFile` 字段（类型错误）；`CommandRunner` 无 `stream` 方法。

- [ ] **Step 3: 扩展 `src/runtime/command.ts`**

将 `SpawnOpts` 接口替换为（新增两个可选字段）：

```ts
/** spawn 进程的参数。 */
export interface SpawnOpts {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** 存在时把子进程 stdout 追加写入该文件。 */
  stdoutFile?: string;
  /** 存在时把子进程 stderr 追加写入该文件。 */
  stderrFile?: string;
}
```

将 `CommandRunner` 接口替换为（新增可选 `stream` 方法）：

```ts
export interface CommandRunner {
  run(cmd: string, args: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<CmdResult>;
  spawn(opts: SpawnOpts): SpawnHandle;
  /** 逐行流式执行命令；onLine 每收到一行（不含换行）回调一次，返回退出码。可选：P2 既有 fake 可不实现。 */
  stream?(
    cmd: string,
    args: string[],
    onLine: (line: string) => void,
    opts?: { cwd?: string; env?: Record<string, string> },
  ): Promise<number>;
}
```

将 `realRunner()` 替换为（实现 stdoutFile/stderrFile 捕获与 stream）：

```ts
export function realRunner(): CommandRunner {
  return {
    async run(cmd, args, opts) {
      const p = new Deno.Command(cmd, {
        args,
        cwd: opts?.cwd,
        env: opts?.env,
        stdout: "piped",
        stderr: "piped",
      });
      const out = await p.output();
      return {
        code: out.code,
        stdout: new TextDecoder().decode(out.stdout),
        stderr: new TextDecoder().decode(out.stderr),
      };
    },
    spawn(opts) {
      const cmd = new Deno.Command(opts.cmd, {
        args: opts.args,
        cwd: opts.cwd,
        env: opts.env,
        stdout: opts.stdoutFile ? "piped" : "inherit",
        stderr: opts.stderrFile ? "piped" : "inherit",
      });
      const child = cmd.spawn();
      if (opts.stdoutFile) {
        const f = Deno.open(opts.stdoutFile, { write: true, create: true, append: true });
        f.then((file) => child.stdout.pipeTo(file.writable));
      }
      if (opts.stderrFile) {
        const f = Deno.open(opts.stderrFile, { write: true, create: true, append: true });
        f.then((file) => child.stderr.pipeTo(file.writable));
      }
      return {
        pid: child.pid,
        async wait() {
          return (await child.status).code;
        },
        async kill() {
          child.kill("SIGTERM");
        },
      };
    },
    async stream(cmd, args, onLine, opts) {
      const p = new Deno.Command(cmd, {
        args,
        cwd: opts?.cwd,
        env: opts?.env,
        stdout: "piped",
        stderr: "piped",
      });
      const child = p.spawn();
      const decoder = new TextDecoder();
      let buf = "";
      const reader = child.stdout.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.endsWith("\r")) onLine(line.slice(0, -1));
          else onLine(line);
        }
      }
      if (buf.length > 0) onLine(buf);
      return (await child.status).code;
    },
  };
}
```

- [ ] **Step 4: 实现 `src/runtime/logfile.ts`**

```ts
/** 进程日志文件路径：${runDir}/logs/<component>.log。 */
export function logPath(runDir: string, component: string): string {
  return `${runDir}/logs/${component}.log`;
}

/** 读文件末尾最多 maxBytes 字节；文件缺失返回空串。 */
export async function readRecentLog(path: string, maxBytes: number): Promise<string> {
  try {
    const info = await Deno.stat(path);
    if (!info.isFile) return "";
    const size = info.size;
    const start = Math.max(0, size - maxBytes);
    const f = await Deno.open(path, { read: true });
    try {
      await f.seek(start, Deno.SeekMode.Start);
      const buf = new Uint8Array(size - start);
      const n = await f.read(buf);
      return new TextDecoder().decode(buf.subarray(0, n ?? 0));
    } finally {
      f.close();
    }
  } catch {
    return "";
  }
}

/**
 * 从文件末尾开始轮询新内容，按行回调 onLine。
 * signal.aborted 为 true 时退出。轮询间隔 100ms。
 */
export async function followLogFile(
  path: string,
  onLine: (line: string) => void,
  signal: { aborted: boolean },
): Promise<void> {
  let offset = 0;
  try {
    const info = await Deno.stat(path);
    if (info.isFile) offset = info.size;
  } catch {
    // 文件尚不存在：从 0 开始，等待创建
  }
  let buf = "";
  while (!signal.aborted) {
    try {
      const info = await Deno.stat(path);
      if (info.isFile && info.size > offset) {
        const f = await Deno.open(path, { read: true });
        try {
          await f.seek(offset, Deno.SeekMode.Start);
          const chunk = new Uint8Array(info.size - offset);
          const n = await f.read(chunk);
          offset += n ?? 0;
          buf += new TextDecoder().decode(chunk.subarray(0, n ?? 0));
          let idx: number;
          while ((idx = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
            if (line.endsWith("\r")) onLine(line.slice(0, -1));
            else onLine(line);
          }
        } finally {
          f.close();
        }
      }
    } catch {
      // 文件被删/不可读：忽略，继续轮询
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (buf.length > 0) onLine(buf);
}
```

- [ ] **Step 5: 修改 `src/runtime/process.ts` 的 `startManagedProcess`**

将 `startManagedProcess` 函数体替换为（签名不变，内部写日志文件）：

```ts
export async function startManagedProcess(
  runner: CommandRunner,
  runDir: string,
  component: string,
  comp: ComponentConfig,
  env: Record<string, string>,
  cwd: string,
): Promise<{ pid: number }> {
  const opts = processLaunch(comp, env, cwd);
  const log = logPath(runDir, component);
  await Deno.mkdir(`${runDir}/logs`, { recursive: true });
  const handle = runner.spawn({ ...opts, stdoutFile: log, stderrFile: log });
  await writePid(runDir, component, handle.pid);
  return { pid: handle.pid };
}
```

在 `process.ts` 顶部 import 区追加：

```ts
import { logPath } from "./logfile.ts";
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/runtime/command_test.ts src/runtime/logfile_test.ts src/runtime/process_test.ts`
Expected: PASS（含 P2 既有用例与新增用例）。

- [ ] **Step 7: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj split noj-cli/src/runtime/command.ts noj-cli/src/runtime/command_test.ts noj-cli/src/runtime/logfile.ts noj-cli/src/runtime/logfile_test.ts noj-cli/src/runtime/process.ts noj-cli/src/runtime/process_test.ts
jj describe -m "feat(cli): 进程日志捕获与流式读取 logfile/stream"
```

---

### Task 3: `maintain logs` 编排 `src/maintain/logs.ts`

**Files:**
- Create: `noj-cli/src/maintain/logs.ts`
- Create: `noj-cli/src/maintain/logs_test.ts`

**Interfaces:**
- Consumes: `DeployConfig` / `ComponentConfig`（P0 `types.ts`）、`loadDeployment`（P0 `load.ts`）、`COMPOSE_FILE`（P2 `compose.ts`）、`CommandRunner` / `CmdResult`（P2 `command.ts`）、`logPath` / `readRecentLog` / `followLogFile`（Task 2）、`colorFor` / `prefixLine` / `RESET`（Task 1）。
- Produces（Task 5 `cli.ts` 依赖）：
  - `export interface LogsOptions { dir: string; modules: string[]; follow: boolean; runner?: CommandRunner }`
  - `export function parseModulesArg(arg: string | undefined, config: DeployConfig): string[]`（`undefined`/`"all"` → 全部 enabled 组件名；否则按英文逗号切分并 trim，过滤掉未启用/不存在的组件）
  - `export async function collectLogs(opts: LogsOptions): Promise<{ module: string; lines: string[] }[]>`（非 follow：Docker 组件 `docker compose -f <compose> logs --no-color <service>` 的 stdout 按行切分；process 组件读 `logPath(runDir, component)` 末尾 64 KiB；读取失败该模块返回空 lines 并继续）
  - `export async function followLogs(opts: LogsOptions, onLine: (module: string, line: string) => void): Promise<void>`（follow：Docker 组件用 `runner.stream!("docker", ["compose","-f",compose,"logs","--no-color","--follow",service], ...)`；process 组件用 `followLogFile`；`onLine` 收到的是未加前缀的原始行）
  - `export async function maintainLogs(opts: LogsOptions): Promise<number>`（非 follow 时打印 `prefixLine(module, line, colorFor(module))` 并返回 0；follow 时逐行打印并返回 0；配置缺失抛错）

- [ ] **Step 1: 写失败测试**

创建 `noj-cli/src/maintain/logs_test.ts`：

```ts
import { assertEquals } from "@std/assert";
import type { DeployConfig, SecretsConfig } from "../config/types.ts";
import type { CommandRunner, CmdResult, SpawnHandle, SpawnOpts } from "../runtime/command.ts";
import { parseModulesArg, collectLogs, followLogs } from "./logs.ts";

function config(): DeployConfig {
  return {
    schema_version: 1,
    type: "dev",
    state: "running",
    created_at: "2026-08-31T00:00:00Z",
    updated_at: "2026-08-31T00:00:00Z",
    install_dir: "/opt/neuro-oj",
    version: { noj_cli: "0.1.0", noj_server: "0.1.0" },
    env: {},
    components: {
      server: { enabled: true, method: "docker", image: "x", env: {} },
      ui: { enabled: true, method: "process", binary: "deno", env: {} },
      judge: { enabled: false, method: "docker", image: "y", env: {} },
    },
    reverse_proxy: { type: "nginx", config_dir: "/etc/nginx/conf.d", domain: "localhost", upstream_port: 8080 },
  };
}

function secrets(): SecretsConfig {
  return {
    schema_version: 1,
    created_at: "2026-08-31T00:00:00Z",
    updated_at: "2026-08-31T00:00:00Z",
    secrets: {},
  };
}

/** 可编程 fake runner：记录 run 调用，stream 逐行回调。 */
function fakeRunner(records: string[][], dockerOut: string): CommandRunner {
  return {
    async run(cmd, args) {
      records.push([cmd, ...args]);
      const r: CmdResult = { code: 0, stdout: dockerOut, stderr: "" };
      return r;
    },
    spawn(_opts: SpawnOpts): SpawnHandle {
      throw new Error("fake runner 不 spawn");
    },
    async stream(cmd, args, onLine) {
      records.push([cmd, ...args]);
      for (const l of dockerOut.split("\n")) {
        if (l.length > 0) onLine(l);
      }
      return 0;
    },
  };
}

Deno.test("parseModulesArg: all/缺省返回全部 enabled 组件", () => {
  const c = config();
  assertEquals(parseModulesArg(undefined, c), ["server", "ui"]);
  assertEquals(parseModulesArg("all", c), ["server", "ui"]);
});

Deno.test("parseModulesArg: 逗号分隔并过滤未启用/不存在", () => {
  const c = config();
  assertEquals(parseModulesArg("server,judge,ghost", c), ["server"]);
});

Deno.test("collectLogs: docker 走 compose logs，process 读日志文件", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(`${dir}/run/logs`, { recursive: true });
  await Deno.writeTextFile(`${dir}/run/logs/ui.log`, "ui-line-1\nui-line-2\n");
  const records: string[][] = [];
  const runner = fakeRunner(records, "server-line-1\nserver-line-2\n");
  const out = await collectLogs({ dir, modules: ["server", "ui"], follow: false, runner });
  assertEquals(records[0], ["docker", "compose", "-f", `${dir}/docker-compose.noj.yml`, "logs", "--no-color", "server"]);
  const server = out.find((m) => m.module === "server")!;
  assertEquals(server.lines, ["server-line-1", "server-line-2"]);
  const ui = out.find((m) => m.module === "ui")!;
  assertEquals(ui.lines, ["ui-line-1", "ui-line-2"]);
});

Deno.test("followLogs: docker 用 stream，process 用 followLogFile", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(`${dir}/run/logs`, { recursive: true });
  await Deno.writeTextFile(`${dir}/run/logs/ui.log`, "ui-old\n");
  const records: string[][] = [];
  const runner = fakeRunner(records, "server-follow-1\n");
  const seen: string[] = [];
  const done = followLogs(
    { dir, modules: ["server", "ui"], follow: true, runner },
    (m, l) => seen.push(`${m}:${l}`),
  );
  await Deno.writeTextFile(`${dir}/run/logs/ui.log`, "ui-old\nui-follow-1\n", { append: true });
  await new Promise((r) => setTimeout(r, 50));
  // 结束 follow：通过让 fake stream 立即返回 + 手动等待
  await done;
  assertEquals(records[0], ["docker", "compose", "-f", `${dir}/docker-compose.noj.yml`, "logs", "--no-color", "--follow", "server"]);
  assertEquals(seen.includes("server:server-follow-1"), true);
  assertEquals(seen.includes("ui:ui-follow-1"), true);
});
```

> **注意（对执行者）：** `followLogs` 对 process 组件调用 `followLogFile` 会一直轮询直到 `signal.aborted`。为让测试可结束，`followLogs` 内部对 process 组件使用一个共享的 `{ aborted: false }` 信号，并在所有 docker `stream` 返回后置 `aborted = true`。测试中 fake `stream` 立即返回，因此 `done` 会结束。若你的实现让 process 的 `followLogFile` 永不退出，请按上述共享信号设计实现（见 Step 3 代码）。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/maintain/logs_test.ts`
Expected: FAIL，`Error: Cannot find module .../logs.ts`。

- [ ] **Step 3: 实现 `src/maintain/logs.ts`**

```ts
import type { DeployConfig } from "../config/types.ts";
import { loadDeployment } from "../config/load.ts";
import { COMPOSE_FILE } from "../deploy/compose.ts";
import type { CommandRunner } from "../runtime/command.ts";
import { logPath, readRecentLog, followLogFile } from "../runtime/logfile.ts";
import { colorFor, prefixLine } from "../util/color.ts";

/** maintain logs 运行选项。 */
export interface LogsOptions {
  dir: string;
  modules: string[];
  follow: boolean;
  runner?: CommandRunner;
}

/** 单个模块的最近日志。 */
export interface ModuleLogs {
  module: string;
  lines: string[];
}

/** 解析 modules 参数：undefined/"all" → 全部 enabled 组件；否则逗号分隔并过滤。 */
export function parseModulesArg(arg: string | undefined, config: DeployConfig): string[] {
  const enabled = Object.entries(config.components)
    .filter(([, c]) => c.enabled)
    .map(([name]) => name);
  if (arg === undefined || arg === "all") return enabled;
  return arg
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && enabled.includes(s));
}

/** 返回 compose 文件绝对路径。 */
function composePathOf(config: DeployConfig): string {
  return `${config.install_dir}/${COMPOSE_FILE}`;
}

/** 返回 run 目录。 */
function runDirOf(config: DeployConfig): string {
  return `${config.install_dir}/run`;
}

/** 收集各模块最近日志（非 follow）。 */
export async function collectLogs(opts: LogsOptions): Promise<ModuleLogs[]> {
  const runner = opts.runner ?? realRunner();
  const { config } = await loadDeployment(opts.dir);
  const out: ModuleLogs[] = [];
  for (const name of opts.modules) {
    const comp = config.components[name];
    if (!comp || !comp.enabled) continue;
    if (comp.method === "docker") {
      const r = await runner.run("docker", [
        "compose", "-f", composePathOf(config), "logs", "--no-color", name,
      ]);
      const lines = r.stdout.split("\n").filter((l) => l.length > 0);
      out.push({ module: name, lines });
    } else {
      const text = await readRecentLog(logPath(runDirOf(config), name), 64 * 1024);
      const lines = text.split("\n").filter((l) => l.length > 0);
      out.push({ module: name, lines });
    }
  }
  return out;
}

/** follow 各模块日志；onLine 收到未加前缀的原始行。 */
export async function followLogs(
  opts: LogsOptions,
  onLine: (module: string, line: string) => void,
): Promise<void> {
  const runner = opts.runner ?? realRunner();
  const { config } = await loadDeployment(opts.dir);
  const signal = { aborted: false };
  const tasks: Promise<void>[] = [];
  for (const name of opts.modules) {
    const comp = config.components[name];
    if (!comp || !comp.enabled) continue;
    if (comp.method === "docker") {
      if (runner.stream) {
        tasks.push(
          runner.stream(
            "docker",
            ["compose", "-f", composePathOf(config), "logs", "--no-color", "--follow", name],
            (l) => onLine(name, l),
          ).then(() => {}),
        );
      }
    } else {
      tasks.push(followLogFile(logPath(runDirOf(config), name), (l) => onLine(name, l), signal));
    }
  }
  // 等所有 docker stream 结束（进程 follow 由 signal 控制）
  await Promise.all(tasks);
  signal.aborted = true;
}

/** maintain logs 命令入口：非 follow 打印最近日志，follow 逐行打印。 */
export async function maintainLogs(opts: LogsOptions): Promise<number> {
  if (opts.follow) {
    await followLogs(opts, (module, line) => {
      console.log(prefixLine(module, line, colorFor(module)));
    });
    return 0;
  }
  const logs = await collectLogs(opts);
  for (const m of logs) {
    for (const line of m.lines) {
      console.log(prefixLine(m.module, line, colorFor(m.module)));
    }
  }
  return 0;
}
```

> **注意（对执行者）：** 上面 `collectLogs`/`followLogs` 用到 `realRunner`，需在文件顶部 import 区追加 `import { realRunner } from "../runtime/command.ts";`。`maintainLogs` 在配置缺失时由 `loadDeployment` 抛错，符合"配置损坏时仍可运维"的语义由调用方（cli.ts）捕获处理。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/maintain/logs_test.ts`
Expected: PASS。

- [ ] **Step 5: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj split noj-cli/src/maintain/logs.ts noj-cli/src/maintain/logs_test.ts
jj describe -m "feat(cli): 实现 maintain logs 编排 collectLogs/followLogs"
```

---

### Task 4: `maintain config` 编排 `src/maintain/config.ts`

**Files:**
- Create: `noj-cli/src/maintain/config.ts`
- Create: `noj-cli/src/maintain/config_test.ts`

**Interfaces:**
- Consumes: `DeployConfig` / `SecretsConfig`（P0 `types.ts`）、`loadDeployment` / `saveDeployment`（P0）、`validateConfig` / `ValidationIssue`（P0 `validate.ts`）。
- Produces（Task 5 `cli.ts` 依赖）：
  - `export function maskSecrets(config: DeployConfig): DeployConfig`（深拷贝；对 `env` 与各组件 `env` 中 key 含 `SECRET`/`PASSWORD`/`TOKEN`/`KEY`（不区分大小写）的值替换为 `"***"`）
  - `export function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void`（按 `.` 分隔的路径逐级进入；中间层不存在则创建对象；末级赋值）
  - `export function parseConfigValue(raw: string): string | number | boolean`（`"true"`/`"false"` → boolean；纯数字 → number；否则原样字符串）
  - `export async function configCheck(dir: string): Promise<ValidationIssue[]>`（`loadDeployment` → `validateConfig`）
  - `export async function configShow(dir: string): Promise<string>`（`loadDeployment` → `maskSecrets(config)` → `JSON.stringify(..., null, 2)`）
  - `export async function configSet(dir: string, key: string, value: string): Promise<void>`（`loadDeployment` → `setByPath(config, key, parseConfigValue(value))` → `validateConfig` 有违规则抛错 → `saveDeployment(dir, config, secrets)`）

- [ ] **Step 1: 写失败测试**

创建 `noj-cli/src/maintain/config_test.ts`：

```ts
import { assertEquals, assertRejects } from "@std/assert";
import type { DeployConfig, SecretsConfig } from "../config/types.ts";
import { maskSecrets, setByPath, parseConfigValue, configCheck, configShow, configSet } from "./config.ts";

function config(): DeployConfig {
  return {
    schema_version: 1,
    type: "prod",
    state: "stopped",
    created_at: "2026-08-31T00:00:00Z",
    updated_at: "2026-08-31T00:00:00Z",
    install_dir: "/opt/neuro-oj",
    version: { noj_cli: "0.1.0", noj_server: "0.1.0" },
    env: { DOMAIN: "oj.example.com", JWT_SECRET: "super-secret" },
    components: {
      server: { enabled: true, method: "docker", image: "x", env: { PORT: "8000", DB_PASSWORD: "pw" } },
    },
    reverse_proxy: { type: "nginx", config_dir: "/etc/nginx/conf.d", domain: "oj.example.com", upstream_port: 8080 },
  };
}

function secrets(): SecretsConfig {
  return {
    schema_version: 1,
    created_at: "2026-08-31T00:00:00Z",
    updated_at: "2026-08-31T00:00:00Z",
    secrets: { JWT_SECRET: "x".repeat(32) },
  };
}

async function writeFixture(dir: string): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/noj-deploy.json`, JSON.stringify(config()));
  await Deno.writeTextFile(`${dir}/noj-secrets.json`, JSON.stringify(secrets()));
}

Deno.test("maskSecrets: 敏感 key 值被替换为 ***，其余保留", () => {
  const m = maskSecrets(config());
  assertEquals(m.env["DOMAIN"], "oj.example.com");
  assertEquals(m.env["JWT_SECRET"], "***");
  assertEquals(m.components["server"]!.env["DB_PASSWORD"], "***");
  assertEquals(m.components["server"]!.env["PORT"], "8000");
  // 不修改原对象
  assertEquals(config().env["JWT_SECRET"], "super-secret");
});

Deno.test("setByPath: 设置嵌套路径并创建中间对象", () => {
  const obj: Record<string, unknown> = { a: { b: 1 } };
  setByPath(obj, "a.b", 2);
  assertEquals(obj["a"], { b: 2 });
  setByPath(obj, "x.y.z", "v");
  assertEquals(obj["x"], { y: { z: "v" } });
});

Deno.test("parseConfigValue: 布尔/数字/字符串", () => {
  assertEquals(parseConfigValue("true"), true);
  assertEquals(parseConfigValue("false"), false);
  assertEquals(parseConfigValue("8080"), 8080);
  assertEquals(parseConfigValue("hello"), "hello");
});

Deno.test("configCheck: 合法配置返回空数组", async () => {
  const dir = await Deno.makeTempDir();
  await writeFixture(dir);
  assertEquals(await configCheck(dir), []);
});

Deno.test("configShow: 输出脱敏后的 JSON", async () => {
  const dir = await Deno.makeTempDir();
  await writeFixture(dir);
  const text = await configShow(dir);
  const parsed = JSON.parse(text) as DeployConfig;
  assertEquals(parsed.env["JWT_SECRET"], "***");
  assertEquals(parsed.env["DOMAIN"], "oj.example.com");
});

Deno.test("configSet: 修改配置并落盘，权限保持", async () => {
  const dir = await Deno.makeTempDir();
  await writeFixture(dir);
  await configSet(dir, "env.DOMAIN", "new.example.com");
  const { config: c } = await import("../config/load.ts").then((m) => m.loadDeployment(dir));
  assertEquals(c.env["DOMAIN"], "new.example.com");
  const st = await Deno.stat(`${dir}/noj-deploy.json`);
  assertEquals(st.mode & 0o777, 0o644);
});

Deno.test("configSet: 校验失败时抛错且不落盘", async () => {
  const dir = await Deno.makeTempDir();
  await writeFixture(dir);
  // 把 schema_version 改坏
  await assertRejects(() => configSet(dir, "schema_version", "2"), Error, /schema_version/);
  const { config: c } = await import("../config/load.ts").then((m) => m.loadDeployment(dir));
  assertEquals(c.schema_version, 1);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/maintain/config_test.ts`
Expected: FAIL，`Error: Cannot find module .../config.ts`。

- [ ] **Step 3: 实现 `src/maintain/config.ts`**

```ts
import type { DeployConfig } from "../config/types.ts";
import { loadDeployment } from "../config/load.ts";
import { saveDeployment } from "../config/save.ts";
import { validateConfig, type ValidationIssue } from "../config/validate.ts";

/** 判断 key 是否敏感（含 SECRET/PASSWORD/TOKEN/KEY，不区分大小写）。 */
function isSensitiveKey(key: string): boolean {
  const k = key.toUpperCase();
  return k.includes("SECRET") || k.includes("PASSWORD") || k.includes("TOKEN") || k.includes("KEY");
}

/** 深拷贝配置并把敏感 env 值替换为 ***。 */
export function maskSecrets(config: DeployConfig): DeployConfig {
  const copy: DeployConfig = JSON.parse(JSON.stringify(config)) as DeployConfig;
  for (const [k, v] of Object.entries(copy.env)) {
    if (isSensitiveKey(k)) copy.env[k] = "***";
  }
  for (const comp of Object.values(copy.components)) {
    for (const [k, v] of Object.entries(comp.env)) {
      if (isSensitiveKey(k)) comp.env[k] = "***";
    }
  }
  return copy;
}

/** 按 . 分隔路径设置值；中间层不存在则创建对象。 */
export function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const next = cur[key];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      cur[key] = {};
    }
    cur = cur[key] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

/** 把命令行字符串解析为 JSON 值：true/false → boolean，纯数字 → number，否则字符串。 */
export function parseConfigValue(raw: string): string | number | boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  return raw;
}

/** config check：只校验，不改变状态。 */
export async function configCheck(dir: string): Promise<ValidationIssue[]> {
  const { config, secrets } = await loadDeployment(dir);
  return validateConfig(config, secrets);
}

/** config show：输出脱敏后的 JSON 文本。 */
export async function configShow(dir: string): Promise<string> {
  const { config } = await loadDeployment(dir);
  return JSON.stringify(maskSecrets(config), null, 2);
}

/** config set：修改单个配置项，写入前校验，写入后保持权限。 */
export async function configSet(dir: string, key: string, value: string): Promise<void> {
  const { config, secrets } = await loadDeployment(dir);
  setByPath(config as unknown as Record<string, unknown>, key, parseConfigValue(value));
  const issues = validateConfig(config, secrets);
  if (issues.length > 0) {
    const first = issues[0]!;
    throw new Error(`配置校验失败: ${first.path} ${first.message}`);
  }
  await saveDeployment(dir, config, secrets);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/maintain/config_test.ts`
Expected: PASS。

- [ ] **Step 5: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj split noj-cli/src/maintain/config.ts noj-cli/src/maintain/config_test.ts
jj describe -m "feat(cli): 实现 maintain config check/show/set"
```

---

### Task 5: 接入 `maintain logs` 与 `maintain config` 到 `src/cli.ts`

**Files:**
- Modify: `noj-cli/src/cli.ts`（`case "maintain":` 分支，替换 P0/P1/P2 占位）
- Modify: `noj-cli/src/cli_test.ts`（新增用例）

**Interfaces:**
- Consumes: `maintainLogs` / `LogsOptions` / `parseModulesArg`（Task 3）、`configCheck` / `configShow` / `configSet`（Task 4）、`findDeployDir`（P0）、`CommandContext { cwd; deployDir }`（P0）。
- Produces：
  - `export function parseMaintainArgs(args: string[]): { dir: string | undefined; follow: boolean; modules: string | undefined }`（解析 `--dir <path>`、`--follow`、以及位置参数 modules）
  - `maintain logs [modules] [--follow] [--dir <path>]` 命令分支：定位部署目录 → `parseModulesArg` → `maintainLogs` → 返回 `0`；配置缺失时打印错误返回 `1`
  - `maintain config check/show/set <key> <value>` 命令分支：`check` 打印问题清单（有则返回 `1`）；`show` 打印脱敏 JSON；`set` 调用 `configSet` 并打印成功消息；配置缺失/校验失败打印错误返回 `1`

- [ ] **Step 1: 写失败测试**

在 `noj-cli/src/cli_test.ts` 末尾追加：

```ts
import { parseMaintainArgs } from "./cli.ts";

Deno.test("parseMaintainArgs: 缺省 modules/follow/dir", () => {
  const a = parseMaintainArgs([]);
  assertEquals(a.modules, undefined);
  assertEquals(a.follow, false);
  assertEquals(a.dir, undefined);
});

Deno.test("parseMaintainArgs: 解析 modules 与 --follow --dir", () => {
  const a = parseMaintainArgs(["server,ui", "--follow", "--dir", "/opt"]);
  assertEquals(a.modules, "server,ui");
  assertEquals(a.follow, true);
  assertEquals(a.dir, "/opt");
});
```

> **注意（对执行者）：** `cli_test.ts` 中 `assertEquals` 已在既有 import 中。若你的 `cli_test.ts` 尚未 import `parseMaintainArgs`，请把上面 import 行合并到文件顶部既有 import 区。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/cli_test.ts`
Expected: FAIL，`parseMaintainArgs` 未定义。

- [ ] **Step 3: 实现 `parseMaintainArgs` 并接入 maintain 分支**

在 `noj-cli/src/cli.ts` 顶部 import 区追加：

```ts
import { maintainLogs, parseModulesArg } from "./maintain/logs.ts";
import { configCheck, configShow, configSet } from "./maintain/config.ts";
```

在文件内新增：

```ts
/** 解析 maintain 参数：--dir <path>、--follow、位置参数 modules。 */
export function parseMaintainArgs(args: string[]): {
  dir: string | undefined;
  follow: boolean;
  modules: string | undefined;
} {
  let dir: string | undefined;
  let follow = false;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--dir") {
      dir = args[i + 1];
      i++;
    } else if (a === "--follow") {
      follow = true;
    } else {
      positional.push(a);
    }
  }
  return { dir, follow, modules: positional[0] };
}
```

将 `dispatchCommand` 的 `case "maintain":` 分支替换为：

```ts
case "maintain": {
  const sub = args[0] ?? "";
  if (sub === "logs") {
    const { dir, follow, modules } = parseMaintainArgs(args.slice(1));
    const deployDir = dir ?? ctx.deployDir ?? findDeployDir(ctx.cwd);
    if (deployDir === null) {
      console.error("maintain logs: 未找到 noj-deploy.json，请先运行 deploy init");
      return 1;
    }
    try {
      const { config } = await loadDeployment(deployDir);
      const mods = parseModulesArg(modules, config);
      await maintainLogs({ dir: deployDir, modules: mods, follow });
      return 0;
    } catch (e) {
      console.error(`maintain logs: ${(e as Error).message}`);
      return 1;
    }
  }
  if (sub === "config") {
    const action = args[1] ?? "";
    const deployDir = ctx.deployDir ?? findDeployDir(ctx.cwd);
    if (deployDir === null) {
      console.error("maintain config: 未找到 noj-deploy.json，请先运行 deploy init");
      return 1;
    }
    try {
      switch (action) {
        case "check": {
          const issues = await configCheck(deployDir);
          if (issues.length === 0) {
            console.log("配置校验通过");
            return 0;
          }
          for (const i of issues) {
            console.error(`  ${i.path}: ${i.message}`);
          }
          return 1;
        }
        case "show": {
          console.log(await configShow(deployDir));
          return 0;
        }
        case "set": {
          const key = args[2];
          const value = args[3];
          if (key === undefined || value === undefined) {
            console.error("maintain config set: 需要 <key> <value>");
            return 1;
          }
          await configSet(deployDir, key, value);
          console.log(`已更新 ${key} = ${value}`);
          return 0;
        }
        default:
          console.log("maintain config: 需要子命令 check/show/set");
          return 0;
      }
    } catch (e) {
      console.error(`maintain config: ${(e as Error).message}`);
      return 1;
    }
  }
  if (MAINTAIN_SUBCOMMANDS.includes(sub)) {
    console.log(`maintain ${sub}: 运维逻辑留待后续计划`);
  } else {
    console.log("maintain: 需要子命令 logs/backup/restore/verify/reset/config（P0 占位）");
  }
  return 0;
}
```

> **注意（对执行者）：** 上面 `case "maintain":` 用到 `loadDeployment`，需在 `cli.ts` 顶部 import 区追加 `import { loadDeployment } from "./config/load.ts";`。`MAINTAIN_SUBCOMMANDS` 常量在 P0 已定义，保留不动。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/cli_test.ts`
Expected: PASS。

- [ ] **Step 5: 手动冒烟验证（临时目录）**

Run:
```bash
cd noj-cli && TMP=$(mktemp -d)
# 构造最小配置
cat > "$TMP/noj-deploy.json" <<'EOF'
{"schema_version":1,"type":"dev","state":"stopped","created_at":"2026-08-31T00:00:00Z","updated_at":"2026-08-31T00:00:00Z","install_dir":"/opt/neuro-oj","version":{"noj_cli":"0.1.0","noj_server":"0.1.0"},"env":{"DOMAIN":"oj.example.com","JWT_SECRET":"super-secret"},"components":{"server":{"enabled":true,"method":"docker","image":"x","env":{"PORT":"8000"}}},"reverse_proxy":{"type":"nginx","config_dir":"/etc/nginx/conf.d","domain":"oj.example.com","upstream_port":8080}}
EOF
echo '{"schema_version":1,"created_at":"2026-08-31T00:00:00Z","updated_at":"2026-08-31T00:00:00Z","secrets":{"JWT_SECRET":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}}' > "$TMP/noj-secrets.json"
deno run -A src/cli.ts maintain config show --dir "$TMP" | head -5
deno run -A src/cli.ts maintain config check --dir "$TMP"
deno run -A src/cli.ts maintain config set env.DOMAIN new.example.com --dir "$TMP"
```
Expected: `show` 输出脱敏 JSON（`JWT_SECRET` 为 `***`）；`check` 输出「配置校验通过」；`set` 输出「已更新 env.DOMAIN = new.example.com」。

- [ ] **Step 6: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj split noj-cli/src/cli.ts noj-cli/src/cli_test.ts
jj describe -m "feat(cli): 接入 maintain logs 与 maintain config 命令"
```

---

### Task 6: P3 收尾 —— 公共导出、文档与全量验证

**Files:**
- Modify: `noj-cli/src/mod.ts`（聚合导出 P3 公共接口）
- Modify: `noj-cli/README.md`（补充 P3 范围与用法）

**Interfaces:**
- Consumes: Task 1–5 全部产物。
- Produces：`src/mod.ts` 聚合导出 `colorFor`/`prefixLine`/`RESET`、`logPath`/`readRecentLog`/`followLogFile`、`maintainLogs`/`parseModulesArg`/`LogsOptions`、`configCheck`/`configShow`/`configSet`/`maskSecrets`/`setByPath`/`parseConfigValue`。

- [ ] **Step 1: 更新 `src/mod.ts` 聚合导出**

在 `noj-cli/src/mod.ts` 末尾追加（保留原 P0/P1/P2 导出）：

```ts
// util（P3）
export { colorFor, prefixLine, RESET } from "./util/color.ts";

// runtime（P3）
export { logPath, readRecentLog, followLogFile } from "./runtime/logfile.ts";

// maintain（P3）
export { maintainLogs, parseModulesArg } from "./maintain/logs.ts";
export type { LogsOptions, ModuleLogs } from "./maintain/logs.ts";
export { configCheck, configShow, configSet, maskSecrets, setByPath, parseConfigValue } from "./maintain/config.ts";
```

- [ ] **Step 2: 验证导出的类型检查**

Run: `cd noj-cli && deno task check`
Expected: 通过。

- [ ] **Step 3: 全量测试**

Run: `cd noj-cli && deno task test`
Expected: 全部 PASS（含 P0/P1/P2 既有测试与 P3 新增测试）。

- [ ] **Step 4: 更新 `noj-cli/README.md`**

在 `## 状态` 一节追加 P3 说明，并补充用法：

```markdown
## 状态

P3：实现 `maintain logs` 与 `maintain config`。`maintain logs [modules] [--follow]`
按模块输出彩色前缀日志：Docker 组件走 `docker compose logs --no-color [--follow]`，
process 组件读/尾随 `<install_dir>/run/logs/<component>.log`（进程输出在 spawn 时
追加写入该文件）。`maintain config check/show/set` 分别做校验、脱敏显示、修改 JSON
配置（写入前校验、经 `saveDeployment` 保持权限）。`backup/restore/verify/reset`
留待后续计划。

## 用法

  noj-cli maintain logs                      # 全部模块最近日志
  noj-cli maintain logs server,ui --follow   # 跟随 server 与 ui 日志
  noj-cli maintain config check              # 校验配置
  noj-cli maintain config show               # 脱敏显示配置
  noj-cli maintain config set env.DOMAIN example.com   # 修改配置项
```

- [ ] **Step 5: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj split noj-cli/src/mod.ts noj-cli/README.md
jj describe -m "docs(cli): P3 收尾聚合导出与 README 更新"
```

---

## Self-Review

### Spec 覆盖

- **maintain logs：all 或逗号分隔模块** → Task 3 `parseModulesArg`（`undefined`/`"all"` → 全部 enabled；逗号分隔过滤）。
- **彩色模块前缀** → Task 1 `colorFor`/`prefixLine` + Task 3 `maintainLogs` 打印。
- **支持 `--follow`** → Task 2 `stream?`/`followLogFile` + Task 3 `followLogs` + Task 5 `--follow` 解析。
- **Docker 和 process 日志统一输出** → Task 3 `collectLogs`/`followLogs` 按 `method` 分发，统一 `[模块]` 前缀。
- **maintain config check/show/set** → Task 4 `configCheck`/`configShow`/`configSet`。
- **校验** → Task 4 复用 P0 `validateConfig`。
- **脱敏显示** → Task 4 `maskSecrets`。
- **修改 JSON 配置** → Task 4 `setByPath` + `saveDeployment`（保持权限）。
- **写 Deno 测试** → 每个 Task 均有 `*_test.ts` 与失败→通过循环。

### 占位符扫描

无 TBD/TODO/“类似上文”等占位；每个代码步骤均给出真实代码与命令。

### 类型一致性

- `SpawnOpts` 新增 `stdoutFile?`/`stderrFile?`（Task 2 定义，Task 2 测试与 Task 3 使用一致）。
- `CommandRunner.stream?` 签名在 Task 2 定义，Task 3 `followLogs` 使用 `runner.stream(...)` 一致。
- `logPath`/`readRecentLog`/`followLogFile` 在 Task 2 定义，Task 3 使用一致。
- `colorFor`/`prefixLine`/`RESET` 在 Task 1 定义，Task 3 使用一致。
- `parseModulesArg`/`maintainLogs`/`LogsOptions` 在 Task 3 定义，Task 5 使用一致。
- `configCheck`/`configShow`/`configSet`/`maskSecrets`/`setByPath`/`parseConfigValue` 在 Task 4 定义，Task 5 使用一致。
- `parseMaintainArgs` 在 Task 5 定义并被 Task 5 测试使用。
- P0/P1/P2 公共接口签名（`loadDeployment`/`saveDeployment`/`validateConfig`/`COMPOSE_FILE`/`CommandRunner` 既有成员等）未被改动，仅新增可选成员。
