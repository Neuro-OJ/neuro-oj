/**
 * 生产生命周期测试：logs 颜色契约与 --follow。
 *
 * 全部注入 runner / fetcher / IO，永不触碰真实 docker 与网络。
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { CommandRunner, SpawnHandle } from "../runtime/command.ts";
import { logs } from "./lifecycle.ts";
import {
  captureRenderIO,
  COMPOSE,
  COMPOSE_BODY,
  configOk,
  ENV_FILE,
  makeInstalledDir,
  makeRunner,
  NO_COLOR,
  RunnerCall,
} from "./lifecycle_fixtures.ts";

// ---------------- logs（颜色契约 + --follow） ----------------
//
// 进程环境经 withLogEnv 临时置值
// （与 util/color_test.ts 同法），用例结束即恢复，不污染其他测试。
// 全部注入 runner：缓冲路径走 run、实时路径走 stream，绝不触真实 docker。

/**
 * 临时设置/清除 `LOG_COLOR` / `NO_COLOR` 两个进程环境变量，结束后恢复。
 *
 * 未在 `env` 中给出的键会被**清除**，因此断言不会被运行环境里的残留变量
 * 污染（`NO_COLOR=1` 是常见 CI 变量）。
 */
async function withLogEnv<T>(
  env: { LOG_COLOR?: string; NO_COLOR?: string },
  fn: () => Promise<T>,
): Promise<T> {
  const keys = ["LOG_COLOR", "NO_COLOR"] as const;
  const saved = new Map<string, string | undefined>(
    keys.map((k) => [k, Deno.env.get(k)]),
  );
  for (const k of keys) {
    const value = env[k];
    if (value === undefined) Deno.env.delete(k);
    else Deno.env.set(k, value);
  }
  try {
    return await fn();
  } finally {
    for (const k of keys) {
      const value = saved.get(k);
      if (value === undefined) Deno.env.delete(k);
      else Deno.env.set(k, value);
    }
  }
}

/** logs 专用 fake：分别记录缓冲（run）与实时（stream）两条路径。 */
function makeLogsRunner(
  options: {
    stdout?: string;
    stderr?: string;
    code?: number;
    streamLines?: string[];
    streamCode?: number;
  } = {},
): {
  runner: CommandRunner;
  runs: RunnerCall[];
  streams: RunnerCall[];
  events: string[];
} {
  const runs: RunnerCall[] = [];
  const streams: RunnerCall[] = [];
  const events: string[] = [];
  const runner: CommandRunner = {
    run(cmd, args) {
      runs.push({ cmd, args: [...args] });
      // compose config 是 prepareAndCheck 的第 6 步；logs 命令的断言要能
      // 区分「前置校验」与「真正的日志调用」，故在时间轴上打点。
      events.push(
        cmd === "docker" && args.includes("logs")
          ? "run:logs"
          : "run:" + args.join(" "),
      );
      const isLogs = cmd === "docker" && args.includes("logs");
      return Promise.resolve({
        code: isLogs ? (options.code ?? 0) : 0,
        stdout: isLogs ? (options.stdout ?? "") : "",
        stderr: isLogs ? (options.stderr ?? "") : "",
      });
    },
    spawn(): SpawnHandle {
      throw new Error("logs 测试不 spawn");
    },
    stream(cmd, args, onLine) {
      streams.push({ cmd, args: [...args] });
      events.push("stream:logs");
      for (const line of options.streamLines ?? []) onLine(line);
      return Promise.resolve(options.streamCode ?? 0);
    },
  };
  return { runner, runs, streams, events };
}

/** 取 `compose logs` 调用的完整参数数组（不存在即抛错，避免空断言）。 */
function logsCall(calls: RunnerCall[]): string[] {
  const hit = calls.find((c) => c.cmd === "docker" && c.args.includes("logs"));
  if (hit === undefined) throw new Error("没有 compose logs 调用");
  return hit.args;
}

/** 断言全局 `--ansi always` 出现在 `logs` 子命令**之前**（而非追加在其后）。 */
function assertForcedAnsi(args: string[]): void {
  const ansi = args.indexOf("--ansi");
  const sub = args.indexOf("logs");
  assert(ansi !== -1, "缺少全局 --ansi：" + args.join(" "));
  assert(sub !== -1, "缺少 logs 子命令：" + args.join(" "));
  assert(ansi < sub, "--ansi always 必须排在子命令之前：" + args.join(" "));
  assertEquals(args[ansi + 1], "always");
  assertEquals(args.includes("--no-color"), false);
}

Deno.test("logs 着色优先级：进程 env LOG_COLOR=always 覆盖 .env.prod 的 never → 强制 --ansi always", async () => {
  const dir = await makeInstalledDir({ LOG_COLOR: "never" });
  try {
    const { runner, runs } = makeLogsRunner({ stdout: "line-1\n" });
    const { io } = captureRenderIO();
    const result = await withLogEnv(
      { LOG_COLOR: "always" },
      () => logs({ dir, runner, io, color: NO_COLOR }),
    );
    assertEquals(result.exitCode, 0);
    assertEquals(result.colorDecision, "force");
    assertForcedAnsi(logsCall(runs));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("logs 着色优先级：进程 env 未设 → 回退 .env.prod 的 LOG_COLOR=always", async () => {
  const dir = await makeInstalledDir({ LOG_COLOR: "always" });
  try {
    const { runner, runs } = makeLogsRunner({ stdout: "line-1\n" });
    const { io } = captureRenderIO();
    const result = await withLogEnv(
      {},
      () => logs({ dir, runner, io, color: NO_COLOR }),
    );
    assertEquals(result.exitCode, 0);
    assertEquals(result.colorDecision, "force");
    assertForcedAnsi(logsCall(runs));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("logs 着色优先级：进程 env LOG_COLOR=never 覆盖 .env.prod 的 always", async () => {
  const dir = await makeInstalledDir({ LOG_COLOR: "always" });
  try {
    const { runner, runs } = makeLogsRunner({ stdout: "line-1\n" });
    const { io } = captureRenderIO();
    const result = await withLogEnv(
      { LOG_COLOR: "never" },
      () => logs({ dir, runner, io, color: NO_COLOR }),
    );
    assertEquals(result.colorDecision, "no-color");
    const args = logsCall(runs);
    assertEquals(args.includes("--no-color"), true);
    assertEquals(args.includes("--ansi"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('logs 着色：LOG_COLOR 去空白 + 小写归一（" ALWAYS " → always）', async () => {
  const dir = await makeInstalledDir({ LOG_COLOR: " Never " });
  try {
    const { io } = captureRenderIO();
    // 进程 env（首尾空白 + 大写）优先于 .env.prod 的 " Never "
    const envCase = makeLogsRunner({ stdout: "line-1\n" });
    const forced = await withLogEnv(
      { LOG_COLOR: " ALWAYS " },
      () => logs({ dir, runner: envCase.runner, io, color: NO_COLOR }),
    );
    assertEquals(forced.colorDecision, "force");
    assertForcedAnsi(logsCall(envCase.runs));

    // 进程 env 未设 → .env.prod 的 " Never " 同样归一为 never
    const fileCase = makeLogsRunner({ stdout: "line-1\n" });
    const fileOnly = await withLogEnv(
      {},
      () => logs({ dir, runner: fileCase.runner, io, color: NO_COLOR }),
    );
    assertEquals(fileOnly.colorDecision, "no-color");
    assertEquals(logsCall(fileCase.runs).includes("--no-color"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("logs 分支顺序：NO_COLOR 非空 → --no-color，即使 LOG_COLOR=always", async () => {
  const dir = await makeInstalledDir();
  const envDir = await makeInstalledDir({ LOG_COLOR: "always", NO_COLOR: "1" });
  try {
    const { io } = captureRenderIO();

    // 进程 env 同时给出：NO_COLOR 分支在前
    const envCase = makeLogsRunner({ stdout: "line-1\n" });
    const envResult = await withLogEnv(
      { NO_COLOR: "1", LOG_COLOR: "always" },
      () => logs({ dir, runner: envCase.runner, io }),
    );
    assertEquals(envResult.colorDecision, "no-color");
    assertEquals(logsCall(envCase.runs).includes("--no-color"), true);
    assertEquals(logsCall(envCase.runs).includes("--ansi"), false);

    // .env.prod 同时给出：同样 NO_COLOR 优先
    const fileCase = makeLogsRunner({ stdout: "line-1\n" });
    const fileResult = await withLogEnv(
      {},
      () => logs({ dir: envDir, runner: fileCase.runner, io }),
    );
    assertEquals(fileResult.colorDecision, "no-color");
    assertEquals(logsCall(fileCase.runs).includes("--no-color"), true);
    assertEquals(logsCall(fileCase.runs).includes("--ansi"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(envDir, { recursive: true });
  }
});

Deno.test("logs 重定向安全：NO_COLOR=1 强制关色 → --no-color，且自身输出不含 ANSI", async () => {
  const dir = await makeInstalledDir();
  try {
    const { runner, runs } = makeLogsRunner({ stdout: "line-1\n" });
    const { io, stdout, stderr } = captureRenderIO();
    // 断言必须**无条件执行**：显式给进程 env 的 NO_COLOR，使判定与
    // 运行器是否 TTY 无关（否则交互式 runner 下整条断言变成 no-op）。
    const result = await withLogEnv(
      { NO_COLOR: "1" },
      () => logs({ dir, runner, io }),
    );
    assertEquals(result.exitCode, 0);
    assertEquals(result.colorDecision, "no-color");
    assertEquals(logsCall(runs).includes("--no-color"), true);
    assertEquals(logsCall(runs).includes("--ansi"), false);
    // `noj-cli logs core > out.txt` 的等价场景：不得把 ANSI 写进重定向文件。
    for (const chunk of [...stdout, ...stderr]) {
      assertEquals(chunk.includes("\x1b["), false, "重定向输出不得含 ANSI");
    }
    assertStringIncludes(stdout.join(""), "line-1\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("logs 重定向安全：非 TTY 的 auto 路径 → --no-color（TTY 下为 inherit）", async () => {
  const dir = await makeInstalledDir();
  try {
    const { runner, runs } = makeLogsRunner({ stdout: "line-1\n" });
    const { io } = captureRenderIO();
    const result = await withLogEnv({}, () => logs({ dir, runner, io }));
    assertEquals(result.exitCode, 0);
    // 无任何色旗输入时，判定 = stdout 是否 TTY：
    // 非 TTY（测试进程前提，与 util/color_test.ts 同一前提）→ no-color；
    // TTY → inherit（不传色旗，交回 compose 自行探测）。
    const expected = Deno.stdout.isTerminal() ? "inherit" : "no-color";
    assertEquals(result.colorDecision, expected);
    assertEquals(
      logsCall(runs).includes("--no-color"),
      expected === "no-color",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("logs core --follow：走 stream（实时），参数为 --tail=200 --follow core", async () => {
  const dir = await makeInstalledDir();
  try {
    const { runner, runs, streams } = makeLogsRunner({
      streamLines: ["a", "b"],
    });
    const { io, stdout } = captureRenderIO();
    const result = await withLogEnv({ LOG_COLOR: "always" }, () =>
      logs({
        dir,
        runner,
        io,
        color: NO_COLOR,
        services: ["core"],
        follow: true,
      }));
    assertEquals(result.exitCode, 0);
    assertEquals(result.followed, true);
    assertEquals(result.colorDecision, "force");
    // 实时跟随走 stream，缓冲的 run 不接 logs（run 无法实时输出）
    assertEquals(streams.length, 1);
    assertEquals(
      runs.some((r) => r.args.includes("logs")),
      false,
      "实时跟随不得走缓冲 run",
    );
    const args = streams[0]!.args;
    assertForcedAnsi(args);
    // 子命令之后：--tail=200 --follow <services>（强制着色走全局 --ansi，故无色旗）
    assertEquals(
      args.slice(args.indexOf("logs")),
      ["logs", "--tail=200", "--follow", "core"],
    );
    // 实时逐行写 stdout（runner 不打印，由命令自己写）
    assertEquals(stdout.join("").endsWith("a\nb\n"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("logs 非 follow：走缓冲 run，stdout 原样写 stdout、stderr 原样转 stderr", async () => {
  const dir = await makeInstalledDir();
  try {
    const { runner, runs, streams } = makeLogsRunner({
      stdout: "line-1\n",
      stderr: "warn-1\n",
    });
    const { io, stdout, stderr } = captureRenderIO();
    const result = await withLogEnv(
      {},
      () => logs({ dir, runner, io, color: NO_COLOR }),
    );
    assertEquals(result.exitCode, 0);
    assertEquals(result.followed, false);
    assertEquals(streams, []);
    assertEquals(runs.filter((r) => r.args.includes("logs")).length, 1);
    assertEquals(stdout.join("").endsWith("line-1\n"), true);
    assertStringIncludes(stderr.join(""), "warn-1\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("logs --json：stdout 逐字节为合法 JSON，日志与诊断改道 stderr", async () => {
  const dir = await makeInstalledDir();
  try {
    const { runner } = makeLogsRunner({ stdout: "line-1\n" });
    const { io, stdout, stderr } = captureRenderIO(true);
    const result = await withLogEnv(
      {},
      () => logs({ dir, runner, io, color: NO_COLOR, args: ["--json"] }),
    );
    assertEquals(result.exitCode, 0);
    assertEquals(
      stdout.join(""),
      JSON.stringify(
        {
          dir,
          services: [],
          colorDecision: "no-color",
          followed: false,
          error: null,
        },
        null,
        2,
      ) + "\n",
    );
    assertStringIncludes(stderr.join(""), "line-1\n");
    assertEquals(stdout.join("").includes("\x1b["), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("logs：compose logs 非 0 → 退出码 1，诊断写 stderr", async () => {
  const dir = await makeInstalledDir();
  try {
    const { runner } = makeLogsRunner({ stderr: "boom\n", code: 2 });
    const { io, stderr } = captureRenderIO();
    const result = await withLogEnv(
      {},
      () => logs({ dir, runner, io, color: NO_COLOR }),
    );
    assertEquals(result.exitCode, 1);
    assertEquals(result.error !== null, true);
    assertStringIncludes(stderr.join(""), "boom");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("logs：前置校验失败 → 退出码 1 且零 compose logs 调用", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, COMPOSE), COMPOSE_BODY);
    const { runner, runs } = makeLogsRunner();
    const { io, stderr } = captureRenderIO();
    const result = await withLogEnv(
      {},
      () => logs({ dir, runner, io, color: NO_COLOR }),
    );
    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.error ?? "", "找不到生产配置");
    assertEquals(runs.filter((r) => r.args.includes("logs")), []);
    assertStringIncludes(stderr.join(""), "找不到生产配置");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("logs core：服务名透传，且 --no-color 排在服务名之前、--tail=200 之后", async () => {
  const dir = await makeInstalledDir();
  try {
    const { runner, runs } = makeLogsRunner({ stdout: "line-1\n" });
    const { io } = captureRenderIO();
    const result = await withLogEnv(
      {},
      () =>
        logs({ dir, runner, io, color: NO_COLOR, services: ["core", "nginx"] }),
    );
    assertEquals(result.exitCode, 0);
    assertEquals(
      logsCall(runs),
      [
        "compose",
        "--project-directory",
        dir,
        "--env-file",
        join(dir, ENV_FILE),
        "-f",
        join(dir, COMPOSE),
        "logs",
        "--tail=200",
        "--no-color",
        "core",
        "nginx",
      ],
      "--no-color 必须在 --tail 之后、服务名之前",
    );
    assertEquals(result.services, ["core", "nginx"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("logs：进程 env 的 LOG_COLOR 为空串 → 回退 .env.prod", async () => {
  const dir = await makeInstalledDir({ LOG_COLOR: "always" });
  try {
    const { runner, runs } = makeLogsRunner({ stdout: "line-1\n" });
    const { io } = captureRenderIO();
    const result = await withLogEnv(
      { LOG_COLOR: "" },
      () => logs({ dir, runner, io, color: NO_COLOR }),
    );
    assertEquals(result.colorDecision, "force");
    assertForcedAnsi(logsCall(runs));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("logs --follow 非 0：退出码 1，且诊断走 stderr", async () => {
  const dir = await makeInstalledDir();
  try {
    const { runner, streams } = makeLogsRunner({
      streamLines: ["a"],
      streamCode: 3,
    });
    const { io, stderr } = captureRenderIO();
    const result = await withLogEnv({}, () =>
      logs({
        dir,
        runner,
        io,
        color: NO_COLOR,
        services: ["core"],
        follow: true,
      }));
    assertEquals(result.exitCode, 1);
    assertEquals(streams.length, 1);
    assertStringIncludes(stderr.join(""), "查看生产服务日志失败");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("logs --follow：runner 无 stream 能力 → 报错而非静默降级为缓冲", async () => {
  const dir = await makeInstalledDir();
  try {
    const records: RunnerCall[] = [];
    const { io, stderr } = captureRenderIO();
    const result = await withLogEnv({}, () =>
      logs({
        dir,
        // makeRunner 只实现 run / spawn（P2 既有形状），没有 stream。
        runner: makeRunner(records, configOk(() => undefined)),
        io,
        color: NO_COLOR,
        follow: true,
      }));
    assertEquals(result.exitCode, 1);
    assertEquals(
      records.some((r) => r.args.includes("logs")),
      false,
      "不得降级为缓冲调用（那样 --follow 永不返回）",
    );
    assertStringIncludes(stderr.join(""), "不支持实时日志");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
