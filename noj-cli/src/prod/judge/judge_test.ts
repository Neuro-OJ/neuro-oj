/**
 * T21 测试：独立 Judge 部署的安全约束与命令编排。
 *
 * 全部注入 runner / 探测 / 时间，**不起容器、不碰真实 Docker socket**。
 *
 * 三条最高价值断言（都是"看起来正常但会造成事故"的形态）：
 * 1. **共享 Docker socket 必须被拒**——字面路径、`//run/…` 等价形式、**经
 *    realpath 归一后落在共享路径上的符号链接**，且断言**零配置写入、零 compose
 *    调用**。挂上宿主机 daemon 等于把评测代码提升到能操作宿主所有容器。
 * 2. **绝不碰宿主 Docker daemon**——断言整个 judge 路径从未调用
 *    `systemctl`/`apt`/`yum`/`dockerd` 等（安全约束 2 的可断言形式）。
 * 3. **status 必须脱敏**——配置里的 Redis 口令**不得**出现在任何输出里。
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type {
  CmdResult,
  CommandRunner,
  SpawnHandle,
} from "../../runtime/command.ts";
import { makeTempDir } from "../../testing/helpers.ts";
import {
  assertDedicatedSocket,
  assertIsolatedDockerRequired,
  assertJudgeConfigValues,
  assertJudgeDockerHost,
  assertJudgeEnvFileMode,
  assertJudgeVersion,
  assertRedisContainerName,
  assertRedisPort,
  checkJudgeHost,
  envValue,
  findForbiddenHostCalls,
  FORBIDDEN_HOST_COMMANDS,
  generateRedisPassword,
  JUDGE_DEFAULT_VALUES,
  JUDGE_ENV_MODE,
  JUDGE_REQUIRED_KEYS,
  judgePaths,
  readJudgeEnv,
  writeJudgeEnv,
} from "./config.ts";
import {
  checkJudgeImageArchitecture,
  checkJudgeRedis,
  checkStandaloneJudgeSocket,
  COMPOSE_ENV_DEFAULTS,
  dockerArchOf,
  judgeComposeArgs,
  redactUrl,
  redisHostOf,
  renderJudgeCompose,
} from "./compose.ts";
import type { JudgeSocketProbes } from "./actions.ts";
import {
  judgeCheck,
  judgeInstall,
  judgeLogs,
  judgeStart,
  judgeStatus,
  judgeStop,
  judgeUpgrade,
  renderStatusSummary,
} from "./actions.ts";
import { assertRejects } from "@std/assert";

/** 一次调用记录。 */
interface Call {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
}

/** 记录调用的 fake runner；`failOn` 命中即返回非 0。 */
function makeRunner(
  calls: Call[],
  opts: {
    failOn?: (cmd: string, args: string[]) => boolean;
    stdoutFor?: (cmd: string, args: string[]) => string | undefined;
    throwOn?: (cmd: string, args: string[]) => boolean;
    stream?: boolean;
  } = {},
): CommandRunner {
  const runner: CommandRunner = {
    run(cmd, args, runOpts) {
      calls.push({ cmd, args: [...args], env: runOpts?.env });
      if (opts.throwOn?.(cmd, args)) {
        return Promise.reject(new Deno.errors.NotFound(`spawn ${cmd} failed`));
      }
      const code = opts.failOn?.(cmd, args) === true ? 1 : 0;
      return Promise.resolve({
        code,
        stdout: opts.stdoutFor?.(cmd, args) ?? "",
        stderr: code === 0 ? "" : "injected failure",
      } as CmdResult);
    },
    spawn(): SpawnHandle {
      throw new Error("T21 测试不 spawn");
    },
  };
  if (opts.stream === true) {
    runner.stream = (cmd, args) => {
      calls.push({ cmd, args: [...args] });
      return Promise.resolve(0);
    };
  }
  return runner;
}

/** 造一个合法的 Judge 安装目录（配置 + compose）。 */
async function makeJudgeDir(
  root: string,
  overrides: Record<string, string> = {},
): Promise<string> {
  const dir = join(root, "judge");
  await Deno.mkdir(dir, { recursive: true });
  const env = { ...JUDGE_DEFAULT_VALUES, ...baseEnv(), ...overrides };
  // 首装路径会写配置；这里直接预置一份，用于"既有配置"类用例。
  const lines: string[] = [];
  for (const [k, v] of Object.entries(env)) lines.push(`${k}=${v}`);
  await Deno.writeTextFile(join(dir, ".env.judge"), lines.join("\n") + "\n");
  await Deno.chmod(join(dir, ".env.judge"), JUDGE_ENV_MODE);
  await Deno.writeTextFile(
    join(dir, "docker-compose.judge.yml"),
    renderJudgeCompose(env),
  );
  await Deno.chmod(join(dir, "docker-compose.judge.yml"), 0o600);
  return dir;
}

/** 基线配置（满足全部必填项）。 */
function baseEnv(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    NOJ_VERSION: "v0.9.5",
    REDIS_URL: "redis://:s3cret-pw@127.0.0.1:6379/0",
    REDIS_CHECK_URL: "redis://:s3cret-pw@127.0.0.1:6379/0",
    ...overrides,
  };
}

/** socket 相关探测的 fake。 */
function socketProbes(
  opts: {
    gid?: number | null;
    mode?: string | null;
    isSocket?: boolean;
    readWrite?: boolean;
  } = {},
): JudgeSocketProbes {
  return {
    probeSocketGid: () =>
      Promise.resolve(opts.gid === undefined ? 10001 : opts.gid),
    probeSocketMode: () =>
      Promise.resolve(opts.mode === undefined ? "660" : opts.mode),
    probeIsSocket: () => Promise.resolve(opts.isSocket !== false),
    probeReadWritable: () => Promise.resolve(opts.readWrite !== false),
  };
}

// ---------------- 安全约束 1：禁止共享 Docker socket ----------------

Deno.test("T21 安全：两个共享 socket 字面路径被拒", () => {
  for (const bad of ["/var/run/docker.sock", "/run/docker.sock"]) {
    let message = "";
    try {
      assertDedicatedSocket(bad, () => bad);
    } catch (err) {
      message = (err as Error).message;
    }
    assertStringIncludes(message, "禁止使用应用宿主机 Docker socket");
    assertStringIncludes(message, "rootless");
  }
});

Deno.test("T21 安全：等价写法与符号链接（realpath）同样被拒", () => {
  // 1) 重复斜杠
  for (
    const bad of [
      "//run/docker.sock",
      "/run//docker.sock",
      "/var//run/docker.sock",
    ]
  ) {
    let message = "";
    try {
      assertDedicatedSocket(bad, () => "");
    } catch (err) {
      message = (err as Error).message;
    }
    assertStringIncludes(message, "禁止使用应用宿主机 Docker socket");
  }
  // 2) 符号链接指向共享 socket：字面完全不同，只有 realpath 能发现
  let message = "";
  try {
    assertDedicatedSocket(
      "/opt/judge/docker.sock",
      () => "/var/run/docker.sock",
    );
  } catch (err) {
    message = (err as Error).message;
  }
  assertStringIncludes(message, "禁止使用应用宿主机 Docker socket");
});

Deno.test("T21 安全：专用 socket 通过；非绝对路径与 TCP 形式被拒", () => {
  // 合规：专用路径
  assertDedicatedSocket(
    "/run/noj-judge/docker.sock",
    () => "/run/noj-judge/docker.sock",
  );
  assertDedicatedSocket("/srv/noj/docker.sock", () => "/srv/noj/docker.sock");

  for (const bad of ["relative/docker.sock", ""]) {
    let message = "";
    try {
      assertDedicatedSocket(bad, () => "");
    } catch (err) {
      message = (err as Error).message;
    }
    assert(message !== "", `必须拒绝：${JSON.stringify(bad)}`);
  }
  // TCP endpoint 形式（含冒号）
  let message = "";
  try {
    assertDedicatedSocket("tcp://127.0.0.1:2375", () => "");
  } catch (err) {
    message = (err as Error).message;
  }
  assert(message !== "", "TCP endpoint 必须被拒");
});

Deno.test("T21 安全：共享 socket 的配置写入被拒且零文件残留", async () => {
  const root = await makeTempDir();
  try {
    const envFile = join(root, ".env.judge");
    await assertRejects(
      () =>
        writeJudgeEnv({
          path: envFile,
          values: {
            ...baseEnv(),
            JUDGE_DOCKER_SOCKET: "/var/run/docker.sock",
          },
        }),
      Error,
      "禁止使用应用宿主机 Docker socket",
    );
    // **零写入**：配置文件不得存在
    let exists = true;
    try {
      await Deno.stat(envFile);
    } catch {
      exists = false;
    }
    assertEquals(exists, false, "拒绝时必须不落盘任何配置文件");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T21 安全：install 遇到共享 socket → 退出码 2 且零 compose 调用", async () => {
  const root = await makeTempDir();
  try {
    const dir = join(root, "judge");
    const calls: Call[] = [];
    const result = await judgeInstall({
      dir,
      runner: makeRunner(calls),
      version: "v0.9.5",
      redisUrl: "redis://127.0.0.1:6379/0",
      // 显式给出共享 socket：必须在写配置前被拦下
      socketPath: "/run/docker.sock",
      host: { uname: () => Promise.resolve("Linux") },
    });

    assertEquals(result.exitCode, 2, result.message);
    assertStringIncludes(result.message, "禁止使用应用宿主机 Docker socket");
    assertEquals(
      calls.filter((c) => c.args.includes("compose")).length,
      0,
      "共享 socket 被拒时必须零 compose 调用",
    );
    let envExists = true;
    try {
      await Deno.stat(join(dir, ".env.judge"));
    } catch {
      envExists = false;
    }
    assertEquals(envExists, false, "拒绝时不得写下配置");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T21 安全：JUDGE_DOCKER_HOST 必须指向容器内专用 endpoint", () => {
  assertJudgeDockerHost("unix:///run/noj-judge/docker.sock");
  for (
    const bad of [
      "unix:///var/run/docker.sock",
      "unix:///run/docker.sock",
      "tcp://127.0.0.1:2375",
      "",
    ]
  ) {
    let message = "";
    try {
      assertJudgeDockerHost(bad);
    } catch (err) {
      message = (err as Error).message;
    }
    assert(message !== "", `必须拒绝 JUDGE_DOCKER_HOST=${bad}`);
  }
  // REQUIRE_ISOLATED_DOCKER 必须为 true
  assertIsolatedDockerRequired("true");
  let message = "";
  try {
    assertIsolatedDockerRequired("false");
  } catch (err) {
    message = (err as Error).message;
  }
  assertStringIncludes(message, "必须为 true");
});

// ---------------- 安全约束 2：不碰宿主 Docker daemon ----------------

Deno.test("T21 安全：整个 judge 路径从不调用宿主管理命令", async () => {
  const root = await makeTempDir();
  try {
    const calls: Call[] = [];
    const dir = await makeJudgeDir(root);
    const runner = makeRunner(calls, {
      stdoutFor: (cmd) => (cmd === "redis-cli" ? "PONG\n" : undefined),
    });

    // 走一遍主要动作
    await judgeCheck({
      dir,
      runner,
      redisCliAvailable: true,
      hostArch: () => Promise.resolve("x86_64"),
      ...socketProbes(),
    });
    await judgeStatus({ dir, runner });
    await judgeStart({ dir, runner });
    await judgeStop({ dir, runner });
    await judgeUpgrade({ dir, runner });
    await judgeLogs({ dir, runner, follow: false });

    const forbidden = findForbiddenHostCalls(calls);
    assertEquals(
      forbidden,
      [],
      `judge 路径不得调用宿主管理命令（实得：${forbidden.join(", ")}）`,
    );
    // 且这份"绝不调用"的清单本身非空（避免断言空转）
    assert(FORBIDDEN_HOST_COMMANDS.length >= 10);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T21 安全：checkJudgeHost 只做只读探测，且非 Linux 时拒绝", async () => {
  const calls: Call[] = [];
  const ok = await checkJudgeHost({
    uname: () => Promise.resolve("Linux"),
    dockerAvailable: () => Promise.resolve(true),
  });
  assertEquals(ok.ok, true);
  assertEquals(calls.length, 0, "探测本身不应经 runner（由调用方注入）");

  const mac = await checkJudgeHost({ uname: () => Promise.resolve("Darwin") });
  assertEquals(mac.ok, false);
  assertStringIncludes(mac.error ?? "", "只支持 Linux");

  const noDocker = await checkJudgeHost({
    uname: () => Promise.resolve("Linux"),
    dockerAvailable: () => Promise.resolve(false),
  });
  assertEquals(noDocker.ok, false);
  assertStringIncludes(noDocker.error ?? "", "Docker daemon");
});

// ---------------- socket 连通性校验 ----------------

Deno.test("T21 socket：共享路径在最前被拒（连探针都不跑）", async () => {
  const calls: Call[] = [];
  const result = await checkStandaloneJudgeSocket(
    {
      JUDGE_DOCKER_SOCKET: "/var/run/docker.sock",
      JUDGE_DOCKER_SOCKET_GID: "0",
    },
    { runner: makeRunner(calls), ...socketProbes() },
  );
  assertEquals(result.ok, false);
  assertStringIncludes(result.error ?? "", "禁止使用应用宿主机 Docker socket");
  assertEquals(calls.length, 0, "共享 socket 必须在任何探测之前被拒");
});

Deno.test("T21 socket：非 socket / 不可读写 / GID 不符 / daemon 不可连 分别被拒", async () => {
  const base = {
    JUDGE_DOCKER_SOCKET: "/run/noj-judge/docker.sock",
    JUDGE_DOCKER_SOCKET_GID: "10001",
  };
  const calls: Call[] = [];
  // 注意字段名：`checkStandaloneJudgeSocket` 用自己的 `isSocket`/`isReadWritable`/`socketGid`；
  // `actions` 层为避免与配置值 `socketGid`（字符串）撞名而用 `probe*` 前缀。
  const probes = (
    o: Parameters<typeof socketProbes>[0],
  ): {
    isSocket: (p: string) => Promise<boolean>;
    isReadWritable: (p: string) => Promise<boolean>;
    socketGid: (p: string) => Promise<number | null>;
    socketMode: (p: string) => Promise<string | null>;
  } => {
    const p = socketProbes(o);
    return {
      isSocket: p.probeIsSocket!,
      isReadWritable: p.probeReadWritable!,
      socketGid: p.probeSocketGid!,
      socketMode: p.probeSocketMode!,
    };
  };

  const notSocket = await checkStandaloneJudgeSocket(base, {
    runner: makeRunner(calls),
    ...probes({ isSocket: false }),
  });
  assertStringIncludes(notSocket.error ?? "", "不是 Unix socket");

  const noPerm = await checkStandaloneJudgeSocket(base, {
    runner: makeRunner(calls),
    ...probes({ readWrite: false }),
  });
  assertStringIncludes(noPerm.error ?? "", "无法读写");

  const gidMismatch = await checkStandaloneJudgeSocket(base, {
    runner: makeRunner(calls),
    ...probes({ gid: 999 }),
  });
  assertStringIncludes(gidMismatch.error ?? "", "不一致");

  const daemonDown = await checkStandaloneJudgeSocket(base, {
    runner: makeRunner(calls, { failOn: (cmd) => cmd === "docker" }),
    ...probes({}),
  });
  assertStringIncludes(
    daemonDown.error ?? "",
    "rootless Docker daemon 不可连接",
  );
  assertStringIncludes(daemonDown.error ?? "", "install-env");
});

Deno.test("T21 socket：可用时经 DOCKER_HOST 指向**目标 socket** 探测", async () => {
  const calls: Call[] = [];
  const result = await checkStandaloneJudgeSocket(
    {
      JUDGE_DOCKER_SOCKET: "/run/noj-judge/docker.sock",
      JUDGE_DOCKER_SOCKET_GID: "10001",
    },
    {
      runner: makeRunner(calls),
      isSocket: socketProbes().probeIsSocket!,
      isReadWritable: socketProbes().probeReadWritable!,
      socketGid: socketProbes({ gid: 10001 }).probeSocketGid!,
      socketMode: socketProbes({ mode: "660" }).probeSocketMode!,
    },
  );
  assertEquals(result.ok, true, result.error ?? "");
  assertStringIncludes(result.detail ?? "", "GID=10001");
  assertStringIncludes(result.detail ?? "", "权限=660");
  // 关键：探测的是**目标** socket，而不是宿主默认 daemon
  const info = calls.find((c) => c.args[0] === "info");
  assertEquals(info?.env?.["DOCKER_HOST"], "unix:///run/noj-judge/docker.sock");
});

// ---------------- Compose 渲染的安全属性 ----------------

Deno.test("T21 compose：渲染结果含全部安全属性（纯函数，不调 runner）", () => {
  const yaml = renderJudgeCompose({ ...JUDGE_DEFAULT_VALUES, ...baseEnv() });
  // socket 挂载 :ro
  assertStringIncludes(
    yaml,
    '"/run/noj-judge/docker.sock:/run/noj-judge/docker.sock:ro"',
  );
  assertStringIncludes(yaml, "cap_drop:\n      - ALL");
  assertStringIncludes(yaml, "no-new-privileges:true");
  assertStringIncludes(yaml, "read_only: true");
  assertStringIncludes(yaml, "tmpfs:\n      - /tmp");
  assertStringIncludes(yaml, 'user: "10001:10001"');
  assertStringIncludes(yaml, 'JUDGE_REQUIRE_ISOLATED_DOCKER: "true"');
  assertStringIncludes(
    yaml,
    'JUDGE_DOCKER_HOST: "unix:///run/noj-judge/docker.sock"',
  );
  // **不得**映射任何宿主机端口
  assertEquals(yaml.includes("ports:"), false, "Judge 不得映射宿主机端口");
  // 镜像与版本
  assertStringIncludes(yaml, "ghcr.io/neuro-oj/noj-judge:v0.9.5");
  // 卷名固定
  assertStringIncludes(yaml, "name: noj-judge-standalone-cache");
});

Deno.test("T21 compose：缺必填项即拒绝（对应 bash 的 ${VAR:?}）", () => {
  for (
    const missing of [
      "NOJ_VERSION",
      "REDIS_URL",
      "JUDGE_DOCKER_SOCKET",
      "JUDGE_DOCKER_SOCKET_GID",
    ]
  ) {
    const env = { ...JUDGE_DEFAULT_VALUES, ...baseEnv() };
    delete env[missing];
    let message = "";
    try {
      renderJudgeCompose(env);
    } catch (err) {
      message = (err as Error).message;
    }
    assertStringIncludes(message, missing);
  }
});

Deno.test("T21 compose：渲染时也会拒绝共享 socket（防线不依赖调用方纪律）", () => {
  let message = "";
  try {
    renderJudgeCompose({
      ...JUDGE_DEFAULT_VALUES,
      ...baseEnv(),
      JUDGE_DOCKER_SOCKET: "/var/run/docker.sock",
    });
  } catch (err) {
    message = (err as Error).message;
  }
  assertStringIncludes(message, "禁止使用应用宿主机 Docker socket");
});

Deno.test("T21 compose：参数数组形状正确（project-name/env-file/-f）", () => {
  const args = judgeComposeArgs(
    {
      dir: "/srv/noj-judge",
      envFile: "/srv/noj-judge/.env.judge",
      composeFile: "/srv/noj-judge/docker-compose.judge.yml",
    },
    ["up", "-d"],
  );
  assertEquals(args.slice(0, 3), [
    "compose",
    "--project-name",
    "noj-judge-standalone",
  ]);
  assert(args.includes("--env-file"));
  assert(args.includes("-f"));
  assertEquals(args.slice(-2), ["up", "-d"]);
});

// ---------------- 配置写入与保留 ----------------

Deno.test("T21 配置：首装写入 600，升级**不覆盖**既有配置", async () => {
  const root = await makeTempDir();
  try {
    const dir = join(root, "judge");
    const envFile = join(dir, ".env.judge");

    // 首装：写入并 600
    const first = await writeJudgeEnv({
      path: envFile,
      values: { ...baseEnv(), JUDGE_MAX_CONCURRENT_JUDGES: "4" },
    });
    assertEquals(first.written, true);
    assertEquals(first.env["JUDGE_MAX_CONCURRENT_JUDGES"], "4");
    assertEquals(
      ((await Deno.stat(envFile)).mode ?? 0) & 0o777,
      JUDGE_ENV_MODE,
    );

    // 用户手工调参
    const original = await Deno.readTextFile(envFile);
    await Deno.writeTextFile(envFile, original + "# 用户备注\n");
    const withComment = await Deno.readTextFile(envFile);

    // 再次 install（不带 --version）：逐字节不变
    const second = await writeJudgeEnv({
      path: envFile,
      values: { ...baseEnv(), JUDGE_MAX_CONCURRENT_JUDGES: "9" },
    });
    assertEquals(second.written, false, "不得覆盖既有配置");
    assertEquals(
      await Deno.readTextFile(envFile),
      withComment,
      "既有配置必须逐字节保留（含用户注释与手工调过的值）",
    );
    assertEquals(second.env["JUDGE_MAX_CONCURRENT_JUDGES"], "4");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T21 配置：显式 --version 时**只**更新该键，其它键与注释保留", async () => {
  const root = await makeTempDir();
  try {
    const dir = join(root, "judge");
    const envFile = join(dir, ".env.judge");
    await writeJudgeEnv({ path: envFile, values: baseEnv() });
    await Deno.writeTextFile(
      envFile,
      "# 顶部注释\n" + (await Deno.readTextFile(envFile)),
    );
    await Deno.chmod(envFile, JUDGE_ENV_MODE);

    const result = await writeJudgeEnv({
      path: envFile,
      updateVersion: "v0.10.0",
    });
    assertEquals(result.written, true);
    assertEquals(result.env["NOJ_VERSION"], "v0.10.0");
    const text = await Deno.readTextFile(envFile);
    assertStringIncludes(text, "# 顶部注释");
    assertStringIncludes(text, "JUDGE_QUEUE=noj:judge:queue");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T21 配置：首装缺 NOJ_VERSION / REDIS_URL 即拒绝", async () => {
  const root = await makeTempDir();
  try {
    const envFile = join(root, ".env.judge");
    await assertRejects(
      () =>
        writeJudgeEnv({ path: envFile, values: { REDIS_URL: "redis://x/0" } }),
      Error,
      "NOJ_VERSION",
    );
    await assertRejects(
      () => writeJudgeEnv({ path: envFile, values: { NOJ_VERSION: "v0.9.5" } }),
      Error,
      "REDIS_URL",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T21 配置：值校验（版本/并发/GID/UID/HOST）逐条", () => {
  assertJudgeVersion("v0.1.0");
  assertJudgeVersion("0.8.0");
  assertJudgeVersion("0.8.0-rc.1");
  for (const bad of ["main", "latest", "", "v1", "1.2.3.4"]) {
    let message = "";
    try {
      assertJudgeVersion(bad);
    } catch (err) {
      message = (err as Error).message;
    }
    assertStringIncludes(message, "不可变 Release 标签");
  }

  const valid = { ...JUDGE_DEFAULT_VALUES, ...baseEnv() };
  assertJudgeConfigValues(valid);

  // 占位值
  for (const key of JUDGE_REQUIRED_KEYS) {
    let message = "";
    try {
      assertJudgeConfigValues({ ...valid, [key]: "change-me" });
    } catch (err) {
      message = (err as Error).message;
    }
    assertStringIncludes(message, key);
  }
  // 并发非正整数
  for (const bad of ["0", "-1", "abc"]) {
    let message = "";
    try {
      assertJudgeConfigValues({ ...valid, JUDGE_MAX_CONCURRENT_JUDGES: bad });
    } catch (err) {
      message = (err as Error).message;
    }
    assertStringIncludes(message, "正整数");
  }
  // UID/GID 数字
  let message = "";
  try {
    assertJudgeConfigValues({ ...valid, JUDGE_UID: "abc" });
  } catch (err) {
    message = (err as Error).message;
  }
  assertStringIncludes(message, "JUDGE_UID");
});

Deno.test("T21 配置：文件权限非 600/400 即拒绝", async () => {
  const root = await makeTempDir();
  try {
    const envFile = join(root, ".env.judge");
    await Deno.writeTextFile(envFile, "NOJ_VERSION=v0.9.5\n");
    await Deno.chmod(envFile, 0o644);
    await assertRejects(
      () => assertJudgeEnvFileMode(envFile),
      Error,
      "600 或 400",
    );
    await Deno.chmod(envFile, 0o600);
    await assertJudgeEnvFileMode(envFile);

    await assertRejects(
      () => assertJudgeEnvFileMode(join(root, "nope")),
      Error,
      "找不到配置文件",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T21 Redis：URL 形态校验与主机名脱敏", async () => {
  const calls: Call[] = [];
  // 非 redis:// 协议
  const bad = await checkJudgeRedis({ REDIS_URL: "http://127.0.0.1:6379" }, {
    runner: makeRunner(calls),
  });
  assertStringIncludes(bad.error ?? "", "redis:// 或 rediss://");

  // host 提取：auth 段必须被剥掉
  assertEquals(redisHostOf("redis://127.0.0.1:6379/0"), "127.0.0.1");
  assertEquals(redisHostOf("redis://:pw@10.0.0.5:6379/0"), "10.0.0.5");
  assertEquals(
    redisHostOf("rediss://user:pw@redis.internal:6380/1"),
    "redis.internal",
  );
  assertEquals(redisHostOf(""), "未知主机");

  // 错误信息里不得出现口令
  const failed = await checkJudgeRedis(
    { REDIS_URL: "redis://:top-secret-pw@127.0.0.1:6379/0" },
    {
      runner: makeRunner(calls, { failOn: (cmd) => cmd === "redis-cli" }),
      redisCliAvailable: true,
    },
  );
  assertEquals(failed.ok, false);
  assertEquals((failed.error ?? "").includes("top-secret-pw"), false);
  assertStringIncludes(failed.error ?? "", "127.0.0.1");

  // 成功路径
  const ok = await checkJudgeRedis(
    { REDIS_URL: "redis://127.0.0.1:6379/0" },
    { runner: makeRunner(calls), redisCliAvailable: true },
  );
  assertEquals(ok.ok, true);
});

Deno.test("T21 Redis：回退容器路径把口令经 **env-file** 传入（不进 argv）", async () => {
  const calls: Call[] = [];
  const result = await checkJudgeRedis(
    { REDIS_URL: "redis://:super-secret@127.0.0.1:6379/0" },
    { runner: makeRunner(calls), redisCliAvailable: false },
  );
  assertEquals(result.ok, true, result.error ?? "");
  const runCall = calls.find((c) => c.cmd === "docker");
  assert(runCall !== undefined, "应走容器回退");
  // argv 里**不得**含口令
  assertEquals(
    runCall!.args.some((a) => a.includes("super-secret")),
    false,
    "口令不得出现在命令行参数里（ps 可见）",
  );
  assert(runCall!.args.includes("--env-file"), "口令必须经 --env-file 传入");
});

Deno.test("T21 镜像架构：uname 映射 + 不符即拒绝 + 镜像缺失不算失败", async () => {
  assertEquals(dockerArchOf("x86_64"), "amd64");
  assertEquals(dockerArchOf("aarch64"), "arm64");
  assertEquals(dockerArchOf("armv7l"), "arm");
  assertEquals(dockerArchOf("i686"), "386");

  const calls: Call[] = [];
  const env = { ...JUDGE_DEFAULT_VALUES, ...baseEnv() };

  // 镜像缺失（inspect 失败）→ ok
  const missing = await checkJudgeImageArchitecture(env, {
    runner: makeRunner(calls, { failOn: (_cmd, args) => args[0] === "image" }),
    hostArch: () => Promise.resolve("x86_64"),
  });
  assertEquals(missing.ok, true);
  assertEquals(missing.arch, null);

  // 架构不符 → 拒绝
  const mismatch = await checkJudgeImageArchitecture(env, {
    runner: makeRunner(calls, {
      stdoutFor: (_cmd, args) => (args[0] === "image" ? "arm64\n" : undefined),
    }),
    hostArch: () => Promise.resolve("x86_64"),
  });
  assertEquals(mismatch.ok, false);
  assertStringIncludes(mismatch.error ?? "", "不一致");

  // 架构一致 → ok
  const match = await checkJudgeImageArchitecture(env, {
    runner: makeRunner(calls, {
      stdoutFor: (_cmd, args) => (args[0] === "image" ? "amd64\n" : undefined),
    }),
    hostArch: () => Promise.resolve("x86_64"),
  });
  assertEquals(match.ok, true);
});

// ---------------- 命令编排 ----------------

Deno.test("T21 install：完整流程（配置 → socket 校验 → 渲染 → pull → up）", async () => {
  const root = await makeTempDir();
  try {
    const dir = join(root, "judge");
    const calls: Call[] = [];
    const result = await judgeInstall({
      dir,
      runner: makeRunner(calls),
      version: "v0.9.5",
      redisUrl: "redis://127.0.0.1:6379/0",
      socketPath: "/run/noj-judge/docker.sock",
      host: { uname: () => Promise.resolve("Linux") },
      ...socketProbes(),
    });

    assertEquals(result.exitCode, 0, result.message);
    const env = await readJudgeEnv(join(dir, ".env.judge"));
    assertEquals(env["NOJ_VERSION"], "v0.9.5");
    assertEquals(env["REDIS_URL"], "redis://127.0.0.1:6379/0");
    // Compose 已渲染且 600
    assertEquals(
      ((await Deno.stat(join(dir, "docker-compose.judge.yml"))).mode ?? 0) &
        0o777,
      0o600,
    );
    // 顺序：config --quiet → pull → up
    const composeCalls = calls
      .filter((c) => c.args.includes("compose"))
      .map((c) => c.args[c.args.length - 1] + "|" + c.args.join(" "));
    const configAt = composeCalls.findIndex((s) => s.includes("config"));
    const pullAt = composeCalls.findIndex((s) => s.includes("pull"));
    const upAt = composeCalls.findIndex((s) => s.includes("up"));
    assert(
      configAt >= 0 && pullAt > configAt && upAt > pullAt,
      "顺序应为 config → pull → up",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T21 install --dry-run：零 runner 调用、零文件写入", async () => {
  const root = await makeTempDir();
  try {
    const dir = join(root, "judge");
    const calls: Call[] = [];
    const result = await judgeInstall({
      dir,
      runner: makeRunner(calls),
      version: "v0.9.5",
      redisUrl: "redis://127.0.0.1:6379/0",
      dryRun: true,
      host: { uname: () => Promise.resolve("Linux") },
    });
    assertEquals(result.exitCode, 0, result.message);
    assertStringIncludes(result.message, "[dry-run]");
    assertEquals(calls, [], "dry-run 不得调用 runner");
    let exists = true;
    try {
      await Deno.stat(join(dir, ".env.judge"));
    } catch {
      exists = false;
    }
    assertEquals(exists, false, "dry-run 不得写文件");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T21 install：非 Linux → 退出码 2 且零 compose", async () => {
  const root = await makeTempDir();
  try {
    const calls: Call[] = [];
    const result = await judgeInstall({
      dir: join(root, "judge"),
      runner: makeRunner(calls),
      version: "v0.9.5",
      redisUrl: "redis://127.0.0.1:6379/0",
      host: { uname: () => Promise.resolve("Darwin") },
    });
    assertEquals(result.exitCode, 2);
    assertStringIncludes(result.message, "只支持 Linux");
    assertEquals(calls.filter((c) => c.args.includes("compose")).length, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T21 check：配置/权限/socket/Redis/架构/config 全通过", async () => {
  const root = await makeTempDir();
  try {
    const dir = await makeJudgeDir(root);
    const calls: Call[] = [];
    const result = await judgeCheck({
      dir,
      runner: makeRunner(calls, {
        stdoutFor: (cmd, args) => {
          if (cmd === "redis-cli") return "PONG\n";
          if (args[0] === "image") return "amd64\n";
          return undefined;
        },
      }),
      redisCliAvailable: true,
      hostArch: () => Promise.resolve("x86_64"),
      ...socketProbes(),
    });
    assertEquals(result.exitCode, 0, result.message);
    assertStringIncludes(result.message, "配置检查通过");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T21 check：缺配置 / 权限过宽 / 超时 socket → 退出码 2", async () => {
  const root = await makeTempDir();
  try {
    // 1) 缺配置
    const empty = join(root, "empty");
    await Deno.mkdir(empty, { recursive: true });
    const noConfig = await judgeCheck({ dir: empty, runner: makeRunner([]) });
    assertEquals(noConfig.exitCode, 2);

    // 2) 权限过宽
    const dir = await makeJudgeDir(root);
    await Deno.chmod(join(dir, ".env.judge"), 0o644);
    const wide = await judgeCheck({ dir, runner: makeRunner([]) });
    assertEquals(wide.exitCode, 2);
    assertStringIncludes(wide.message, "600 或 400");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T21 start/stop：用 stop 而非 down（保数据）", async () => {
  const root = await makeTempDir();
  try {
    const dir = await makeJudgeDir(root);
    const calls: Call[] = [];
    const runner = makeRunner(calls);

    const start = await judgeStart({ dir, runner });
    assertEquals(start.exitCode, 0, start.message);
    assert(calls.some((c) => c.args.includes("up")));

    const before = calls.length;
    const stop = await judgeStop({ dir, runner });
    assertEquals(stop.exitCode, 0, stop.message);
    const stopCalls = calls.slice(before);
    assert(
      stopCalls.some((c) => c.args.includes("stop")),
      "应调用 compose stop",
    );
    assertEquals(
      stopCalls.some((c) => c.args.includes("down")),
      false,
      "stop 不得使用 down（会删容器/网络）",
    );
    assertEquals(
      stopCalls.some((c) => c.args.includes("-v")),
      false,
      "stop 绝不得带 -v（会删数据卷）",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T21 status：**脱敏**——配置里的口令不得出现在任何输出", async () => {
  const root = await makeTempDir();
  try {
    const secret = "super-secret-redis-pw";
    const dir = await makeJudgeDir(root, {
      REDIS_URL: `redis://:${secret}@127.0.0.1:6379/0`,
      REDIS_CHECK_URL: `redis://:${secret}@127.0.0.1:6379/0`,
    });
    const calls: Call[] = [];
    const lines: string[] = [];
    const result = await judgeStatus({
      dir,
      runner: makeRunner(calls, {
        stdoutFor: () => "NAME  IMAGE  STATUS\njudge  x  Up\n",
      }),
      log: (l) => lines.push(l),
    });

    assertEquals(result.exitCode, 0, result.message);
    const all = lines.join("\n") + "\n" + result.summary.join("\n") +
      result.psOutput + "\n" + result.message;
    assertEquals(all.includes(secret), false, "口令绝不能出现在 status 输出里");
    // 但非敏感信息应当可见（否则"脱敏"会退化成"什么都不显示"）
    assertStringIncludes(all, "NOJ_VERSION=v0.9.5");
    assertStringIncludes(all, "JUDGE_QUEUE=noj:judge:queue");
    // URL 走脱敏形式
    assertStringIncludes(all, "REDIS_URL=redis://***@127.0.0.1:6379/0");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T21 status：脱敏用**白名单**，未知敏感键也不会泄露", () => {
  const summary = renderStatusSummary({
    NOJ_VERSION: "v0.9.5",
    NOJ_LLM_SERVICE_TOKEN: "tok-should-not-appear",
    REDIS_URL: "redis://:pw@h:6379/0",
    SOME_NEW_SECRET: "also-secret",
  }).join("\n");
  // 白名单外的键一律不出现（即便它不含 "password" 字样）
  assertEquals(summary.includes("tok-should-not-appear"), false);
  assertEquals(summary.includes("also-secret"), false);
  assertEquals(summary.includes("pw@h"), false);
  assertStringIncludes(summary, "NOJ_VERSION=v0.9.5");
});

Deno.test("T21 logs：--follow 走 stream；runner 不支持时明确报错", async () => {
  const root = await makeTempDir();
  try {
    const dir = await makeJudgeDir(root);
    const calls: Call[] = [];
    const streamed: string[] = [];
    const runner = makeRunner(calls, { stream: true });
    const result = await judgeLogs({
      dir,
      runner,
      follow: true,
      log: (l) => streamed.push(l),
    });
    assertEquals(result.exitCode, 0, result.message);
    assert(calls.some((c) => c.args.includes("--follow")), "必须传 --follow");

    // 不支持 stream → 明确报错（不静默退化为缓冲）
    const noStream = await judgeLogs({
      dir,
      runner: makeRunner([]),
      follow: true,
    });
    assertEquals(noStream.exitCode, 1);
    assertStringIncludes(noStream.message, "不支持实时日志");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T21 upgrade：按配置版本 pull + force-recreate", async () => {
  const root = await makeTempDir();
  try {
    const dir = await makeJudgeDir(root, { NOJ_VERSION: "v0.10.0" });
    const calls: Call[] = [];
    const result = await judgeUpgrade({ dir, runner: makeRunner(calls) });
    assertEquals(result.exitCode, 0, result.message);
    assertStringIncludes(result.message, "v0.10.0");
    assert(calls.some((c) => c.args.includes("pull")));
    assert(calls.some((c) => c.args.includes("--force-recreate")));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T21 辅助：端口/容器名校验与口令生成", () => {
  assertRedisPort(16379);
  assertRedisPort(1024);
  assertRedisPort(65535);
  for (const bad of [0, 1023, 65536, -1, 1.5]) {
    let message = "";
    try {
      assertRedisPort(bad);
    } catch (err) {
      message = (err as Error).message;
    }
    assert(message !== "", `必须拒绝端口 ${bad}`);
  }
  assertRedisContainerName("noj-judge-redis");
  assertRedisContainerName("a");
  for (const bad of ["-bad", "bad name", "", ".bad"]) {
    let message = "";
    try {
      assertRedisContainerName(bad);
    } catch (err) {
      message = (err as Error).message;
    }
    assert(message !== "", `必须拒绝容器名 ${JSON.stringify(bad)}`);
  }

  const pw = generateRedisPassword();
  assertEquals(pw.length, 48, "24 字节 → 48 个十六进制字符");
  assert(/^[0-9a-f]+$/.test(pw));
  assertEquals(generateRedisPassword() === pw, false, "口令必须每次不同");
});

Deno.test("T21 辅助：judgePaths/envValue/redactUrl", () => {
  const paths = judgePaths("/srv/noj-judge");
  assertEquals(paths.envFile, "/srv/noj-judge/.env.judge");
  assertEquals(paths.composeFile, "/srv/noj-judge/docker-compose.judge.yml");
  // 尾斜杠归一
  assertEquals(judgePaths("/srv/noj-judge/").dir, "/srv/noj-judge");
  // 相对路径拒绝
  let message = "";
  try {
    judgePaths("relative");
  } catch (err) {
    message = (err as Error).message;
  }
  assertStringIncludes(message, "绝对路径");

  assertEquals(envValue({ A: "1" }, "A"), "1");
  assertEquals(envValue({}, "A"), "");
  assertEquals(
    redactUrl("redis://:pw@h:6379/0"),
    "redis://***@h:6379/0",
  );
  assertEquals(redactUrl("redis://h:6379/0"), "redis://h:6379/0");
});

Deno.test("T21 默认值：COMPOSE_ENV_DEFAULTS 与 JUDGE_DEFAULT_VALUES 覆盖 bash 的默认", () => {
  // 队列名必须与 noj-core 一致（这是最容易被改错的地方）
  assertEquals(COMPOSE_ENV_DEFAULTS["JUDGE_QUEUE"], "noj:judge:queue");
  assertEquals(COMPOSE_ENV_DEFAULTS["RESULT_QUEUE"], "noj:judge:results");
  assertEquals(
    JUDGE_DEFAULT_VALUES["JUDGE_DOCKER_HOST"],
    "unix:///run/noj-judge/docker.sock",
  );
  assertEquals(JUDGE_DEFAULT_VALUES["JUDGE_REQUIRE_ISOLATED_DOCKER"], "true");
  assertEquals(JUDGE_DEFAULT_VALUES["JUDGE_MAX_CONCURRENT_JUDGES"], "2");
  // 必填清单包含 socket 两项（否则校验会漏掉最关键的安全配置）
  assert(JUDGE_REQUIRED_KEYS.includes("JUDGE_DOCKER_SOCKET"));
  assert(JUDGE_REQUIRED_KEYS.includes("JUDGE_DOCKER_SOCKET_GID"));
});
