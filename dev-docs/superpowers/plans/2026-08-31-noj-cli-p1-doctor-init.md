# noj-cli P1 doctor + deploy init Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 P0 骨架之上实现 `noj-cli doctor`（只读环境检测）与 `noj-cli deploy init`（dev/prod 模式 TUI 引导生成 `noj-deploy.json` + `noj-secrets.json`），并为两者补齐可注入 fake 的 Deno 单元测试。

**Architecture:** 在 `noj-cli/` 内新增两个独立模块。`src/doctor/` 通过可注入的 `SystemProbe` 抽象（真实实现用 `Deno.Command` / `/proc/meminfo` / `df` / `Deno.connect`）执行只读检测，产出 `CheckResult[]` 与彩色报告，不写任何文件。`src/tui/` 提供可注入的 `PromptIO` 抽象与自绘 ANSI 表单控件（select/input/secret/confirm），`src/init/` 在其上实现 dev/prod 引导流程，最终返回 `{ config, secrets }` 交由 `saveDeployment` 落盘。`src/cli.ts` 仅做参数解析与装配，不承载业务逻辑。

**Tech Stack:** Deno 2（TypeScript，deno.json）、`@std/assert`（内置）、Deno 内置 `Deno.test`、`Deno.Command`、`Deno.connect`、`crypto.getRandomValues`。Jujutsu (jj) 本地提交。仅支持 `linux/amd64`。

**Spec:** `dev-docs/superpowers/specs/2026-08-31-noj-cli-design.md`（P1 子集：doctor + deploy init）

## Global Constraints

- 语言：代码标识符使用英文，注释与提交描述使用中文。
- 运行时：仅 Deno 2 + TypeScript 标准环境，不引入第三方运行时依赖（不锁 `deno.lock`，见仓库 `.gitignore` 注释）。TUI 采用**自绘 ANSI 表单**（不引入 Cliffy），以保证 `PromptIO` 可注入、可测试。
- 平台：仅支持 `linux/amd64`（对应 `x86_64`）；`doctor` 对非 linux / 非 x86_64 报错。
- 前置依赖（P0 已定义，本计划沿用其精确签名，不得改动）：
  - `src/config/types.ts`：`DeployConfig`、`ComponentConfig`、`SecretsConfig`、`DeployState`、`SCHEMA_VERSION = 1`
  - `src/config/load.ts`：`loadDeployment(dir): Promise<{ config; secrets }>`
  - `src/config/save.ts`：`saveDeployment(dir, config, secrets): Promise<void>`（deploy 644 / secrets 600，原子写）
  - `src/config/merge.ts`：`resolveComponentEnv(config, secrets, componentName)`
  - `src/state/machine.ts`：`transition(state, action)`
  - `src/util/find_deploy_dir.ts`：`findDeployDir(start?): string | null`
  - `src/cli.ts`：命令分发入口（P0 已含 `dispatchCommand` / `run` / `CommandContext`）
- `doctor` 只读：不安装任何东西、不写任何文件、不修改系统状态。
- `deploy init` 不提供 `--non-interactive`；非交互场景由用户直接编辑 JSON。
- 配置：`noj-deploy.json`（非敏感，权限 644）+ `noj-secrets.json`（敏感，权限 600）；`schema_version: 1`。
- 敏感输入不回显（`readSecret` 用 `Deno.stdin.setRaw(true)` 关闭回显）；随机密钥直接写入 `noj-secrets.json`。
- 测试通过 `deno task test`（`deno test -A`）运行；代码通过 `deno fmt` 与 `deno lint`。
- 提交使用 jj（`jj describe -m "<type>(<scope>): <中文描述>"`），scope 为 `cli`；GPG 签名在仓库已全局开启，无需额外操作。
- 不修改与 P1 无关的文件（不触碰 `AGENTS.md`、`noj-core/` 等既有业务代码；不修改 P0 已交付的公共接口签名）。

---

### Task 1: doctor 系统探针抽象 `src/doctor/probe.ts`

**Files:**
- Create: `noj-cli/src/doctor/probe.ts`
- Create: `noj-cli/src/doctor/probe_test.ts`

**Interfaces:**
- Consumes: 无（纯新模块）。
- Produces（后续所有 doctor 任务依赖）：
  - `export interface CmdResult { code: number; stdout: string; stderr: string }`
  - `export interface MemInfo { totalBytes: number; swapBytes: number }`
  - `export interface DiskInfo { freeBytes: number }`
  - `export interface SystemProbe { os: string; arch: string; run(cmd: string, args: string[]): Promise<CmdResult>; memInfo(): Promise<MemInfo>; diskFree(path: string): Promise<DiskInfo>; portOpen(port: number): Promise<boolean> }`
  - `export function realProbe(): SystemProbe`（真实实现：`Deno.build.os/arch`、`Deno.Command`、`/proc/meminfo`、`df -Pk`、`Deno.connect`）

- [ ] **Step 1: 写失败测试**

创建 `noj-cli/src/doctor/probe_test.ts`：

```ts
import { assertEquals } from "@std/assert";
import { realProbe } from "./probe.ts";

Deno.test("realProbe 暴露当前 os/arch", () => {
  const probe = realProbe();
  assertEquals(probe.os, Deno.build.os);
  assertEquals(probe.arch, Deno.build.arch);
});

Deno.test("realProbe.run 执行命令并返回退出码与输出", async () => {
  const probe = realProbe();
  const r = await probe.run("printf", ["hello"]);
  assertEquals(r.code, 0);
  assertEquals(r.stdout, "hello");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/doctor/probe_test.ts`
Expected: FAIL，`Error: Cannot find module .../probe.ts`。

- [ ] **Step 3: 实现 `src/doctor/probe.ts`**

```ts
/** 命令执行结果。 */
export interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 内存信息（字节）。 */
export interface MemInfo {
  totalBytes: number;
  swapBytes: number;
}

/** 磁盘信息（字节）。 */
export interface DiskInfo {
  freeBytes: number;
}

/**
 * 系统探针抽象：doctor 的所有检测只通过该接口访问系统，
 * 便于测试注入 fake 实现。
 */
export interface SystemProbe {
  os: string;
  arch: string;
  run(cmd: string, args: string[]): Promise<CmdResult>;
  memInfo(): Promise<MemInfo>;
  diskFree(path: string): Promise<DiskInfo>;
  /** 端口是否被占用（能连上即视为占用）。 */
  portOpen(port: number): Promise<boolean>;
}

/** 解析 /proc/meminfo 中形如 "MemTotal:       16384 kB" 的行，返回字节数。 */
function parseProcMemLine(line: string): number {
  const m = line.match(/:\s*(\d+)\s*kB/);
  if (!m) return 0;
  return Number(m[1]) * 1024;
}

/** 解析 `df -Pk <path>` 输出，返回可用字节数。 */
function parseDfFreeKb(stdout: string): number {
  const lines = stdout.trim().split("\n");
  // 表头后第一行：Filesystem 1024-blocks Used Available Capacity Mounted on
  const row = lines[1];
  if (!row) return 0;
  const parts = row.trim().split(/\s+/);
  // Available 是第 4 列（1-based），单位 KB。
  const kb = Number(parts[3] ?? 0);
  return kb * 1024;
}

/** 构造真实系统探针（仅 linux/amd64 语义；非 linux 时 memInfo/diskFree 返回 0）。 */
export function realProbe(): SystemProbe {
  return {
    os: Deno.build.os,
    arch: Deno.build.arch,
    async run(cmd, args) {
      const p = new Deno.Command(cmd, {
        args,
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
    async memInfo() {
      if (Deno.build.os !== "linux") return { totalBytes: 0, swapBytes: 0 };
      const text = await Deno.readTextFile("/proc/meminfo");
      let total = 0;
      let swap = 0;
      for (const line of text.split("\n")) {
        if (line.startsWith("MemTotal:")) total = parseProcMemLine(line);
        if (line.startsWith("SwapTotal:")) swap = parseProcMemLine(line);
      }
      return { totalBytes: total, swapBytes: swap };
    },
    async diskFree(path) {
      const r = await this.run("df", ["-Pk", path]);
      if (r.code !== 0) return { freeBytes: 0 };
      return { freeBytes: parseDfFreeKb(r.stdout) };
    },
    async portOpen(port) {
      try {
        const conn = await Deno.connect({ hostname: "127.0.0.1", port });
        conn.close();
        return true;
      } catch {
        return false;
      }
    },
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/doctor/probe_test.ts`
Expected: PASS。

- [ ] **Step 5: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj split noj-cli/src/doctor/probe.ts noj-cli/src/doctor/probe_test.ts
jj describe -m "feat(cli): 实现 doctor 系统探针抽象 SystemProbe/realProbe"
```

---

### Task 2: doctor 单项检测 `src/doctor/checks.ts`

**Files:**
- Create: `noj-cli/src/doctor/checks.ts`
- Create: `noj-cli/src/doctor/checks_test.ts`

**Interfaces:**
- Consumes: `SystemProbe`、`CmdResult`（Task 1）。
- Produces：
  - `export interface CheckResult { name: string; ok: boolean; detail: string; severity: "error" | "warning" }`
  - `export async function checkOs(probe: SystemProbe): Promise<CheckResult>`
  - `export async function checkArch(probe: SystemProbe): Promise<CheckResult>`
  - `export async function checkBaseTools(probe: SystemProbe): Promise<CheckResult>`
  - `export async function checkDockerCli(probe: SystemProbe): Promise<CheckResult>`
  - `export async function checkDockerDaemon(probe: SystemProbe): Promise<CheckResult>`
  - `export async function checkDockerCompose(probe: SystemProbe): Promise<CheckResult>`
  - `export async function checkMemory(probe: SystemProbe): Promise<CheckResult>`
  - `export async function checkDisk(probe: SystemProbe, path: string): Promise<CheckResult>`
  - `export async function checkPort(probe: SystemProbe, port: number): Promise<CheckResult>`
  - 阈值常量：`MIN_MEM_BYTES = 2 * 1024 ** 3`（2 GiB）、`MIN_DISK_BYTES = 10 * 1024 ** 3`（10 GiB）

- [ ] **Step 1: 写失败测试**

创建 `noj-cli/src/doctor/checks_test.ts`：

```ts
import { assertEquals } from "@std/assert";
import type { SystemProbe } from "./probe.ts";
import {
  checkOs,
  checkArch,
  checkBaseTools,
  checkDockerCli,
  checkDockerDaemon,
  checkDockerCompose,
  checkMemory,
  checkDisk,
  checkPort,
} from "./checks.ts";

/** 构造一个可编程的 fake 探针。 */
function fakeProbe(overrides: Partial<SystemProbe> = {}): SystemProbe {
  const ok = (code = 0, stdout = "", stderr = "") => ({ code, stdout, stderr });
  return {
    os: "linux",
    arch: "x86_64",
    run: async () => ok(),
    memInfo: async () => ({ totalBytes: 8 * 1024 ** 3, swapBytes: 2 * 1024 ** 3 }),
    diskFree: async () => ({ freeBytes: 50 * 1024 ** 3 }),
    portOpen: async () => false,
    ...overrides,
  };
}

Deno.test("checkOs: linux 通过，非 linux 失败", async () => {
  assertEquals((await checkOs(fakeProbe())).ok, true);
  assertEquals((await checkOs(fakeProbe({ os: "darwin" }))).ok, false);
});

Deno.test("checkArch: x86_64/amd64 通过，其余失败", async () => {
  assertEquals((await checkArch(fakeProbe())).ok, true);
  assertEquals((await checkArch(fakeProbe({ arch: "amd64" }))).ok, true);
  assertEquals((await checkArch(fakeProbe({ arch: "aarch64" }))).ok, false);
});

Deno.test("checkBaseTools: bash/tar/openssl 与 curl 或 wget 齐全时通过", async () => {
  const probe = fakeProbe({
    run: async (cmd) => {
      const present = new Set(["bash", "tar", "openssl", "curl"]);
      return { code: present.has(cmd) ? 0 : 1, stdout: "", stderr: "" };
    },
  });
  assertEquals((await checkBaseTools(probe)).ok, true);
});

Deno.test("checkBaseTools: 缺 bash 时失败", async () => {
  const probe = fakeProbe({
    run: async (cmd) => {
      const present = new Set(["tar", "openssl", "curl"]);
      return { code: present.has(cmd) ? 0 : 1, stdout: "", stderr: "" };
    },
  });
  const r = await checkBaseTools(probe);
  assertEquals(r.ok, false);
  assertEquals(r.detail.includes("bash"), true);
});

Deno.test("checkDockerCli/Daemon/Compose: 命令可用时通过", async () => {
  const probe = fakeProbe({ run: async () => ({ code: 0, stdout: "", stderr: "" }) });
  assertEquals((await checkDockerCli(probe)).ok, true);
  assertEquals((await checkDockerDaemon(probe)).ok, true);
  assertEquals((await checkDockerCompose(probe)).ok, true);
});

Deno.test("checkDockerDaemon: docker info 失败时失败", async () => {
  const probe = fakeProbe({
    run: async (cmd, args) => {
      const isInfo = cmd === "docker" && args[0] === "info";
      return { code: isInfo ? 1 : 0, stdout: "", stderr: "cannot connect" };
    },
  });
  assertEquals((await checkDockerDaemon(probe)).ok, false);
});

Deno.test("checkMemory: 内存不足时失败，无 swap 时告警", async () => {
  const low = await checkMemory(fakeProbe({ memInfo: async () => ({ totalBytes: 1 * 1024 ** 3, swapBytes: 0 }) }));
  assertEquals(low.ok, false);
  assertEquals(low.severity, "error");

  const noSwap = await checkMemory(fakeProbe({ memInfo: async () => ({ totalBytes: 8 * 1024 ** 3, swapBytes: 0 }) }));
  assertEquals(noSwap.ok, true);
  assertEquals(noSwap.severity, "warning");
});

Deno.test("checkDisk: 磁盘不足时失败", async () => {
  const r = await checkDisk(fakeProbe({ diskFree: async () => ({ freeBytes: 1 * 1024 ** 3 }) }), "/opt");
  assertEquals(r.ok, false);
});

Deno.test("checkPort: 端口被占用时失败", async () => {
  const r = await checkPort(fakeProbe({ portOpen: async () => true }), 8080);
  assertEquals(r.ok, false);
  assertEquals(r.detail.includes("8080"), true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/doctor/checks_test.ts`
Expected: FAIL，`Error: Cannot find module .../checks.ts`。

- [ ] **Step 3: 实现 `src/doctor/checks.ts`**

```ts
import type { SystemProbe } from "./probe.ts";

/** 单项检测结果。 */
export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  /** error 级失败导致 doctor 退出码非零；warning 仅提示。 */
  severity: "error" | "warning";
}

/** 最低内存：2 GiB。 */
export const MIN_MEM_BYTES = 2 * 1024 ** 3;
/** 最低可用磁盘：10 GiB。 */
export const MIN_DISK_BYTES = 10 * 1024 ** 3;

function result(name: string, ok: boolean, detail: string, severity: "error" | "warning" = "error"): CheckResult {
  return { name, ok, detail, severity };
}

/** 检测操作系统是否为 linux。 */
export async function checkOs(probe: SystemProbe): Promise<CheckResult> {
  const ok = probe.os === "linux";
  return result("操作系统", ok, ok ? `linux (${probe.os})` : `仅支持 linux，当前 ${probe.os}`);
}

/** 检测 CPU 架构是否为 x86_64 / amd64。 */
export async function checkArch(probe: SystemProbe): Promise<CheckResult> {
  const ok = probe.arch === "x86_64" || probe.arch === "amd64";
  return result("CPU 架构", ok, ok ? `${probe.arch}` : `仅支持 x86_64/amd64，当前 ${probe.arch}`);
}

/** 检测基础工具：bash、tar、openssl，以及 curl 或 wget 至少其一。 */
export async function checkBaseTools(probe: SystemProbe): Promise<CheckResult> {
  const required = ["bash", "tar", "openssl"];
  const either = ["curl", "wget"];
  const missing: string[] = [];
  for (const tool of required) {
    const r = await probe.run(tool, ["--version"]);
    if (r.code !== 0) missing.push(tool);
  }
  let eitherOk = false;
  for (const tool of either) {
    const r = await probe.run(tool, ["--version"]);
    if (r.code === 0) eitherOk = true;
  }
  if (!eitherOk) missing.push("curl 或 wget");
  const ok = missing.length === 0;
  return result(
    "基础工具",
    ok,
    ok ? "bash/tar/openssl/curl 或 wget 齐全" : `缺失: ${missing.join(", ")}`,
  );
}

/** 检测 Docker CLI 是否可用。 */
export async function checkDockerCli(probe: SystemProbe): Promise<CheckResult> {
  const r = await probe.run("docker", ["--version"]);
  const ok = r.code === 0;
  return result("Docker CLI", ok, ok ? r.stdout.trim() : "docker 命令不可用");
}

/** 检测 Docker daemon 是否运行（docker info 成功）。 */
export async function checkDockerDaemon(probe: SystemProbe): Promise<CheckResult> {
  const r = await probe.run("docker", ["info"]);
  const ok = r.code === 0;
  return result("Docker daemon", ok, ok ? "daemon 运行中" : r.stderr.trim() || "daemon 未运行");
}

/** 检测 Docker Compose v2 是否可用。 */
export async function checkDockerCompose(probe: SystemProbe): Promise<CheckResult> {
  const r = await probe.run("docker", ["compose", "version"]);
  const ok = r.code === 0;
  return result("Docker Compose v2", ok, ok ? r.stdout.trim() : "docker compose v2 不可用");
}

/** 检测内存与 swap：内存不足为 error，无 swap 为 warning。 */
export async function checkMemory(probe: SystemProbe): Promise<CheckResult> {
  const mem = await probe.memInfo();
  if (mem.totalBytes < MIN_MEM_BYTES) {
    return result("内存", false, `可用内存 ${(mem.totalBytes / 1024 ** 3).toFixed(1)} GiB，低于 ${MIN_MEM_BYTES / 1024 ** 3} GiB`);
  }
  if (mem.swapBytes === 0) {
    return result("内存", true, `内存 ${(mem.totalBytes / 1024 ** 3).toFixed(1)} GiB，无 swap`, "warning");
  }
  return result("内存", true, `内存 ${(mem.totalBytes / 1024 ** 3).toFixed(1)} GiB，swap ${(mem.swapBytes / 1024 ** 3).toFixed(1)} GiB`);
}

/** 检测目标目录可用磁盘。 */
export async function checkDisk(probe: SystemProbe, path: string): Promise<CheckResult> {
  const disk = await probe.diskFree(path);
  const ok = disk.freeBytes >= MIN_DISK_BYTES;
  return result(
    "磁盘空间",
    ok,
    ok
      ? `${path} 可用 ${(disk.freeBytes / 1024 ** 3).toFixed(1)} GiB`
      : `${path} 可用 ${(disk.freeBytes / 1024 ** 3).toFixed(1)} GiB，低于 ${MIN_DISK_BYTES / 1024 ** 3} GiB`,
  );
}

/** 检测端口是否被占用。 */
export async function checkPort(probe: SystemProbe, port: number): Promise<CheckResult> {
  const occupied = await probe.portOpen(port);
  return result("端口占用", !occupied, occupied ? `端口 ${port} 已被占用` : `端口 ${port} 空闲`);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/doctor/checks_test.ts`
Expected: PASS。

- [ ] **Step 5: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj split noj-cli/src/doctor/checks.ts noj-cli/src/doctor/checks_test.ts
jj describe -m "feat(cli): 实现 doctor 单项检测 checks"
```

---

### Task 3: doctor 编排与报告 `src/doctor/doctor.ts` + `src/doctor/report.ts`

**Files:**
- Create: `noj-cli/src/doctor/doctor.ts`
- Create: `noj-cli/src/doctor/report.ts`
- Create: `noj-cli/src/doctor/doctor_test.ts`

**Interfaces:**
- Consumes: `SystemProbe`（Task 1）、`CheckResult` 与全部 `check*` 函数（Task 2）。
- Produces：
  - `export interface DoctorOptions { port: number; installDir: string }`
  - `export interface DoctorReport { checks: CheckResult[]; failed: boolean }`
  - `export async function runDoctor(probe: SystemProbe, opts: DoctorOptions): Promise<DoctorReport>`（依次执行全部检测；`failed` = 任一 `severity === "error"` 且 `ok === false`）
  - `export function formatReport(report: DoctorReport): string`（ANSI 彩色清单：通过 `\x1b[32m[通过]\x1b[0m`、失败 `\x1b[31m[失败]\x1b[0m`、告警 `\x1b[33m[告警]\x1b[0m`）

- [ ] **Step 1: 写失败测试**

创建 `noj-cli/src/doctor/doctor_test.ts`：

```ts
import { assertEquals } from "@std/assert";
import type { SystemProbe } from "./probe.ts";
import { runDoctor } from "./doctor.ts";
import { formatReport } from "./report.ts";

function allOkProbe(): SystemProbe {
  return {
    os: "linux",
    arch: "x86_64",
    run: async () => ({ code: 0, stdout: "ok", stderr: "" }),
    memInfo: async () => ({ totalBytes: 8 * 1024 ** 3, swapBytes: 2 * 1024 ** 3 }),
    diskFree: async () => ({ freeBytes: 50 * 1024 ** 3 }),
    portOpen: async () => false,
  };
}

Deno.test("runDoctor: 全部通过时 failed 为 false", async () => {
  const report = await runDoctor(allOkProbe(), { port: 8080, installDir: "/opt" });
  assertEquals(report.failed, false);
  assertEquals(report.checks.length >= 9, true);
});

Deno.test("runDoctor: 任一 error 级失败时 failed 为 true", async () => {
  const probe = allOkProbe();
  probe.os = "darwin";
  const report = await runDoctor(probe, { port: 8080, installDir: "/opt" });
  assertEquals(report.failed, true);
});

Deno.test("runDoctor: 仅 warning 不导致 failed", async () => {
  const probe = allOkProbe();
  probe.memInfo = async () => ({ totalBytes: 8 * 1024 ** 3, swapBytes: 0 });
  const report = await runDoctor(probe, { port: 8080, installDir: "/opt" });
  assertEquals(report.failed, false);
});

Deno.test("formatReport: 包含通过/失败/告警标记与检测名", () => {
  const report = {
    failed: true,
    checks: [
      { name: "操作系统", ok: true, detail: "linux", severity: "error" as const },
      { name: "端口占用", ok: false, detail: "端口 8080 已被占用", severity: "error" as const },
      { name: "内存", ok: true, detail: "无 swap", severity: "warning" as const },
    ],
  };
  const text = formatReport(report);
  assertEquals(text.includes("操作系统"), true);
  assertEquals(text.includes("\x1b[32m[通过]\x1b[0m"), true);
  assertEquals(text.includes("\x1b[31m[失败]\x1b[0m"), true);
  assertEquals(text.includes("\x1b[33m[告警]\x1b[0m"), true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/doctor/doctor_test.ts`
Expected: FAIL，`Cannot find module .../doctor.ts`。

- [ ] **Step 3: 实现 `src/doctor/doctor.ts`**

```ts
import type { SystemProbe } from "./probe.ts";
import type { CheckResult } from "./checks.ts";
import {
  checkOs,
  checkArch,
  checkBaseTools,
  checkDockerCli,
  checkDockerDaemon,
  checkDockerCompose,
  checkMemory,
  checkDisk,
  checkPort,
} from "./checks.ts";

/** doctor 运行选项。 */
export interface DoctorOptions {
  port: number;
  installDir: string;
}

/** doctor 检测报告。 */
export interface DoctorReport {
  checks: CheckResult[];
  /** 任一 error 级检测失败即为 true。 */
  failed: boolean;
}

/** 依次执行全部只读检测，返回报告。 */
export async function runDoctor(
  probe: SystemProbe,
  opts: DoctorOptions,
): Promise<DoctorReport> {
  const checks: CheckResult[] = [
    await checkOs(probe),
    await checkArch(probe),
    await checkBaseTools(probe),
    await checkDockerCli(probe),
    await checkDockerDaemon(probe),
    await checkDockerCompose(probe),
    await checkMemory(probe),
    await checkDisk(probe, opts.installDir),
    await checkPort(probe, opts.port),
  ];
  const failed = checks.some((c) => c.severity === "error" && !c.ok);
  return { checks, failed };
}
```

- [ ] **Step 4: 实现 `src/doctor/report.ts`**

```ts
import type { DoctorReport } from "./doctor.ts";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

/** 将检测报告格式化为 ANSI 彩色清单。 */
export function formatReport(report: DoctorReport): string {
  const lines: string[] = ["环境检测结果:"];
  for (const c of report.checks) {
    let mark: string;
    if (!c.ok) {
      mark = `${RED}[失败]${RESET}`;
    } else if (c.severity === "warning") {
      mark = `${YELLOW}[告警]${RESET}`;
    } else {
      mark = `${GREEN}[通过]${RESET}`;
    }
    lines.push(`  ${mark} ${c.name}: ${c.detail}`);
  }
  lines.push(report.failed ? `${RED}检测未通过，存在失败项。${RESET}` : `${GREEN}检测通过。${RESET}`);
  return lines.join("\n");
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/doctor/doctor_test.ts`
Expected: PASS。

- [ ] **Step 6: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj split noj-cli/src/doctor/doctor.ts noj-cli/src/doctor/report.ts noj-cli/src/doctor/doctor_test.ts
jj describe -m "feat(cli): 实现 doctor 编排 runDoctor 与彩色报告 formatReport"
```

---

### Task 4: 接入 `doctor` 命令到 `src/cli.ts`

**Files:**
- Modify: `noj-cli/src/cli.ts`（`doctor` 分支）
- Modify: `noj-cli/src/cli_test.ts`（新增 doctor 用例）

**Interfaces:**
- Consumes: `realProbe`（Task 1）、`runDoctor` / `DoctorOptions`（Task 3）、`formatReport`（Task 3）、`findDeployDir`（P0）。
- Produces：
  - `export function parsePort(args: string[]): number`（解析 `--port <n>`，缺省 8080；非法值抛 `Error`）
  - `doctor` 命令行为：用 `realProbe()` 运行 `runDoctor`，打印 `formatReport`，`failed` 时返回退出码 `1`，否则 `0`。

- [ ] **Step 1: 写失败测试**

在 `noj-cli/src/cli_test.ts` 末尾追加：

```ts
import { parsePort } from "./cli.ts";

Deno.test("parsePort: 缺省 8080", () => {
  assertEquals(parsePort([]), 8080);
});

Deno.test("parsePort: 解析 --port 8081", () => {
  assertEquals(parsePort(["--port", "8081"]), 8081);
});

Deno.test("parsePort: 非法端口抛错", () => {
  let threw = false;
  try {
    parsePort(["--port", "abc"]);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/cli_test.ts`
Expected: FAIL，`parsePort` 未定义。

- [ ] **Step 3: 实现 `parsePort` 并接入 doctor 分支**

在 `noj-cli/src/cli.ts` 顶部 import 区追加：

```ts
import { realProbe } from "./doctor/probe.ts";
import { runDoctor } from "./doctor/doctor.ts";
import { formatReport } from "./doctor/report.ts";
```

在 `dispatchCommand` 的 `case "doctor":` 分支替换为：

```ts
case "doctor": {
  const port = parsePort(args);
  const installDir = ctx.deployDir ?? ctx.cwd;
  const report = await runDoctor(realProbe(), { port, installDir });
  console.log(formatReport(report));
  return report.failed ? 1 : 0;
}
```

在文件内（`printHelp` 之后）新增：

```ts
/** 解析 --port <n>，缺省 8080；非法值抛错。 */
export function parsePort(args: string[]): number {
  const idx = args.indexOf("--port");
  if (idx === -1) return 8080;
  const raw = args[idx + 1];
  const n = Number(raw);
  if (raw === undefined || !Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`非法端口: ${raw}`);
  }
  return n;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/cli_test.ts`
Expected: PASS。

- [ ] **Step 5: 手动冒烟验证**

Run: `cd noj-cli && deno run -A src/cli.ts doctor --port 8080`
Expected: 打印彩色环境检测清单；本机通过时退出码 0。

- [ ] **Step 6: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj split noj-cli/src/cli.ts noj-cli/src/cli_test.ts
jj describe -m "feat(cli): 接入 doctor 命令（--port 解析 + 彩色报告）"
```

---

### Task 5: TUI 输入抽象与表单控件 `src/tui/io.ts` + `src/tui/widgets.ts`

**Files:**
- Create: `noj-cli/src/tui/io.ts`
- Create: `noj-cli/src/tui/widgets.ts`
- Create: `noj-cli/src/tui/widgets_test.ts`

**Interfaces:**
- Consumes: 无（纯新模块）。
- Produces：
  - `export interface PromptIO { write(text: string): void; readLine(prompt: string): Promise<string>; readSecret(prompt: string): Promise<string> }`
  - `export function realIO(): PromptIO`（写 `Deno.stdout`，读 `Deno.stdin`；`readSecret` 用 `Deno.stdin.setRaw(true)` 关闭回显后读一行再恢复）
  - `export async function select(io: PromptIO, question: string, options: string[]): Promise<number>`（打印编号选项，读入编号，非法时重试）
  - `export async function input(io: PromptIO, question: string, def?: string): Promise<string>`（空输入返回 `def`）
  - `export async function secretInput(io: PromptIO, question: string): Promise<string>`（调用 `readSecret`，空输入重试）
  - `export async function confirm(io: PromptIO, question: string, def?: boolean): Promise<boolean>`（`y/n`，空输入返回 `def`）

- [ ] **Step 1: 写失败测试**

创建 `noj-cli/src/tui/widgets_test.ts`：

```ts
import { assertEquals } from "@std/assert";
import type { PromptIO } from "./io.ts";
import { select, input, secretInput, confirm } from "./widgets.ts";

/** 可编程 fake IO：按序消费 answers，记录 writes。 */
class FakeIO implements PromptIO {
  writes: string[] = [];
  answers: string[];
  constructor(answers: string[]) {
    this.answers = answers;
  }
  write(text: string): void {
    this.writes.push(text);
  }
  async readLine(_prompt: string): Promise<string> {
    return this.answers.shift() ?? "";
  }
  async readSecret(_prompt: string): Promise<string> {
    return this.answers.shift() ?? "";
  }
}

Deno.test("select: 返回所选编号并打印选项", async () => {
  const io = new FakeIO(["2"]);
  const idx = await select(io, "选择模式", ["dev", "prod"]);
  assertEquals(idx, 1);
  assertEquals(io.writes.join("").includes("prod"), true);
});

Deno.test("select: 非法输入重试后成功", async () => {
  const io = new FakeIO(["9", "1"]);
  const idx = await select(io, "选择模式", ["dev", "prod"]);
  assertEquals(idx, 0);
});

Deno.test("input: 空输入返回默认值", async () => {
  const io = new FakeIO([""]);
  assertEquals(await input(io, "端口", "8080"), "8080");
});

Deno.test("input: 非空输入原样返回", async () => {
  const io = new FakeIO(["9000"]);
  assertEquals(await input(io, "端口", "8080"), "9000");
});

Deno.test("secretInput: 返回密钥且空输入重试", async () => {
  const io = new FakeIO(["", "s3cr3t"]);
  assertEquals(await secretInput(io, "密码"), "s3cr3t");
});

Deno.test("confirm: y/n 与默认值", async () => {
  assertEquals(await confirm(new FakeIO(["y"]), "继续?", false), true);
  assertEquals(await confirm(new FakeIO(["n"]), "继续?", true), false);
  assertEquals(await confirm(new FakeIO([""]), "继续?", true), true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/tui/widgets_test.ts`
Expected: FAIL，`Cannot find module .../io.ts`。

- [ ] **Step 3: 实现 `src/tui/io.ts`**

```ts
/** 交互输入输出抽象：真实实现走终端，测试注入 fake。 */
export interface PromptIO {
  write(text: string): void;
  readLine(prompt: string): Promise<string>;
  /** 敏感输入，不回显。 */
  readSecret(prompt: string): Promise<string>;
}

/** 构造真实终端 IO。 */
export function realIO(): PromptIO {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return {
    write(text) {
      Deno.stdout.writeSync(encoder.encode(text));
    },
    async readLine(prompt) {
      this.write(prompt);
      const buf = new Uint8Array(1024);
      const n = await Deno.stdin.read(buf);
      if (n === null) return "";
      return decoder.decode(buf.subarray(0, n)).replace(/\r?\n$/, "");
    },
    async readSecret(prompt) {
      this.write(prompt);
      const wasRaw = Deno.stdin.isTerminal();
      if (wasRaw) Deno.stdin.setRaw(true);
      try {
        const buf = new Uint8Array(1024);
        const n = await Deno.stdin.read(buf);
        if (n === null) return "";
        return decoder.decode(buf.subarray(0, n)).replace(/\r?\n$/, "");
      } finally {
        if (wasRaw) Deno.stdin.setRaw(false);
        this.write("\n");
      }
    },
  };
}
```

- [ ] **Step 4: 实现 `src/tui/widgets.ts`**

```ts
import type { PromptIO } from "./io.ts";

/** 打印编号选项并让用户选择，返回选中下标（0-based）。非法输入重试。 */
export async function select(
  io: PromptIO,
  question: string,
  options: string[],
): Promise<number> {
  while (true) {
    io.write(`${question}\n`);
    options.forEach((opt, i) => io.write(`  ${i + 1}) ${opt}\n`));
    const raw = await io.readLine("请输入编号: ");
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) {
      return n - 1;
    }
    io.write("输入无效，请重新选择。\n");
  }
}

/** 文本输入；空输入返回默认值。 */
export async function input(
  io: PromptIO,
  question: string,
  def?: string,
): Promise<string> {
  const suffix = def === undefined ? "" : ` [${def}]`;
  const raw = await io.readLine(`${question}${suffix}: `);
  return raw === "" ? (def ?? "") : raw;
}

/** 敏感输入；空输入重试。 */
export async function secretInput(
  io: PromptIO,
  question: string,
): Promise<string> {
  while (true) {
    const raw = await io.readSecret(`${question}: `);
    if (raw !== "") return raw;
    io.write("输入不能为空，请重试。\n");
  }
}

/** 确认；y/n，空输入返回默认值。 */
export async function confirm(
  io: PromptIO,
  question: string,
  def?: boolean,
): Promise<boolean> {
  const suffix = def === undefined ? " (y/n)" : def ? " (Y/n)" : " (y/N)";
  while (true) {
    const raw = (await io.readLine(`${question}${suffix}: `)).toLowerCase();
    if (raw === "y") return true;
    if (raw === "n") return false;
    if (raw === "" && def !== undefined) return def;
    io.write("请输入 y 或 n。\n");
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/tui/widgets_test.ts`
Expected: PASS。

- [ ] **Step 6: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj split noj-cli/src/tui/io.ts noj-cli/src/tui/widgets.ts noj-cli/src/tui/widgets_test.ts
jj describe -m "feat(cli): 实现 TUI 输入抽象 PromptIO 与表单控件"
```

---

### Task 6: init 模板与密钥生成 `src/init/templates.ts` + `src/init/secrets.ts`

**Files:**
- Create: `noj-cli/src/init/templates.ts`
- Create: `noj-cli/src/init/secrets.ts`
- Create: `noj-cli/src/init/templates_test.ts`

**Interfaces:**
- Consumes: `DeployConfig`、`ComponentConfig`、`SecretsConfig`、`SCHEMA_VERSION`（P0 `src/config/types.ts`）。
- Produces：
  - `export function devTemplate(installDir: string, port: number): DeployConfig`（type `"dev"`；postgres/redis/minio 为 docker，server/ui 为 process，judge/nginx 禁用）
  - `export interface ProdTemplateOptions { installDir: string; domain: string; https: boolean; port: number; judgeEnabled: boolean; emailProvider: "disabled" | "smtp" }`
  - `export function prodTemplate(opts: ProdTemplateOptions): DeployConfig`（type `"prod"`；全部 docker，nginx 启用，judge 按选项）
  - `export function randomKey(bytes: number): string`（`crypto.getRandomValues` 生成 hex 字符串，长度 `bytes * 2`）
  - `export function generateSecrets(mode: "dev" | "prod"): SecretsConfig`（生成核心密钥；`JWT_SECRET` / `TFA_ENCRYPTION_KEY` 用 32 字节 → 64 字符 hex，满足 ≥32 长度校验）

- [ ] **Step 1: 写失败测试**

创建 `noj-cli/src/init/templates_test.ts`：

```ts
import { assertEquals } from "@std/assert";
import { devTemplate, prodTemplate } from "./templates.ts";
import { generateSecrets, randomKey } from "./secrets.ts";
import { SCHEMA_VERSION } from "../config/types.ts";

Deno.test("randomKey: 生成指定字节数的 hex 字符串", () => {
  const key = randomKey(32);
  assertEquals(key.length, 64);
  assertEquals(/^[0-9a-f]+$/.test(key), true);
});

Deno.test("generateSecrets: 核心密钥齐全且 JWT/TFA 长度 >= 32", () => {
  const secrets = generateSecrets("prod");
  assertEquals(secrets.schema_version, SCHEMA_VERSION);
  for (const k of ["POSTGRES_PASSWORD", "REDIS_PASSWORD", "MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD", "S3_ACCESS_KEY", "S3_SECRET_KEY", "JWT_SECRET", "TFA_ENCRYPTION_KEY", "NOJ_LLM_SERVICE_TOKEN", "NOJ_LLM_STORE_KEY"]) {
    assertEquals(secrets.secrets[k] !== undefined, true, `缺少 ${k}`);
  }
  assertEquals(secrets.secrets["JWT_SECRET"]!.length >= 32, true);
  assertEquals(secrets.secrets["TFA_ENCRYPTION_KEY"]!.length >= 32, true);
});

Deno.test("devTemplate: dev 模式，server/ui 为 process，judge/nginx 禁用", () => {
  const cfg = devTemplate("/opt/neuro-oj", 8080);
  assertEquals(cfg.type, "dev");
  assertEquals(cfg.schema_version, SCHEMA_VERSION);
  assertEquals(cfg.components["server"]!.method, "process");
  assertEquals(cfg.components["ui"]!.method, "process");
  assertEquals(cfg.components["judge"]!.enabled, false);
  assertEquals(cfg.components["nginx"]!.enabled, false);
  assertEquals(cfg.components["postgres"]!.method, "docker");
});

Deno.test("prodTemplate: prod 模式，全部 docker，nginx 启用，judge 按选项", () => {
  const cfg = prodTemplate({
    installDir: "/opt/neuro-oj",
    domain: "oj.example.com",
    https: true,
    port: 8080,
    judgeEnabled: true,
    emailProvider: "disabled",
  });
  assertEquals(cfg.type, "prod");
  assertEquals(cfg.components["nginx"]!.enabled, true);
  assertEquals(cfg.components["judge"]!.enabled, true);
  assertEquals(cfg.components["server"]!.method, "docker");
  assertEquals(cfg.env["DOMAIN"], "oj.example.com");
  assertEquals(cfg.env["APP_URL"], "https://oj.example.com");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/init/templates_test.ts`
Expected: FAIL，`Cannot find module .../templates.ts`。

- [ ] **Step 3: 实现 `src/init/secrets.ts`**

```ts
import type { SecretsConfig } from "../config/types.ts";
import { SCHEMA_VERSION } from "../config/types.ts";

/** 生成 bytes 字节的随机 hex 字符串（长度 bytes*2）。 */
export function randomKey(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 生成部署所需核心密钥；JWT/TFA 用 32 字节（64 hex）满足长度校验。 */
export function generateSecrets(mode: "dev" | "prod"): SecretsConfig {
  const now = new Date().toISOString();
  const secrets: Record<string, string> = {
    POSTGRES_PASSWORD: randomKey(16),
    REDIS_PASSWORD: randomKey(16),
    MINIO_ROOT_USER: "minioadmin",
    MINIO_ROOT_PASSWORD: randomKey(16),
    S3_ACCESS_KEY: randomKey(16),
    S3_SECRET_KEY: randomKey(32),
    JWT_SECRET: randomKey(32),
    TFA_ENCRYPTION_KEY: randomKey(32),
    NOJ_LLM_SERVICE_TOKEN: randomKey(32),
    NOJ_LLM_STORE_KEY: randomKey(32),
  };
  if (mode === "prod") {
    // 可选云厂商/OAuth 密钥留空，用户后续自行填写。
    secrets["ALIBABA_ACCESS_KEY_ID"] = "";
    secrets["ALIBABA_ACCESS_KEY_SECRET"] = "";
    secrets["TENCENT_SECRET_ID"] = "";
    secrets["TENCENT_SECRET_KEY"] = "";
    secrets["OAUTH_GITHUB_CLIENT_ID"] = "";
    secrets["OAUTH_GITHUB_CLIENT_SECRET"] = "";
    secrets["OAUTH_OIDC_CLIENT_ID"] = "";
    secrets["OAUTH_OIDC_CLIENT_SECRET"] = "";
  }
  return {
    schema_version: SCHEMA_VERSION,
    created_at: now,
    updated_at: now,
    secrets,
  };
}
```

- [ ] **Step 4: 实现 `src/init/templates.ts`**

```ts
import type { DeployConfig, ComponentConfig } from "../config/types.ts";
import { SCHEMA_VERSION } from "../config/types.ts";

function baseConfig(type: "dev" | "prod", installDir: string): DeployConfig {
  const now = new Date().toISOString();
  return {
    schema_version: SCHEMA_VERSION,
    type,
    state: "stopped",
    created_at: now,
    updated_at: now,
    install_dir: installDir,
    version: { noj_cli: "0.1.0", noj_server: "0.1.0" },
    env: {
      LOG_LEVEL: "info",
      LOG_FORMAT: "json",
    },
    components: {},
    reverse_proxy: {
      type: "nginx",
      config_dir: "/etc/nginx/conf.d",
      domain: "localhost",
      upstream_port: 8080,
    },
  };
}

function dockerComponent(partial: Partial<ComponentConfig> & { image: string }): ComponentConfig {
  return { enabled: true, method: "docker", env: {}, ...partial };
}

/** dev 模式模板：基础设施走 docker，server/ui 走本地进程。 */
export function devTemplate(installDir: string, port: number): DeployConfig {
  const cfg = baseConfig("dev", installDir);
  cfg.env["PORT"] = String(port);
  cfg.components = {
    postgres: dockerComponent({ image: "postgres:16-alpine", internal_port: 5432, host_port: null, env: { POSTGRES_USER: "noj", POSTGRES_DB: "noj" } }),
    redis: dockerComponent({ image: "redis:7-alpine", internal_port: 6379, host_port: null, env: {} }),
    minio: dockerComponent({ image: "minio/minio:latest", api_port: 9000, console_port: 9001, host_api_port: null, host_console_port: null, env: {} }),
    server: { enabled: true, method: "process", binary: "noj-server", port: 8000, host_port: null, env: { NOJ_ENV: "development", PORT: "8000", DATABASE_URL: "postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5432/${POSTGRES_DB}", REDIS_URL: "redis://:${REDIS_PASSWORD}@127.0.0.1:6379/0", JWT_SECRET: "${JWT_SECRET}", TFA_ENCRYPTION_KEY: "${TFA_ENCRYPTION_KEY}" } },
    ui: { enabled: true, method: "process", dev_command: "deno task dev", port: 3000, host_port: null, env: { NUXT_API_BASE: "http://127.0.0.1:8000", NUXT_NOJ_ENV: "development", PORT: "3000" } },
    llm_gateway: { enabled: true, method: "process", port: 8001, host_port: null, env: { NOJ_LLM_PORT: "8001", NOJ_LLM_SERVICE_TOKEN: "${NOJ_LLM_SERVICE_TOKEN}", NOJ_LLM_STORE_KEY: "${NOJ_LLM_STORE_KEY}" } },
    judge: { enabled: false, method: "docker", image: "ghcr.io/neuro-oj/noj-judge:0.1.0", env: {} },
    nginx: { enabled: false, method: "docker", image: "nginx:1.27-alpine", port: 8080, host_port: port, env: {} },
  };
  return cfg;
}

/** prod 模板选项。 */
export interface ProdTemplateOptions {
  installDir: string;
  domain: string;
  https: boolean;
  port: number;
  judgeEnabled: boolean;
  emailProvider: "disabled" | "smtp";
}

/** prod 模式模板：全部走 docker，nginx 启用。 */
export function prodTemplate(opts: ProdTemplateOptions): DeployConfig {
  const cfg = baseConfig("prod", opts.installDir);
  const scheme = opts.https ? "https" : "http";
  cfg.env = {
    ...cfg.env,
    DOMAIN: opts.domain,
    APP_URL: `${scheme}://${opts.domain}`,
    CORS_ALLOWED_ORIGINS: `${scheme}://${opts.domain}`,
    TRUSTED_PROXIES: "172.28.0.0/16",
    NOJ_ALLOW_INSECURE_HTTP: String(!opts.https),
    NGINX_PORT: String(opts.port),
    STORAGE_PROVIDER: "s3",
    S3_ENDPOINT: "http://minio:9000",
    S3_BUCKET: "noj-support-packages",
    S3_REGION: "us-east-1",
    S3_FORCE_PATH_STYLE: "true",
    EMAIL_PROVIDER: opts.emailProvider,
    JUDGE_IMAGE_BASE: "ghcr.io/neuro-oj/",
    JUDGE_ALLOW_EVALUATOR_NETWORK: "false",
    JUDGE_EVALUATOR_NETWORK: "noj-net",
    JUDGE_ALLOW_HTTP_S3: "true",
  };
  cfg.reverse_proxy = {
    type: "nginx",
    config_dir: "/etc/nginx/conf.d",
    domain: opts.domain,
    upstream_port: opts.port,
  };
  cfg.components = {
    postgres: dockerComponent({ image: "postgres:16-alpine", internal_port: 5432, host_port: null, env: { POSTGRES_USER: "noj", POSTGRES_DB: "noj" } }),
    redis: dockerComponent({ image: "redis:7-alpine", internal_port: 6379, host_port: null, env: {} }),
    minio: dockerComponent({ image: "minio/minio:latest", api_port: 9000, console_port: 9001, host_api_port: null, host_console_port: null, env: {} }),
    server: dockerComponent({ image: "ghcr.io/neuro-oj/noj-server:0.1.0", port: 8000, host_port: null, env: { NOJ_ENV: "production", PORT: "8000", DATABASE_URL: "postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}", REDIS_URL: "redis://:${REDIS_PASSWORD}@redis:6379/0", JWT_SECRET: "${JWT_SECRET}", TFA_ENCRYPTION_KEY: "${TFA_ENCRYPTION_KEY}", S3_ACCESS_KEY: "${S3_ACCESS_KEY}", S3_SECRET_KEY: "${S3_SECRET_KEY}" } }),
    ui: dockerComponent({ image: "ghcr.io/neuro-oj/noj-ui:0.1.0", port: 3000, host_port: null, env: { NUXT_API_BASE: "http://server:8000", NUXT_NOJ_ENV: "production", NODE_ENV: "production", PORT: "3000" } }),
    llm_gateway: dockerComponent({ image: "ghcr.io/neuro-oj/noj-llm-gateway:0.1.0", port: 8001, host_port: null, env: { NOJ_LLM_PORT: "8001", NOJ_LLM_SERVICE_TOKEN: "${NOJ_LLM_SERVICE_TOKEN}", NOJ_LLM_STORE_KEY: "${NOJ_LLM_STORE_KEY}" } }),
    judge: dockerComponent({ image: "ghcr.io/neuro-oj/noj-judge:0.1.0", enabled: opts.judgeEnabled, env: { REDIS_URL: "redis://:${REDIS_PASSWORD}@redis:6379/0", JUDGE_QUEUE: "noj:judge:queue", RESULT_QUEUE: "noj:judge:results", JUDGE_MAX_CONCURRENT_JUDGES: "2" } }),
    nginx: dockerComponent({ image: "nginx:1.27-alpine", port: 8080, host_port: opts.port, env: {} }),
  };
  return cfg;
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/init/templates_test.ts`
Expected: PASS。

- [ ] **Step 6: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj split noj-cli/src/init/templates.ts noj-cli/src/init/secrets.ts noj-cli/src/init/templates_test.ts
jj describe -m "feat(cli): 实现 init 模板与密钥生成（dev/prod）"
```

---

### Task 7: init 引导流程 `src/init/wizard.ts`

**Files:**
- Create: `noj-cli/src/init/wizard.ts`
- Create: `noj-cli/src/init/wizard_test.ts`

**Interfaces:**
- Consumes: `PromptIO`（Task 5）、`select`/`input`/`secretInput`/`confirm`（Task 5）、`SystemProbe`（Task 1）、`runDoctor`/`DoctorOptions`/`formatReport`（Task 3）、`devTemplate`/`prodTemplate`/`ProdTemplateOptions`（Task 6）、`generateSecrets`（Task 6）、`DeployConfig`/`SecretsConfig`（P0）。
- Produces：
  - `export interface InitOptions { mode?: "dev" | "prod"; port?: number; installDir: string }`
  - `export async function runInitWizard(io: PromptIO, probe: SystemProbe, opts: InitOptions): Promise<{ config: DeployConfig; secrets: SecretsConfig }>`
  - 流程：欢迎页 → 模式选择（`opts.mode` 缺省时用 `select`）→ 运行 `runDoctor` 并打印 `formatReport`（不阻断）→ 按模式引导 → 摘要确认（`confirm`）→ 返回 `{ config, secrets }`（不落盘，落盘由调用方 `saveDeployment` 负责）。

- [ ] **Step 1: 写失败测试**

创建 `noj-cli/src/init/wizard_test.ts`：

```ts
import { assertEquals } from "@std/assert";
import type { PromptIO } from "../tui/io.ts";
import type { SystemProbe } from "../doctor/probe.ts";
import { runInitWizard } from "./wizard.ts";

class FakeIO implements PromptIO {
  writes: string[] = [];
  answers: string[];
  constructor(answers: string[]) {
    this.answers = answers;
  }
  write(text: string): void {
    this.writes.push(text);
  }
  async readLine(_p: string): Promise<string> {
    return this.answers.shift() ?? "";
  }
  async readSecret(_p: string): Promise<string> {
    return this.answers.shift() ?? "";
  }
}

function okProbe(): SystemProbe {
  return {
    os: "linux",
    arch: "x86_64",
    run: async () => ({ code: 0, stdout: "ok", stderr: "" }),
    memInfo: async () => ({ totalBytes: 8 * 1024 ** 3, swapBytes: 2 * 1024 ** 3 }),
    diskFree: async () => ({ freeBytes: 50 * 1024 ** 3 }),
    portOpen: async () => false,
  };
}

Deno.test("runInitWizard: dev 模式（显式 mode）生成 dev 配置", async () => {
  // 流程：端口输入 8080 → 数据目录输入 /opt/data → 摘要确认 y
  const io = new FakeIO(["8080", "/opt/data", "y"]);
  const { config, secrets } = await runInitWizard(io, okProbe(), {
    mode: "dev",
    installDir: "/opt/neuro-oj",
  });
  assertEquals(config.type, "dev");
  assertEquals(config.state, "stopped");
  assertEquals(secrets.secrets["JWT_SECRET"]!.length >= 32, true);
});

Deno.test("runInitWizard: 未指定 mode 时先选择模式（选 prod）", async () => {
  // 选择 prod(2) → 域名 → https y → 端口 8080 → judge n → email disabled(1) → 确认 y
  const io = new FakeIO(["2", "oj.example.com", "y", "8080", "n", "1", "y"]);
  const { config } = await runInitWizard(io, okProbe(), {
    installDir: "/opt/neuro-oj",
  });
  assertEquals(config.type, "prod");
  assertEquals(config.env["DOMAIN"], "oj.example.com");
});

Deno.test("runInitWizard: 摘要确认 n 时抛错", async () => {
  const io = new FakeIO(["8080", "/opt/data", "n"]);
  let threw = false;
  try {
    await runInitWizard(io, okProbe(), { mode: "dev", installDir: "/opt/neuro-oj" });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/init/wizard_test.ts`
Expected: FAIL，`Cannot find module .../wizard.ts`。

- [ ] **Step 3: 实现 `src/init/wizard.ts`**

```ts
import type { PromptIO } from "../tui/io.ts";
import { select, input, secretInput, confirm } from "../tui/widgets.ts";
import type { SystemProbe } from "../doctor/probe.ts";
import { runDoctor } from "../doctor/doctor.ts";
import { formatReport } from "../doctor/report.ts";
import { devTemplate, prodTemplate, type ProdTemplateOptions } from "./templates.ts";
import { generateSecrets } from "./secrets.ts";
import type { DeployConfig, SecretsConfig } from "../config/types.ts";

/** init 引导选项。 */
export interface InitOptions {
  mode?: "dev" | "prod";
  port?: number;
  installDir: string;
}

/** 引导 dev 模式：组件开关、端口、数据目录。 */
async function guideDev(
  io: PromptIO,
  opts: InitOptions,
): Promise<{ config: DeployConfig; secrets: SecretsConfig }> {
  const port = Number(await input(io, "对外端口", String(opts.port ?? 8080)));
  const dataDir = await input(io, "数据目录", `${opts.installDir}/data`);
  const config = devTemplate(opts.installDir, port);
  config.env["DATA_DIR"] = dataDir;
  const secrets = generateSecrets("dev");
  return { config, secrets };
}

/** 引导 prod 模式：域名、HTTPS、端口、Judge、邮件、反向代理。 */
async function guideProd(
  io: PromptIO,
  opts: InitOptions,
): Promise<{ config: DeployConfig; secrets: SecretsConfig }> {
  const domain = await input(io, "网站地址（域名）", "oj.example.com");
  const https = await confirm(io, "启用 HTTPS", true);
  const port = Number(await input(io, "对外端口", String(opts.port ?? 8080)));
  const judgeEnabled = await confirm(io, "启用 Judge 评测组件", false);
  const emailIdx = await select(io, "邮件服务", ["disabled", "smtp"]);
  const emailProvider = emailIdx === 0 ? "disabled" : "smtp";
  const tplOpts: ProdTemplateOptions = {
    installDir: opts.installDir,
    domain,
    https,
    port,
    judgeEnabled,
    emailProvider,
  };
  const config = prodTemplate(tplOpts);
  const secrets = generateSecrets("prod");
  return { config, secrets };
}

/** 运行 deploy init 引导，返回待落盘的配置与密钥。 */
export async function runInitWizard(
  io: PromptIO,
  probe: SystemProbe,
  opts: InitOptions,
): Promise<{ config: DeployConfig; secrets: SecretsConfig }> {
  io.write("=== noj-cli deploy init ===\n");

  let mode = opts.mode;
  if (mode === undefined) {
    const idx = await select(io, "选择部署模式", ["dev（开发）", "prod（生产）"]);
    mode = idx === 0 ? "dev" : "prod";
  }

  // 自动运行 doctor 环境检测，彩色清单展示（不阻断）。
  const report = await runDoctor(probe, {
    port: opts.port ?? 8080,
    installDir: opts.installDir,
  });
  io.write(formatReport(report) + "\n");

  const result = mode === "dev"
    ? await guideDev(io, opts)
    : await guideProd(io, opts);

  io.write("=== 配置摘要 ===\n");
  io.write(`模式: ${result.config.type}\n`);
  io.write(`安装目录: ${result.config.install_dir}\n`);
  io.write(`组件: ${Object.keys(result.config.components).join(", ")}\n`);

  const ok = await confirm(io, "确认写入配置", true);
  if (!ok) {
    throw new Error("用户取消，未写入配置");
  }
  return result;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/init/wizard_test.ts`
Expected: PASS。

- [ ] **Step 5: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj split noj-cli/src/init/wizard.ts noj-cli/src/init/wizard_test.ts
jj describe -m "feat(cli): 实现 deploy init 引导流程 runInitWizard"
```

---

### Task 8: 接入 `deploy init` 命令到 `src/cli.ts`

**Files:**
- Modify: `noj-cli/src/cli.ts`（`deploy init` 分支）
- Modify: `noj-cli/src/cli_test.ts`（新增 init 用例）

**Interfaces:**
- Consumes: `realIO`（Task 5）、`realProbe`（Task 1）、`runInitWizard`/`InitOptions`（Task 7）、`saveDeployment`（P0）、`findDeployDir`（P0）。
- Produces：
  - `export function parseInitOptions(args: string[], cwd: string): InitOptions`（解析 `--mode dev|prod`、`--port <n>`、`--dir <path>`；`installDir` 缺省为 `--dir` 或 `cwd`）
  - `deploy init` 命令行为：解析选项 → `runInitWizard(realIO(), realProbe(), opts)` → `saveDeployment(opts.installDir, config, secrets)` → 打印成功消息，返回 `0`。

- [ ] **Step 1: 写失败测试**

在 `noj-cli/src/cli_test.ts` 末尾追加：

```ts
import { parseInitOptions } from "./cli.ts";

Deno.test("parseInitOptions: 缺省 mode/port/installDir", () => {
  const opts = parseInitOptions([], "/tmp");
  assertEquals(opts.mode, undefined);
  assertEquals(opts.port, undefined);
  assertEquals(opts.installDir, "/tmp");
});

Deno.test("parseInitOptions: 解析 --mode prod --port 9000 --dir /opt", () => {
  const opts = parseInitOptions(["--mode", "prod", "--port", "9000", "--dir", "/opt"], "/tmp");
  assertEquals(opts.mode, "prod");
  assertEquals(opts.port, 9000);
  assertEquals(opts.installDir, "/opt");
});

Deno.test("parseInitOptions: 非法 mode 抛错", () => {
  let threw = false;
  try {
    parseInitOptions(["--mode", "staging"], "/tmp");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/cli_test.ts`
Expected: FAIL，`parseInitOptions` 未定义。

- [ ] **Step 3: 实现 `parseInitOptions` 并接入 deploy init 分支**

在 `noj-cli/src/cli.ts` 顶部 import 区追加：

```ts
import { realIO } from "./tui/io.ts";
import { runInitWizard, type InitOptions } from "./init/wizard.ts";
import { saveDeployment } from "./config/save.ts";
```

在 `dispatchCommand` 的 `case "deploy":` 分支内，`init` 子命令分支替换为：

```ts
case "deploy": {
  const sub = args[0] ?? "";
  if (sub === "init") {
    const opts = parseInitOptions(args.slice(1), ctx.cwd);
    const { config, secrets } = await runInitWizard(realIO(), realProbe(), opts);
    await saveDeployment(opts.installDir, config, secrets);
    console.log(`已写入 ${opts.installDir}/noj-deploy.json 与 noj-secrets.json`);
    return 0;
  }
  if (DEPLOY_SUBCOMMANDS.includes(sub)) {
    console.log(`deploy ${sub}: 生命周期逻辑留待后续计划（部署目录: ${ctx.deployDir ?? "未找到"}）`);
  } else {
    console.log("deploy: 需要子命令 init/up/down/restart/status（P0 占位）");
  }
  return 0;
}
```

在文件内（`parsePort` 之后）新增：

```ts
/** 解析 deploy init 选项：--mode dev|prod、--port <n>、--dir <path>。 */
export function parseInitOptions(args: string[], cwd: string): InitOptions {
  let mode: "dev" | "prod" | undefined;
  let port: number | undefined;
  let dir: string | undefined;

  const modeIdx = args.indexOf("--mode");
  if (modeIdx !== -1) {
    const raw = args[modeIdx + 1];
    if (raw !== "dev" && raw !== "prod") {
      throw new Error(`非法模式: ${raw}，仅支持 dev/prod`);
    }
    mode = raw;
  }
  const portIdx = args.indexOf("--port");
  if (portIdx !== -1) {
    const n = Number(args[portIdx + 1]);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw new Error(`非法端口: ${args[portIdx + 1]}`);
    }
    port = n;
  }
  const dirIdx = args.indexOf("--dir");
  if (dirIdx !== -1) {
    dir = args[dirIdx + 1];
  }

  return { mode, port, installDir: dir ?? cwd };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/cli_test.ts`
Expected: PASS。

- [ ] **Step 5: 手动冒烟验证（在临时目录）**

Run:
```bash
cd noj-cli && TMP=$(mktemp -d) && printf '1\n8080\n%s/data\ny\n' "$TMP" | deno run -A src/cli.ts deploy init --mode dev --dir "$TMP" && ls -la "$TMP"
```
Expected: 生成 `noj-deploy.json`（644）与 `noj-secrets.json`（600），输出成功消息。

- [ ] **Step 6: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj split noj-cli/src/cli.ts noj-cli/src/cli_test.ts
jj describe -m "feat(cli): 接入 deploy init 命令（TUI 引导 + 落盘）"
```

---

### Task 9: P1 收尾 —— 全量验证与文档

**Files:**
- Modify: `noj-cli/README.md`（补充 P1 范围与用法）
- Modify: `noj-cli/src/mod.ts`（导出 P1 公共接口，供后续计划复用）

**Interfaces:**
- Consumes: 全部 Task 1–8 产物。
- Produces：`src/mod.ts` 聚合导出 `runDoctor`/`formatReport`/`SystemProbe`/`realProbe`、`runInitWizard`/`InitOptions`、`devTemplate`/`prodTemplate`/`generateSecrets`、`PromptIO`/`realIO` 与表单控件。

- [ ] **Step 1: 更新 `src/mod.ts` 聚合导出**

将 `noj-cli/src/mod.ts` 整体替换为：

```ts
/** noj-cli 版本号，与 deno.json 的 version 保持一致。 */
export const VERSION = "0.1.0";

// 配置模型（P0）
export * from "./config/types.ts";
export { loadDeployment } from "./config/load.ts";
export { saveDeployment } from "./config/save.ts";
export { validateConfig } from "./config/validate.ts";
export { resolveComponentEnv } from "./config/merge.ts";
export { DEPLOY_FILE, SECRETS_FILE, DEPLOY_FILE_MODE, SECRETS_FILE_MODE } from "./config/io.ts";

// 状态机与工具（P0）
export { transition } from "./state/machine.ts";
export type { DeployAction, TransitionResult } from "./state/machine.ts";
export { findDeployDir } from "./util/find_deploy_dir.ts";

// doctor（P1）
export type { SystemProbe, CmdResult, MemInfo, DiskInfo } from "./doctor/probe.ts";
export { realProbe } from "./doctor/probe.ts";
export type { CheckResult } from "./doctor/checks.ts";
export { runDoctor } from "./doctor/doctor.ts";
export type { DoctorOptions, DoctorReport } from "./doctor/doctor.ts";
export { formatReport } from "./doctor/report.ts";

// TUI（P1）
export type { PromptIO } from "./tui/io.ts";
export { realIO } from "./tui/io.ts";
export { select, input, secretInput, confirm } from "./tui/widgets.ts";

// init（P1）
export { devTemplate, prodTemplate } from "./init/templates.ts";
export type { ProdTemplateOptions } from "./init/templates.ts";
export { generateSecrets, randomKey } from "./init/secrets.ts";
export { runInitWizard } from "./init/wizard.ts";
export type { InitOptions } from "./init/wizard.ts";
```

- [ ] **Step 2: 验证导出的类型检查**

Run: `cd noj-cli && deno task check`
Expected: 通过。

- [ ] **Step 3: 全量测试**

Run: `cd noj-cli && deno task test`
Expected: 全部 PASS。

- [ ] **Step 4: 更新 `noj-cli/README.md`**

在 `## 状态` 一节追加 P1 说明，并补充用法：

```markdown
## 状态

P1：实现 `doctor`（只读环境检测）与 `deploy init`（dev/prod TUI 引导生成
`noj-deploy.json` + `noj-secrets.json`）。doctor 不安装、不写文件；init 不提供
`--non-interactive`。up/down/restart/status 与 maintain 系列留待后续计划。

## 用法

```bash
cd noj-cli
deno run -A src/cli.ts doctor --port 8080
deno run -A src/cli.ts deploy init --mode dev --dir /opt/neuro-oj
deno run -A src/cli.ts deploy init --mode prod --dir /opt/neuro-oj
```

## 目录

- `src/cli.ts` 命令分发入口
- `src/config/` 配置模型（types/load/save/validate/merge/io）
- `src/state/machine.ts` 部署状态机
- `src/util/find_deploy_dir.ts` 部署目录查找
- `src/doctor/` 环境检测（probe/checks/doctor/report）
- `src/tui/` 交互抽象与表单控件（io/widgets）
- `src/init/` deploy init 引导（templates/secrets/wizard）
```

- [ ] **Step 5: 全量验证**

Run: `cd noj-cli && deno task test && deno task check`
Expected: 全部通过。

- [ ] **Step 6: 提交本任务**

```bash
jj split noj-cli/src/mod.ts noj-cli/README.md
jj describe -m "feat(cli): 聚合 P1 公共导出并更新项目说明"
```

---

## 自审清单

- **范围**：P1 只交付 `doctor`（只读环境检测）与 `deploy init`（dev/prod TUI 引导生成两个 JSON）；未实现 up/down/restart/status、maintain 系列、`--non-interactive`。
- **接口一致**：沿用 P0 公共接口精确签名（`loadDeployment`/`saveDeployment`/`resolveComponentEnv`/`transition`/`findDeployDir`/`cli.ts`），未改动其签名；P1 新增接口（`SystemProbe`/`runDoctor`/`PromptIO`/`runInitWizard`/`devTemplate`/`prodTemplate`/`generateSecrets`）在 `src/mod.ts` 聚合导出。
- **约束落实**：Deno + TypeScript；linux/amd64 在 `checkOs`/`checkArch` 中强制；doctor 只读（仅 `Deno.Command`/`/proc/meminfo`/`df`/`Deno.connect`，不写文件）；init 不提供 `--non-interactive`；敏感输入 `readSecret` 用 `setRaw(true)` 关闭回显；随机密钥写入 secrets；测试经 `deno task test` / `deno task check`；提交用 jj + 中文描述 + `feat(cli)` scope。
- **可测试性**：doctor 通过 `SystemProbe` 注入 fake 命令/环境；init 通过 `PromptIO` 注入脚本化表单输入；两者均有独立 Deno 测试。
- **每个任务** 都以 失败测试→跑失败→实现→跑通过→提交 的 bite-sized 步骤组织，且每个步骤给出真实代码或命令。
