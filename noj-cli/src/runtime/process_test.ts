import { makeTempDir } from "../testing/helpers.ts";
import { assertEquals } from "@std/assert";
import type { ComponentConfig } from "../config/types.ts";
import type { CommandRunner, SpawnHandle, SpawnOpts } from "./command.ts";
import {
  processLaunch,
  runServerForeground,
  startManagedProcess,
  stopManagedProcess,
} from "./process.ts";
import { readPid } from "./pidfile.ts";

/** 可编程 fake runner：spawn 时记录请求并返回假句柄。 */
function fakeRunner(spawned: SpawnOpts[], killed: number[]): CommandRunner {
  return {
    run(cmd, args) {
      if (cmd === "kill") {
        const pid = Number(args[1]);
        if (Number.isInteger(pid)) killed.push(pid);
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    spawn(opts) {
      spawned.push(opts);
      const handle: SpawnHandle = {
        pid: 12345,
        wait() {
          return Promise.resolve(0);
        },
        kill() {
          killed.push(12345);
          return Promise.resolve();
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
  const dir = await makeTempDir();
  const runDir = `${dir}/run`;
  const spawned: SpawnOpts[] = [];
  const runner = fakeRunner(spawned, []);
  const { pid } = await startManagedProcess(
    runner,
    runDir,
    "server",
    server,
    { PORT: "8000" },
    dir,
  );
  assertEquals(pid, 12345);
  assertEquals(spawned.length, 1);
  assertEquals(spawned[0]!.cmd, "noj-server");
  assertEquals(await readPid(runDir, "server"), 12345);
});

Deno.test("stopManagedProcess: 读 PID 后 kill 并清文件", async () => {
  const dir = await makeTempDir();
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
  const dir = await makeTempDir();
  const runner = fakeRunner([], []);
  let threw = false;
  try {
    await stopManagedProcess(runner, `${dir}/run`, "ghost");
  } catch {
    threw = true;
  }
  assertEquals(threw, false);
});

Deno.test("startManagedProcess: 输出写入 run/logs/<component>.log", async () => {
  const dir = await makeTempDir();
  const runDir = `${dir}/run`;
  const spawned: SpawnOpts[] = [];
  const runner = fakeRunner(spawned, []);
  await startManagedProcess(
    runner,
    runDir,
    "server",
    server,
    { PORT: "8000" },
    dir,
  );
  assertEquals(spawned[0]!.stdoutFile, `${runDir}/logs/server.log`);
  assertEquals(spawned[0]!.stderrFile, `${runDir}/logs/server.log`);
});

Deno.test("runServerForeground: 前台 spawn server 并返回退出码", async () => {
  const dir = await makeTempDir();
  const cfg = {
    schema_version: 1,
    type: "dev",
    state: "stopped",
    created_at: "2026-08-31T00:00:00Z",
    updated_at: "2026-08-31T00:00:00Z",
    install_dir: dir,
    version: { noj_cli: "0.1.0", noj_server: "0.1.0" },
    env: {},
    components: {
      server: {
        enabled: true,
        method: "process",
        binary: "noj-server",
        port: 8000,
        host_port: null,
        env: { PORT: "8000" },
      },
    },
    reverse_proxy: {
      type: "nginx",
      config_dir: "/etc/nginx/conf.d",
      domain: "localhost",
      upstream_port: 8080,
    },
  };
  await Deno.writeTextFile(`${dir}/noj-deploy.json`, JSON.stringify(cfg));
  await Deno.writeTextFile(
    `${dir}/noj-secrets.json`,
    JSON.stringify({
      schema_version: 1,
      created_at: "2026-08-31T00:00:00Z",
      updated_at: "2026-08-31T00:00:00Z",
      secrets: {},
    }),
  );
  // 预置本地 noj-server 二进制，避免测试触发网络下载。
  await Deno.mkdir(`${dir}/bin`, { recursive: true });
  await Deno.writeTextFile(`${dir}/bin/noj-server`, "#!/bin/sh\n");
  await Deno.writeTextFile(`${dir}/bin/noj-server.version`, "0.1.0\n");
  const spawned: SpawnOpts[] = [];
  const runner = fakeRunner(spawned, []);
  const code = await runServerForeground({ dir, runner });
  assertEquals(code, 0);
  assertEquals(spawned[0]!.cmd, `${dir}/bin/noj-server`);
  assertEquals(spawned[0]!.cwd, dir);
});
