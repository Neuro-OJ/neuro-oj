/**
 * 生产生命周期测试：start / stop / restart / status 状态机与配置六步前置。
 *
 * 全部注入 runner / fetcher / IO，永不触碰真实 docker 与网络。
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import type { CmdResult } from "../runtime/command.ts";
import {
  install,
  type LifecycleBaseResult,
  type LifecycleOptions,
  restart,
  start,
  status,
  stop,
} from "./lifecycle.ts";
import { COMPOSE_CONFIG_INVALID_HINT } from "./lifecycle/steps.ts";
import {
  captureRenderIO,
  COMPOSE,
  COMPOSE_BODY,
  configOk,
  ENV_FILE,
  hasSub,
  makeFetcher,
  makeInstalledDir,
  makeIO,
  makeRunner,
  NO_COLOR,
  REF,
  REPO,
  RunnerCall,
  SOCKET_PRESENT,
  writePassphraseFile,
} from "./lifecycle_fixtures.ts";

// ---------------- start / stop / restart / status（状态机） ----------------
//
// 全部使用注入 runner：永不触碰真实 docker；所有输出经注入的 RenderIO，
// 不写真实 stdout/stderr。

/** docker compose ps 表头（列间以多空格对齐，模拟 compose 的 tabwriter）。 */
const PS_HEADER =
  "NAME                IMAGE               COMMAND                  SERVICE    CREATED         STATUS                   PORTS";

/** 构造一行 compose ps 输出（固定列宽，状态列对齐表头 STATUS 字符位）。 */
function psRow(name: string, service: string, status: string): string {
  return name.padEnd(20) +
    "ghcr.io/noj/x".padEnd(20) +
    '"/entrypoint"'.padEnd(25) +
    service.padEnd(11) +
    "2 hours ago".padEnd(16) +
    status;
}

/** 全 Up：prodState → running。 */
const PS_RUNNING = [
  PS_HEADER,
  psRow("noj-core-1", "core", "Up 2 hours (healthy)"),
  psRow("noj-postgres-1", "postgres", "Up 2 hours (healthy)"),
].join("\n") + "\n";

/** 部分运行：prodState → partial。 */
const PS_PARTIAL = [
  PS_HEADER,
  psRow("noj-core-1", "core", "Up 2 hours (healthy)"),
  psRow("noj-postgres-1", "postgres", "Exited (0) 3 minutes ago"),
].join("\n") + "\n";

/** 全 Exited：prodState → stopped。 */
const PS_STOPPED = [
  PS_HEADER,
  psRow("noj-core-1", "core", "Exited (1) 2 minutes ago"),
  psRow("noj-postgres-1", "postgres", "Exited (0) 3 minutes ago"),
].join("\n") + "\n";

/** 让 compose ps 返回固定输出的 override。 */
function psOverride(
  output: string,
  code = 0,
): (cmd: string, args: string[]) => Partial<CmdResult> | undefined {
  return (cmd, args) =>
    cmd === "docker" && args.includes("ps")
      ? { code, stdout: output, stderr: "" }
      : undefined;
}

/** 四个生命周期命令的公共签名（前置校验测试用）。 */
type LifecycleFn = (opts: LifecycleOptions) => Promise<LifecycleBaseResult>;

Deno.test("status：全 Up → running，退出码 0", async () => {
  const dir = await makeInstalledDir();
  try {
    const records: RunnerCall[] = [];
    const { io, stdout } = captureRenderIO();
    const result = await status({
      dir,
      runner: makeRunner(records, configOk(psOverride(PS_RUNNING))),
      socketExists: SOCKET_PRESENT,
      io,
      color: NO_COLOR,
    });
    assertEquals(result.state, "running");
    assertEquals(result.exitCode, 0);
    assertEquals(result.error, null);
    assertEquals(result.psOutput, PS_RUNNING);
    const text = stdout.join("");
    assertStringIncludes(text, "✓ 生产服务运行中（running）");
    // 人类输出必须保留 compose ps 原表
    assertStringIncludes(text, PS_HEADER);
    assertStringIncludes(text, "noj-core-1");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("status：混合 → partial，退出码 0", async () => {
  const dir = await makeInstalledDir();
  try {
    const { io, stdout } = captureRenderIO();
    const result = await status({
      dir,
      runner: makeRunner([], configOk(psOverride(PS_PARTIAL))),
      socketExists: SOCKET_PRESENT,
      io,
      color: NO_COLOR,
    });
    assertEquals(result.state, "partial");
    assertEquals(result.exitCode, 0);
    assertStringIncludes(stdout.join(""), "! 生产服务部分运行（partial）");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("status：全 Exited → stopped，退出码 0", async () => {
  const dir = await makeInstalledDir();
  try {
    const { io, stdout } = captureRenderIO();
    const result = await status({
      dir,
      runner: makeRunner([], configOk(psOverride(PS_STOPPED))),
      socketExists: SOCKET_PRESENT,
      io,
      color: NO_COLOR,
    });
    assertEquals(result.state, "stopped");
    assertEquals(result.exitCode, 0);
    assertStringIncludes(stdout.join(""), "ℹ 生产服务未运行（stopped）");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("status：空 ps 输出 → stopped（不写任何 ps 行）", async () => {
  const dir = await makeInstalledDir();
  try {
    const { io, stdout } = captureRenderIO();
    const result = await status({
      dir,
      runner: makeRunner([], configOk(psOverride(""))),
      socketExists: SOCKET_PRESENT,
      io,
      color: NO_COLOR,
    });
    assertEquals(result.state, "stopped");
    assertEquals(result.psOutput, "");
    assertEquals(result.exitCode, 0);
    assert(
      !stdout.join("").includes(PS_HEADER),
      "空 ps 输出不得写出表头",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("status --json：stdout 逐字节为合法 JSON（人类输出改道 stderr）", async () => {
  const dir = await makeInstalledDir();
  try {
    const { io, stdout, stderr } = captureRenderIO(true);
    const result = await status({
      dir,
      runner: makeRunner([], configOk(psOverride(PS_PARTIAL))),
      socketExists: SOCKET_PRESENT,
      io,
      args: ["--json"],
      color: NO_COLOR,
    });
    assertEquals(result.state, "partial");
    // 唯一 stdout 内容 = 一个 JSON 文档：无 ANSI、无中文装饰、无 ps 表
    assertEquals(
      stdout.join(""),
      JSON.stringify({ dir, state: "partial", ps: PS_PARTIAL }, null, 2) + "\n",
    );
    assertStringIncludes(stderr.join(""), "生产服务部分运行（partial）");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("start：已 running → no-op（不调用 up），文案取自状态机", async () => {
  const dir = await makeInstalledDir();
  try {
    const records: RunnerCall[] = [];
    const { io, stdout } = captureRenderIO();
    const result = await start({
      dir,
      runner: makeRunner(records, configOk(psOverride(PS_RUNNING))),
      socketExists: SOCKET_PRESENT,
      io,
      color: NO_COLOR,
    });
    assertEquals(result.noOp, true);
    assertEquals(result.state, "running");
    assertEquals(result.exitCode, 0);
    assertEquals(
      records.some((r) => hasSub(r, "up")),
      false,
      "running 时必须 no-op：不得重复执行 compose up",
    );
    // 文案必须原样来自 transition(state, up).message
    assertStringIncludes(stdout.join(""), "已处于 running，无需重复启动");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("start：stopped → wait_for_stack 两段 up（参数逐元素精确）", async () => {
  const dir = await makeInstalledDir();
  try {
    const records: RunnerCall[] = [];
    const { io } = captureRenderIO();
    const result = await start({
      dir,
      runner: makeRunner(records, configOk(psOverride(PS_STOPPED))),
      socketExists: SOCKET_PRESENT,
      io,
      color: NO_COLOR,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.state, "running");
    assertEquals(result.noOp, false);
    const envFile = join(dir, ENV_FILE);
    const composeFile = join(dir, COMPOSE);
    const ups = records.filter((r) => hasSub(r, "up")).map((r) => r.args);
    assertEquals(ups, [
      [
        "compose",
        "--project-directory",
        dir,
        "--env-file",
        envFile,
        "-f",
        composeFile,
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        "180",
        "--remove-orphans",
      ],
      [
        "compose",
        "--project-directory",
        dir,
        "--env-file",
        envFile,
        "-f",
        composeFile,
        "up",
        "-d",
        "--force-recreate",
        "--no-deps",
        "nginx",
      ],
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stop：已 stopped → no-op（不调用 stop）", async () => {
  const dir = await makeInstalledDir();
  try {
    const records: RunnerCall[] = [];
    const { io, stdout } = captureRenderIO();
    const result = await stop({
      dir,
      runner: makeRunner(records, configOk(psOverride(PS_STOPPED))),
      socketExists: SOCKET_PRESENT,
      io,
      color: NO_COLOR,
    });
    assertEquals(result.noOp, true);
    assertEquals(result.state, "stopped");
    assertEquals(result.exitCode, 0);
    assertEquals(
      records.some((r) => hasSub(r, "stop")),
      false,
      "stopped 时必须 no-op",
    );
    assertStringIncludes(stdout.join(""), "已处于 stopped，无需重复关闭");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stop：running → compose stop，且绝不使用 down/-v（数据卷保留）", async () => {
  const dir = await makeInstalledDir();
  try {
    const records: RunnerCall[] = [];
    const { io } = captureRenderIO();
    const result = await stop({
      dir,
      runner: makeRunner(records, configOk(psOverride(PS_RUNNING))),
      socketExists: SOCKET_PRESENT,
      io,
      color: NO_COLOR,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.state, "stopped");
    assertEquals(result.noOp, false);
    const stopCall = records.find((r) => hasSub(r, "stop"));
    assert(stopCall !== undefined, "running 时必须执行 compose stop");
    assertEquals(stopCall.args, [
      "compose",
      "--project-directory",
      dir,
      "--env-file",
      join(dir, ENV_FILE),
      "-f",
      join(dir, COMPOSE),
      "stop",
    ]);
    assertEquals(
      records.some((r) =>
        r.args.includes("-v") || r.args.includes("--volumes") ||
        r.args.includes("down")
      ),
      false,
      "stop 绝不得使用 down/-v/--volumes（数据卷必须保留）",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("restart：先 stop 再 up（顺序断言）", async () => {
  const dir = await makeInstalledDir();
  try {
    const records: RunnerCall[] = [];
    const { io } = captureRenderIO();
    let psCalls = 0;
    const result = await restart({
      dir,
      io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      runner: makeRunner(
        records,
        configOk((cmd, args) => {
          if (cmd === "docker" && args.includes("ps")) {
            psCalls++;
            // 第一次（stop 前）→ running；第二次（start 前）→ 已停止。
            return {
              code: 0,
              stdout: psCalls === 1 ? PS_RUNNING : PS_STOPPED,
              stderr: "",
            };
          }
          return undefined;
        }),
      ),
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.state, "running");
    const idxStop = records.findIndex((r) => hasSub(r, "stop"));
    const idxUp = records.findIndex((r) => hasSub(r, "up"));
    assert(idxStop >= 0, "restart 必须先停止");
    assert(idxUp > idxStop, "restart 必须在停止之后再启动");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("wait_for_stack：首段 up 失败 → 退出码 1 + status/logs 提示", async () => {
  const dir = await makeInstalledDir();
  try {
    const records: RunnerCall[] = [];
    const { io, stderr } = captureRenderIO();
    const result = await start({
      dir,
      io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      runner: makeRunner(
        records,
        configOk((cmd, args) => {
          if (cmd === "docker" && args.includes("ps")) {
            return { code: 0, stdout: PS_STOPPED, stderr: "" };
          }
          if (cmd === "docker" && args.includes("up")) {
            return { code: 1, stdout: "", stderr: "healthcheck failed" };
          }
          return undefined;
        }),
      ),
    });
    assertEquals(result.exitCode, 1);
    assertEquals(
      result.error,
      "服务启动或健康检查失败，请执行 status 和 logs 排查",
    );
    assertStringIncludes(stderr.join(""), "请执行 status 和 logs 排查");
    assertEquals(
      records.filter((r) => hasSub(r, "up")).length,
      1,
      "首段失败必须立即中止，不得执行第二段 nginx 刷新",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("wait_for_stack：第二段 nginx 失败 → 退出码 1 + 反向代理刷新提示", async () => {
  const dir = await makeInstalledDir();
  try {
    const records: RunnerCall[] = [];
    const { io, stderr } = captureRenderIO();
    let ups = 0;
    const result = await start({
      dir,
      io,
      color: NO_COLOR,
      socketExists: SOCKET_PRESENT,
      runner: makeRunner(
        records,
        configOk((cmd, args) => {
          if (cmd === "docker" && args.includes("ps")) {
            return { code: 0, stdout: PS_STOPPED, stderr: "" };
          }
          if (cmd === "docker" && args.includes("up")) {
            ups++;
            return ups === 1
              ? { code: 0, stdout: "", stderr: "" }
              : { code: 1, stdout: "", stderr: "nginx boom" };
          }
          return undefined;
        }),
      ),
    });
    assertEquals(result.exitCode, 1);
    assertEquals(result.error, "反向代理刷新失败，请执行 status 和 logs 排查");
    assertStringIncludes(stderr.join(""), "反向代理刷新失败");
    assertEquals(records.filter((r) => hasSub(r, "up")).length, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("status：compose ps 非 0 → 退出码 1", async () => {
  const dir = await makeInstalledDir();
  try {
    const { io, stderr } = captureRenderIO();
    const result = await status({
      dir,
      runner: makeRunner([], configOk(psOverride("", 1))),
      socketExists: SOCKET_PRESENT,
      io,
      color: NO_COLOR,
    });
    assertEquals(result.exitCode, 1);
    assert(result.error !== null);
    assertStringIncludes(stderr.join(""), "compose ps");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("前置：.env.prod 权限非 600/400 → 四个命令均拒绝且零 docker 调用", async () => {
  const dir = await makeInstalledDir({}, 0o644);
  try {
    const commands: ReadonlyArray<[string, LifecycleFn]> = [
      ["start", start],
      ["stop", stop],
      ["restart", restart],
      ["status", status],
    ];
    for (const [name, fn] of commands) {
      const records: RunnerCall[] = [];
      const { io } = captureRenderIO();
      const result = await fn({
        dir,
        runner: makeRunner(records, configOk(psOverride(PS_RUNNING))),
        socketExists: SOCKET_PRESENT,
        io,
        color: NO_COLOR,
      });
      assertEquals(result.exitCode, 1, name + " 必须拒绝不合格权限");
      assertStringIncludes(
        result.error ?? "",
        "生产配置文件权限必须为 600 或 400",
      );
      assertEquals(records, [], name + " 权限不合格时不得调用 docker");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("前置：缺必需配置 → 报错（复用缺失清单），零 docker 调用", async () => {
  const dir = await makeInstalledDir({ DOMAIN: "", JWT_SECRET: "" });
  try {
    const records: RunnerCall[] = [];
    const { io } = captureRenderIO();
    const result = await status({
      dir,
      runner: makeRunner(records, configOk(psOverride(PS_RUNNING))),
      socketExists: SOCKET_PRESENT,
      io,
      color: NO_COLOR,
    });
    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.error ?? "", "生产配置校验失败");
    assertStringIncludes(result.error ?? "", "DOMAIN");
    assertStringIncludes(result.error ?? "", "JWT_SECRET");
    assertEquals(records, [], "配置不合格时不得调用 docker");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------- 配置六步共享前置 ----------------
//
// prepareAndCheck 对**所有**生命周期命令与 install 跑配置校验六步（env 文件 / 权限 / 必填值 / judge socket / 端口 / compose config）。
// 以下测试锁定新增的第 4/5/6 步及其零副作用顺序。

Deno.test("前置（步骤 4）：judge 启用 → socket 检查执行（注入探针被调用）", async () => {
  // completeEnv 默认 JUDGE_ENABLED=false；显式改 true 才会检查 socket。
  // judge 启用时 validateEnv 也要求 socket 键非占位，故一并给出。
  const dir = await makeInstalledDir({
    JUDGE_ENABLED: "true",
    JUDGE_DOCKER_SOCKET: "/run/noj-judge/docker.sock",
    JUDGE_DOCKER_SOCKET_GID: "10001",
  });
  try {
    const probed: string[] = [];
    const records: RunnerCall[] = [];
    const { io } = captureRenderIO();
    const result = await status({
      dir,
      runner: makeRunner(records, configOk(psOverride(PS_RUNNING))),
      socketExists: (path) => {
        probed.push(path);
        return Promise.resolve(true);
      },
      io,
      color: NO_COLOR,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(probed.length, 1, "judge 启用时 socket 探针必须被调用一次");
    // judge=true → compose 调用必须带 --profile judge（socket 检查通过后照常执行）。
    assert(
      records.some((r) => r.args.includes("--profile")),
      "judge 启用时后续 compose 调用必须带 --profile judge",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("前置（步骤 4）：judge 关闭 → 跳过 socket 检查", async () => {
  const dir = await makeInstalledDir({ JUDGE_ENABLED: "false" });
  try {
    let calls = 0;
    const records: RunnerCall[] = [];
    const { io } = captureRenderIO();
    const result = await status({
      dir,
      runner: makeRunner(records, configOk(psOverride(PS_RUNNING))),
      socketExists: () => {
        calls++;
        return Promise.resolve(true);
      },
      io,
      color: NO_COLOR,
    });
    assertEquals(result.exitCode, 0);
    // judge 关闭 → 输出「已跳过」，不探 socket。
    assertEquals(calls, 0, "judge 关闭时不得探测 socket");
    assertEquals(
      records.some((r) => r.args.includes("--profile")),
      false,
      "judge 关闭时不得带 --profile judge",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("前置（步骤 4）：judge 启用但 socket 不存在 → 报错且零 docker 调用", async () => {
  const dir = await makeInstalledDir({
    JUDGE_ENABLED: "true",
    JUDGE_DOCKER_SOCKET: "/run/noj-judge/docker.sock",
    JUDGE_DOCKER_SOCKET_GID: "10001",
  });
  try {
    const records: RunnerCall[] = [];
    const { io } = captureRenderIO();
    const result = await status({
      dir,
      runner: makeRunner(records, configOk(psOverride(PS_RUNNING))),
      socketExists: () => Promise.resolve(false),
      io,
      color: NO_COLOR,
    });
    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.error ?? "", "Judge 隔离 Docker socket 不存在");
    assertEquals(records, [], "socket 检查失败必须早于任何 docker 调用");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("前置（步骤 5）：NGINX_PORT 取值非法 → 报错且零 docker 调用", async () => {
  const dir = await makeInstalledDir({ NGINX_PORT: "70000" });
  try {
    const records: RunnerCall[] = [];
    const { io } = captureRenderIO();
    const result = await status({
      dir,
      runner: makeRunner(records, configOk(psOverride(PS_RUNNING))),
      socketExists: SOCKET_PRESENT,
      io,
      color: NO_COLOR,
    });
    assertEquals(result.exitCode, 1);
    assertEquals(result.error, "NGINX_PORT 必须是 1-65535 的端口号");
    assertEquals(records, [], "端口非法时必须早于任何 docker 调用");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("前置（步骤 5）：端口探测注入 → 冲突告警但**不**阻断命令", async () => {
  const dir = await makeInstalledDir({ NGINX_PORT: "8080" });
  try {
    const probed: number[] = [];
    const { io, stdout } = captureRenderIO();
    const result = await status({
      dir,
      runner: makeRunner([], configOk(psOverride(PS_RUNNING))),
      socketExists: SOCKET_PRESENT,
      probePort: (port) => {
        probed.push(port);
        return Promise.resolve(true);
      },
      io,
      color: NO_COLOR,
    });
    assertEquals(result.exitCode, 0, "端口冲突只是告警，不得阻断");
    assertEquals(probed, [8080]);
    assertStringIncludes(stdout.join(""), "NGINX_PORT=8080 已被其他进程监听");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("前置（步骤 6）：compose config 失败 → 报错文案含 compose 无效提示，且零变更命令", async () => {
  const dir = await makeInstalledDir();
  try {
    const records: RunnerCall[] = [];
    const { io, stderr } = captureRenderIO();
    const result = await start({
      dir,
      runner: makeRunner(records, (cmd, args) => {
        if (cmd === "docker" && args.includes("config")) {
          return { code: 1, stdout: "", stderr: "service 'core' has no image" };
        }
        return undefined;
      }),
      socketExists: SOCKET_PRESENT,
      io,
      color: NO_COLOR,
    });
    assertEquals(result.exitCode, 1);
    assertStringIncludes(
      result.error ?? "",
      "Docker Compose 配置无效，请检查环境变量和生产 Compose 文件",
    );
    assertStringIncludes(result.error ?? "", "service 'core' has no image");
    assertStringIncludes(stderr.join(""), "Docker Compose 配置无效");
    // compose config 是唯一的 docker 调用：失败后绝不进入 up（零变更命令）。
    assertEquals(records.filter((r) => hasSub(r, "config")).length, 1);
    assertEquals(
      records.filter((r) => hasSub(r, "up") || hasSub(r, "stop")).length,
      0,
      "compose config 失败后不得执行任何变更命令",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("前置（顺序）：compose config 失败早于任何 up/stop/down（四个命令同断言）", async () => {
  const dir = await makeInstalledDir();
  try {
    const commands: ReadonlyArray<[string, LifecycleFn]> = [
      ["start", start],
      ["stop", stop],
      ["restart", restart],
      ["status", status],
    ];
    for (const [name, fn] of commands) {
      const records: RunnerCall[] = [];
      const { io } = captureRenderIO();
      const result = await fn({
        dir,
        // 只让 config 失败；ps 也故意返回 running，若不前置校验就会执行 stop/up。
        runner: makeRunner(records, (cmd, args) => {
          if (cmd === "docker" && args.includes("config")) {
            return { code: 1, stdout: "", stderr: "invalid compose" };
          }
          return { code: 0, stdout: PS_RUNNING, stderr: "" };
        }),
        socketExists: SOCKET_PRESENT,
        io,
        color: NO_COLOR,
      });
      assertEquals(result.exitCode, 1, name + " 必须因前置校验失败而拒绝");
      assertStringIncludes(result.error ?? "", "Docker Compose 配置无效");
      const mutating = records.filter((r) =>
        hasSub(r, "up") || hasSub(r, "stop") || hasSub(r, "down")
      );
      assertEquals(
        mutating,
        [],
        name + " 前置校验失败时不得记录任何变更命令（up/stop/down）",
      );
      assertEquals(
        records.filter((r) => hasSub(r, "config")).length,
        1,
        name + " 必须先且只跑一次 compose config",
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("前置（步骤 6）：install 与生命周期命令共享同一 compose config 文案", async () => {
  const dir = await makeInstalledDir();
  try {
    const passphrase = join(dir, "backup-passphrase");
    await writePassphraseFile(passphrase);
    const records: RunnerCall[] = [];
    await assertRejects(
      () =>
        install({
          dir,
          repository: REPO,
          ref: REF,
          io: makeIO([], []),
          runner: makeRunner(records, (cmd, args) => {
            if (cmd === "docker" && args.includes("config")) {
              return { code: 1, stdout: "", stderr: "invalid compose" };
            }
            return undefined;
          }),
          fetcher: makeFetcher([], []),
          nonInteractive: true,
          passphraseFile: passphrase,
          processEnv: { NOJ_BACKUP_PASSPHRASE_FILE: passphrase },
          cosignAvailable: () => Promise.resolve(true),
          socketExists: SOCKET_PRESENT,
          warn: () => {},
        }),
      Error,
      COMPOSE_CONFIG_INVALID_HINT,
    );
    assertEquals(
      records.filter((r) => hasSub(r, "config")).length,
      1,
      "install 的 validate 步骤必须跑一次 compose config",
    );
    assertEquals(
      records.filter((r) => hasSub(r, "up")).length,
      0,
      "install 的 compose config 失败后不得进入 up",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("前置：缺少 .env.prod → 明确报错（请先执行 install）", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, COMPOSE), COMPOSE_BODY);
    const records: RunnerCall[] = [];
    const { io } = captureRenderIO();
    const result = await status({
      dir,
      runner: makeRunner(records, configOk(psOverride(PS_RUNNING))),
      socketExists: SOCKET_PRESENT,
      io,
      color: NO_COLOR,
    });
    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.error ?? "", "找不到生产配置");
    assertStringIncludes(result.error ?? "", "请先执行 install");
    assertEquals(records, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
