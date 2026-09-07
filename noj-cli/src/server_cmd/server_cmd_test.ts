import { assertEquals } from "@std/assert";
import type { CliContext } from "../context/context.ts";
import type {
  CommandRunner,
  SpawnHandle,
  SpawnOpts,
} from "../runtime/command.ts";
import { runServerCommand } from "./server_cmd.ts";

function runnerWithLog(log: string[][]): CommandRunner {
  return {
    run(cmd, args) {
      log.push([cmd, ...args]);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    spawn(opts: SpawnOpts): SpawnHandle {
      log.push([opts.cmd, ...opts.args]);
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
  };
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
  const call = log[0]!;
  assertEquals(call[0], "docker");
  assertEquals(call.includes("compose"), true);
  assertEquals(call.includes("run"), true);
  assertEquals(call.includes("--entrypoint"), true);
  assertEquals(call.includes("/app/bin/noj"), true);
  assertEquals(call.includes("core"), true);
  assertEquals(call[call.length - 1], "migrate");
});

Deno.test("server: production 上下文透传 bootstrap 参数", async () => {
  const log: string[][] = [];
  const runner = runnerWithLog(log);
  const ctx: CliContext = {
    cwd: "/tmp",
    kind: "production",
    dir: "/opt/neuro-oj",
  };
  await runServerCommand({
    context: ctx,
    args: ["bootstrap", "first-admin", "--username", "admin"],
    runner,
  });
  const call = log[0]!;
  assertEquals(call.includes("bootstrap"), true);
  assertEquals(call.includes("first-admin"), true);
  assertEquals(call.includes("--username"), true);
  assertEquals(call.includes("admin"), true);
});

Deno.test("server: 源码上下文调用 deno task", async () => {
  const root = Deno.makeTempDirSync();
  Deno.mkdirSync(`${root}/noj-core`, { recursive: true });
  Deno.writeTextFileSync(`${root}/noj-core/deno.json`, "{}");
  const log: string[][] = [];
  const runner = runnerWithLog(log);
  const ctx: CliContext = { cwd: `${root}/noj-core`, kind: "none", dir: null };
  const code = await runServerCommand({
    context: ctx,
    args: ["db", "migrate"],
    runner,
  });
  assertEquals(code, 0);
  const call = log[0]!;
  assertEquals(call[0], "deno");
  assertEquals(call.includes("task"), true);
  assertEquals(call.includes("db:migrate"), true);
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

Deno.test("server: judge 上下文返回非零", async () => {
  const log: string[][] = [];
  const runner = runnerWithLog(log);
  const ctx: CliContext = { cwd: "/tmp", kind: "judge", dir: "/srv/noj-judge" };
  const code = await runServerCommand({
    context: ctx,
    args: ["db", "migrate"],
    runner,
  });
  assertEquals(code, 1);
  assertEquals(log.length, 0);
});
