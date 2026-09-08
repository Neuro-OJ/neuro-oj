import { assertEquals } from "@std/assert";
import type { CmdResult, CommandRunner } from "../runtime/command.ts";
import { writeJudgeCompose } from "./compose.ts";
import { runJudgeCommand } from "./commands.ts";
import { envValue, loadJudgeEnv, saveJudgeEnv } from "./env.ts";
import type { JudgeOptions } from "./options.ts";

/** 可记录调用并返回成功结果的 fake runner。 */
function fakeRunner(
  records: { cmd: string; args: string[] }[],
  handler?: (cmd: string, args: string[]) => CmdResult,
): CommandRunner {
  return {
    run(cmd, args) {
      records.push({ cmd, args });
      if (handler) return Promise.resolve(handler(cmd, args));
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    spawn() {
      throw new Error("not used");
    },
  };
}

function fakeRunnerWithConfiguredChecks(
  dir: string,
  records: { cmd: string; args: string[] }[],
): CommandRunner {
  return fakeRunner(records, (cmd, args) => {
    if (cmd === "uname" && args[0] === "-s") {
      return { code: 0, stdout: "Linux\n", stderr: "" };
    }
    if (cmd === "uname" && args[0] === "-m") {
      return { code: 0, stdout: "x86_64\n", stderr: "" };
    }
    if (cmd === "df" && args[0] === "-Pk" && args[1] === dir) {
      return {
        code: 0,
        stdout:
          `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/x 1 1 999999999 1% ${dir}\n`,
        stderr: "",
      };
    }
    if (cmd === "docker" && args[0] === "image" && args[1] === "inspect") {
      return { code: 0, stdout: "amd64\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
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
  dryRun: true,
  follow: false,
};

const completeValues: Record<string, string> = {
  NOJ_VERSION: "v0.1.0",
  REDIS_URL: "redis://127.0.0.1:6379/0",
  REDIS_CHECK_URL: "redis://127.0.0.1:6379/0",
  REDIS_SOURCE: "existing",
  JUDGE_QUEUE: "noj:judge:queue",
  RESULT_QUEUE: "noj:judge:results",
  WORK_DIR: "/tmp/noj-judge",
  JUDGE_MAX_CONCURRENT_JUDGES: "2",
  JUDGE_IMAGE_PREFIX: "noj-",
  JUDGE_IMAGE_REGISTRY: "ghcr.io/neuro-oj",
  JUDGE_DOCKER_SOCKET: "",
  JUDGE_DOCKER_SOCKET_GID: "",
  JUDGE_UID: "10001",
  JUDGE_GID: "10001",
  JUDGE_DOCKER_HOST: "unix:///run/noj-judge/docker.sock",
  JUDGE_REQUIRE_ISOLATED_DOCKER: "true",
};

/** 创建带完整配置、Compose 文件和 Unix socket 的选项。 */
function configuredOpts(
  command: JudgeOptions["command"],
  overrides: Partial<JudgeOptions> = {},
): { opts: JudgeOptions; cleanup: () => void } {
  const dir = Deno.makeTempDirSync();
  const envFile = `${dir}/.env.judge`;
  const composeFile = `${dir}/docker-compose.judge.yml`;
  const socketPath = `${dir}/docker.sock`;
  let listener: Deno.Listener;
  try {
    listener = Deno.listen({ path: socketPath, transport: "unix" });
    const stat = Deno.statSync(socketPath);
    const gid = stat.gid?.toString() ?? "";
    saveJudgeEnv(envFile, {
      ...completeValues,
      JUDGE_DOCKER_SOCKET: socketPath,
      JUDGE_DOCKER_SOCKET_GID: gid,
    });
    writeJudgeCompose(composeFile, false);
  } catch (e) {
    throw e;
  }
  return {
    opts: {
      ...baseOpts,
      ...overrides,
      command,
      dir,
      envFile,
      composeFile,
      dryRun: false,
    },
    cleanup() {
      try {
        listener.close();
      } catch {
        // 忽略已关闭
      }
    },
  };
}

Deno.test("judge check dry-run 返回 0", async () => {
  const records: { cmd: string; args: string[] }[] = [];
  const code = await runJudgeCommand(
    { ...baseOpts, dryRun: true },
    fakeRunner(records),
  );
  assertEquals(code, 0);
});

Deno.test("judge check 完整配置通过返回 0", async () => {
  const { opts, cleanup } = configuredOpts("check");
  try {
    const records: { cmd: string; args: string[] }[] = [];
    const code = await runJudgeCommand(
      opts,
      fakeRunnerWithConfiguredChecks(opts.dir, records),
    );
    assertEquals(code, 0);
    assertEquals(
      records.some((r) =>
        r.cmd === "docker" && r.args[0] === "compose" &&
        r.args.includes("config") && r.args.includes("--quiet")
      ),
      true,
    );
  } finally {
    cleanup();
  }
});

Deno.test("judge install 按序执行 pull 与 up", async () => {
  const { opts, cleanup } = configuredOpts("install", { version: "v0.1.0" });
  try {
    const records: { cmd: string; args: string[] }[] = [];
    const code = await runJudgeCommand(
      opts,
      fakeRunnerWithConfiguredChecks(opts.dir, records),
    );
    assertEquals(code, 0);
    const composeCalls = records.filter((r) =>
      r.cmd === "docker" && r.args[0] === "compose"
    ).map((r) => r.args);
    const pullIdx = composeCalls.findIndex((a) => a.includes("pull"));
    const upIdx = composeCalls.findIndex((a) =>
      a.includes("up") && a.includes("-d") && a.includes("--remove-orphans")
    );
    assertEquals(pullIdx >= 0, true);
    assertEquals(upIdx >= 0, true);
    assertEquals(pullIdx < upIdx, true);
  } finally {
    cleanup();
  }
});

Deno.test("judge install-env 返回 0", async () => {
  const records: { cmd: string; args: string[] }[] = [];
  const code = await runJudgeCommand(
    { ...baseOpts, command: "install-env", dryRun: false },
    fakeRunnerWithConfiguredChecks(baseOpts.dir, records),
  );
  assertEquals(code, 0);
});

Deno.test("judge start 执行 compose up", async () => {
  const { opts, cleanup } = configuredOpts("start");
  try {
    const records: { cmd: string; args: string[] }[] = [];
    const code = await runJudgeCommand(
      opts,
      fakeRunnerWithConfiguredChecks(opts.dir, records),
    );
    assertEquals(code, 0);
    assertEquals(
      records.some((r) =>
        r.cmd === "docker" && r.args[0] === "compose" &&
        r.args.includes("up") && r.args.includes("-d") &&
        r.args.includes("--remove-orphans")
      ),
      true,
    );
  } finally {
    cleanup();
  }
});

Deno.test("judge stop 执行 compose stop", async () => {
  const records: { cmd: string; args: string[] }[] = [];
  const code = await runJudgeCommand(
    { ...baseOpts, command: "stop", dryRun: false },
    fakeRunner(records),
  );
  assertEquals(code, 0);
  assertEquals(
    records.some((r) =>
      r.cmd === "docker" && r.args[0] === "compose" && r.args.includes("stop")
    ),
    true,
  );
});

Deno.test("judge status 输出摘要并执行 compose ps", async () => {
  const { opts, cleanup } = configuredOpts("status");
  try {
    const records: { cmd: string; args: string[] }[] = [];
    const code = await runJudgeCommand(
      opts,
      fakeRunnerWithConfiguredChecks(opts.dir, records),
    );
    assertEquals(code, 0);
    assertEquals(
      records.some((r) =>
        r.cmd === "docker" && r.args[0] === "compose" && r.args.includes("ps")
      ),
      true,
    );
  } finally {
    cleanup();
  }
});

Deno.test("judge logs 执行 logs --tail=200", async () => {
  const records: { cmd: string; args: string[] }[] = [];
  const code = await runJudgeCommand(
    { ...baseOpts, command: "logs", dryRun: false },
    fakeRunner(records),
  );
  assertEquals(code, 0);
  assertEquals(
    records.some((r) =>
      r.cmd === "docker" && r.args[0] === "compose" &&
      r.args.includes("logs") && r.args.includes("--tail=200")
    ),
    true,
  );
});

Deno.test("judge logs --follow 追加 --follow", async () => {
  const records: { cmd: string; args: string[] }[] = [];
  const code = await runJudgeCommand(
    { ...baseOpts, command: "logs", dryRun: false, follow: true },
    fakeRunner(records),
  );
  assertEquals(code, 0);
  assertEquals(
    records.some((r) =>
      r.cmd === "docker" && r.args[0] === "compose" &&
      r.args.includes("logs") && r.args.includes("--tail=200") &&
      r.args.includes("--follow")
    ),
    true,
  );
});

Deno.test("judge upgrade 更新 NOJ_VERSION 并执行 pull/up", async () => {
  const { opts, cleanup } = configuredOpts("upgrade", {
    version: "v0.2.0",
  });
  try {
    const records: { cmd: string; args: string[] }[] = [];
    const code = await runJudgeCommand(
      opts,
      fakeRunnerWithConfiguredChecks(opts.dir, records),
    );
    assertEquals(code, 0);
    const env = loadJudgeEnv(opts.envFile);
    assertEquals(envValue(env, "NOJ_VERSION"), "v0.2.0");
    const composeCalls = records.filter((r) =>
      r.cmd === "docker" && r.args[0] === "compose"
    ).map((r) => r.args);
    assertEquals(composeCalls.some((a) => a.includes("pull")), true);
    assertEquals(
      composeCalls.some((a) =>
        a.includes("up") && a.includes("-d") && a.includes("--remove-orphans")
      ),
      true,
    );
  } finally {
    cleanup();
  }
});

Deno.test("judge download 下载脚本到目标目录", async () => {
  const dir = Deno.makeTempDirSync();
  const records: { cmd: string; args: string[] }[] = [];
  const opts: JudgeOptions = {
    ...baseOpts,
    command: "download",
    dir,
    envFile: `${dir}/.env.judge`,
    composeFile: `${dir}/docker-compose.judge.yml`,
    dryRun: false,
  };
  const code = await runJudgeCommand(
    opts,
    fakeRunner(records, (cmd, args) => {
      if (cmd === "curl") {
        const outIdx = args.indexOf("-o");
        const out = outIdx >= 0 ? args[outIdx + 1] : undefined;
        if (out) Deno.writeTextFileSync(out, "#!/usr/bin/env bash\n");
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    }),
  );
  assertEquals(code, 0);
  const script = `${dir}/judge-install.sh`;
  const stat = Deno.statSync(script);
  assertEquals(stat.isFile, true);
  assertEquals(stat.mode! & 0o777, 0o700);
  assertEquals(records.some((r) => r.cmd === "curl"), true);
});

Deno.test("judge download dry-run 不写文件", async () => {
  const dir = Deno.makeTempDirSync();
  const records: { cmd: string; args: string[] }[] = [];
  const opts: JudgeOptions = {
    ...baseOpts,
    command: "download",
    dir,
    envFile: `${dir}/.env.judge`,
    composeFile: `${dir}/docker-compose.judge.yml`,
    dryRun: true,
  };
  const code = await runJudgeCommand(opts, fakeRunner(records));
  assertEquals(code, 0);
  let exists = false;
  try {
    Deno.statSync(`${dir}/judge-install.sh`);
    exists = true;
  } catch {
    exists = false;
  }
  assertEquals(exists, false);
});
