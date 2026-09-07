import { assertEquals } from "@std/assert";
import type { CliContext } from "../context/context.ts";
import type {
  CommandRunner,
  SpawnHandle,
  SpawnOpts,
} from "../runtime/command.ts";
import { runServerCommand } from "./server_cmd.ts";

interface TestRunner extends CommandRunner {
  spawnCalls: SpawnOpts[];
}

function runnerWithLog(log: string[][]): TestRunner {
  const spawnCalls: SpawnOpts[] = [];
  return {
    run(cmd, args) {
      log.push([cmd, ...args]);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    spawn(opts: SpawnOpts): SpawnHandle {
      log.push([opts.cmd, ...opts.args]);
      spawnCalls.push(opts);
      return {
        pid: 1,
        wait() {
          return Promise.resolve(0);
        },
        kill() {
          return Promise.resolve();
        },
      };
    },
    spawnCalls,
  };
}

function makeSourceRoot(): string {
  const root = Deno.makeTempDirSync();
  Deno.mkdirSync(`${root}/noj-core`, { recursive: true });
  Deno.writeTextFileSync(`${root}/noj-core/deno.json`, "{}");
  return root;
}

async function withSourceRoot(
  fn: (root: string) => void | Promise<void>,
): Promise<void> {
  const root = makeSourceRoot();
  try {
    await fn(root);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
}

function sourceContext(cwd: string): CliContext {
  return { cwd, kind: "none", dir: null };
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
  assertEquals(log[0], [
    "docker",
    "compose",
    "--env-file",
    "/opt/neuro-oj/.env.prod",
    "--file",
    "/opt/neuro-oj/docker-compose.prod.yml",
    "run",
    "--rm",
    "--entrypoint",
    "/app/bin/noj",
    "core",
    "db",
    "migrate",
  ]);
  assertEquals(runner.spawnCalls[0]?.cwd, "/opt/neuro-oj");
});

Deno.test("server: production 上下文透传 bootstrap 参数", async () => {
  const log: string[][] = [];
  const runner = runnerWithLog(log);
  const ctx: CliContext = {
    cwd: "/tmp",
    kind: "production",
    dir: "/opt/neuro-oj",
  };
  const code = await runServerCommand({
    context: ctx,
    args: ["bootstrap", "first-admin", "--username", "admin"],
    runner,
  });
  assertEquals(code, 0);
  assertEquals(log[0], [
    "docker",
    "compose",
    "--env-file",
    "/opt/neuro-oj/.env.prod",
    "--file",
    "/opt/neuro-oj/docker-compose.prod.yml",
    "run",
    "--rm",
    "--entrypoint",
    "/app/bin/noj",
    "core",
    "bootstrap",
    "first-admin",
    "--username",
    "admin",
  ]);
  assertEquals(runner.spawnCalls[0]?.cwd, "/opt/neuro-oj");
});

Deno.test("server: 源码上下文 db migrate 调用 deno task", async () => {
  await withSourceRoot(async (root) => {
    const log: string[][] = [];
    const runner = runnerWithLog(log);
    const ctx = sourceContext(`${root}/noj-core`);
    const code = await runServerCommand({
      context: ctx,
      args: ["db", "migrate"],
      runner,
    });
    assertEquals(code, 0);
    assertEquals(log[0], ["deno", "task", "db:migrate"]);
    assertEquals(runner.spawnCalls[0]?.cwd, `${root}/noj-core`);
  });
});

Deno.test("server: 显式 sourceDir 可从非源码 cwd 定位源码根", async () => {
  await withSourceRoot(async (root) => {
    const log: string[][] = [];
    const runner = runnerWithLog(log);
    const ctx: CliContext = { cwd: "/tmp", kind: "none", dir: null };
    const code = await runServerCommand({
      context: ctx,
      sourceDir: `${root}/noj-core`,
      args: ["db", "migrate"],
      runner,
    });
    assertEquals(code, 0);
    assertEquals(log[0], ["deno", "task", "db:migrate"]);
    assertEquals(runner.spawnCalls[0]?.cwd, `${root}/noj-core`);
  });
});

Deno.test("server: 源码上下文 bootstrap first-admin 透传参数", async () => {
  await withSourceRoot(async (root) => {
    const log: string[][] = [];
    const runner = runnerWithLog(log);
    const ctx = sourceContext(`${root}/noj-core`);
    const code = await runServerCommand({
      context: ctx,
      args: ["bootstrap", "first-admin", "--username", "admin"],
      runner,
    });
    assertEquals(code, 0);
    assertEquals(log[0], [
      "deno",
      "run",
      "--env-file=.env",
      "-A",
      "scripts/noj.ts",
      "bootstrap",
      "first-admin",
      "--username",
      "admin",
    ]);
    assertEquals(runner.spawnCalls[0]?.cwd, `${root}/noj-core`);
  });
});

Deno.test("server: 源码上下文 problems build 透传参数", async () => {
  await withSourceRoot(async (root) => {
    const log: string[][] = [];
    const runner = runnerWithLog(log);
    const ctx = sourceContext(`${root}/noj-core`);
    const code = await runServerCommand({
      context: ctx,
      args: ["problems", "build", "--problem", "abc"],
      runner,
    });
    assertEquals(code, 0);
    assertEquals(log[0], [
      "deno",
      "task",
      "problems:build",
      "--",
      "--problem",
      "abc",
    ]);
    assertEquals(runner.spawnCalls[0]?.cwd, `${root}/noj-core`);
  });
});

Deno.test("server: 源码上下文 problems import 透传参数", async () => {
  await withSourceRoot(async (root) => {
    const log: string[][] = [];
    const runner = runnerWithLog(log);
    const ctx = sourceContext(`${root}/noj-core`);
    const code = await runServerCommand({
      context: ctx,
      args: ["problems", "import", "--file", "problems.json"],
      runner,
    });
    assertEquals(code, 0);
    assertEquals(log[0], [
      "deno",
      "task",
      "problems:import",
      "--",
      "--file",
      "problems.json",
    ]);
    assertEquals(runner.spawnCalls[0]?.cwd, `${root}/noj-core`);
  });
});

Deno.test("server: 源码上下文 init system", async () => {
  await withSourceRoot(async (root) => {
    const log: string[][] = [];
    const runner = runnerWithLog(log);
    const ctx = sourceContext(`${root}/noj-core`);
    const code = await runServerCommand({
      context: ctx,
      args: ["init", "system"],
      runner,
    });
    assertEquals(code, 0);
    assertEquals(log[0], ["deno", "task", "init:system"]);
    assertEquals(runner.spawnCalls[0]?.cwd, `${root}/noj-core`);
  });
});

Deno.test("server: 源码上下文 dev-setup", async () => {
  await withSourceRoot(async (root) => {
    const log: string[][] = [];
    const runner = runnerWithLog(log);
    const ctx = sourceContext(`${root}/noj-core`);
    const code = await runServerCommand({
      context: ctx,
      args: ["dev-setup"],
      runner,
    });
    assertEquals(code, 0);
    assertEquals(log[0], ["deno", "task", "dev-setup"]);
    assertEquals(runner.spawnCalls[0]?.cwd, `${root}/noj-core`);
  });
});

Deno.test("server: 未知或不支持的子命令返回非零且不执行", async () => {
  const cases: string[][] = [
    ["foo"],
    ["db"],
    ["db", "init"],
    ["db", "migrate", "extra"],
    ["init"],
    ["init", "migrate"],
    ["init", "system", "extra"],
    ["bootstrap"],
    ["bootstrap", "bad"],
    ["problems"],
    ["problems", "foo"],
    ["dev-setup", "extra"],
  ];
  for (const args of cases) {
    const log: string[][] = [];
    const runner = runnerWithLog(log);
    const ctx: CliContext = {
      cwd: "/tmp",
      kind: "production",
      dir: "/opt/neuro-oj",
    };
    const code = await runServerCommand({ context: ctx, args, runner });
    assertEquals(code, 1, `expected failure for ${args.join(" ")}`);
    assertEquals(log.length, 0, `expected no spawn for ${args.join(" ")}`);
  }
});

Deno.test("server: bootstrap 拒绝 --password 命令行参数", async () => {
  const cases: string[][] = [
    ["bootstrap", "first-admin", "--password", "secret"],
    ["bootstrap", "admin", "--password=secret"],
  ];
  for (const args of cases) {
    const log: string[][] = [];
    const runner = runnerWithLog(log);
    const ctx: CliContext = {
      cwd: "/tmp",
      kind: "production",
      dir: "/opt/neuro-oj",
    };
    const code = await runServerCommand({ context: ctx, args, runner });
    assertEquals(code, 1, `expected failure for ${args.join(" ")}`);
    assertEquals(log.length, 0, `expected no spawn for ${args.join(" ")}`);
  }
});

Deno.test("server: production spawn 异常返回非零", async () => {
  const log: string[][] = [];
  const runner: CommandRunner = {
    run() {
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    spawn() {
      throw new Error("docker spawn failed");
    },
  };
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
  assertEquals(code, 1);
  assertEquals(log.length, 0);
});

Deno.test("server: 无上下文且找不到源码根目录返回非零", async () => {
  const log: string[][] = [];
  const runner = runnerWithLog(log);
  const ctx: CliContext = { cwd: "/tmp", kind: "none", dir: null };
  const code = await runServerCommand({
    context: ctx,
    args: ["db", "migrate"],
    runner,
  });
  assertEquals(code, 1);
  assertEquals(log.length, 0);
});

Deno.test("server: judge 上下文即使位于源码根目录也返回非零且不执行", async () => {
  await withSourceRoot(async (root) => {
    const log: string[][] = [];
    const runner = runnerWithLog(log);
    const ctx: CliContext = {
      cwd: `${root}/noj-core`,
      kind: "judge",
      dir: null,
    };
    const code = await runServerCommand({
      context: ctx,
      args: ["db", "migrate"],
      runner,
    });
    assertEquals(code, 1);
    assertEquals(log.length, 0);
    assertEquals(runner.spawnCalls.length, 0);
  });
});
