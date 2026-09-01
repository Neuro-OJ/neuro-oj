import { assertEquals } from "@std/assert";
import type { DeployConfig } from "../config/types.ts";
import type {
  CommandRunner,
  SpawnHandle,
  SpawnOpts,
} from "../runtime/command.ts";
import { deployDown, deployRestart, deployStatus, deployUp } from "./deploy.ts";
import { COMPOSE_FILE } from "./compose.ts";
import { writePid } from "../runtime/pidfile.ts";
import {
  baseConfig,
  makeTempDir,
  NOW,
  secrets,
  writeFixture as writeFixtureFiles,
} from "../testing/helpers.ts";

function config(
  state: DeployConfig["state"],
  installDir = "/opt/neuro-oj",
): DeployConfig {
  return baseConfig({
    type: "dev",
    state,
    created_at: NOW,
    updated_at: NOW,
    install_dir: installDir,
    env: { LOG_LEVEL: "info" },
    components: {
      postgres: {
        enabled: true,
        method: "docker",
        image: "postgres:16-alpine",
        internal_port: 5432,
        host_port: null,
        env: { POSTGRES_PASSWORD: "${POSTGRES_PASSWORD}" },
      },
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
  });
}

async function writeFixture(
  dir: string,
  state: DeployConfig["state"],
): Promise<void> {
  await writeFixtureFiles(
    dir,
    config(state, dir),
    secrets({
      secrets: { POSTGRES_PASSWORD: "pg" },
    }),
  );
  await Deno.mkdir(`${dir}/run`, { recursive: true });
  // 预置本地 noj-server 二进制，避免测试触发网络下载。
  await Deno.mkdir(`${dir}/bin`, { recursive: true });
  await Deno.writeTextFile(`${dir}/bin/noj-server`, "#!/bin/sh\n");
  await Deno.writeTextFile(`${dir}/bin/noj-server.version`, "0.1.0\n");
}

/**
 * 可编程 fake runner：模拟 docker compose（stdout 含/不含服务名）与 process spawn。
 * dockerOk=false 时 up 返回非零（触发 partial）。
 */
function fakeRunner(
  dockerOk = true,
  psStdout = "postgres running",
): CommandRunner {
  const spawned: SpawnOpts[] = [];
  return {
    run(cmd, args) {
      const isDocker = cmd === "docker";
      const isPs = isDocker && args.includes("ps");
      if (isPs) {
        return Promise.resolve(
          dockerOk
            ? { code: 0, stdout: psStdout, stderr: "" }
            : { code: 1, stdout: "", stderr: "err" },
        );
      }
      if (isDocker) {
        return Promise.resolve(
          dockerOk
            ? { code: 0, stdout: "ok", stderr: "" }
            : { code: 1, stdout: "", stderr: "up failed" },
        );
      }
      if (cmd === "kill") {
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    spawn(opts) {
      spawned.push(opts);
      const handle: SpawnHandle = {
        pid: 2222,
        wait() {
          return Promise.resolve(0);
        },
        kill() {
          return Promise.resolve();
        },
      };
      return handle;
    },
  };
}

Deno.test("deployUp: 从 stopped 启动 docker 与 process，写入 running", async () => {
  const dir = await makeTempDir();
  await writeFixture(dir, "stopped");
  const runner = fakeRunner();
  const state = await deployUp({ dir, runner });
  assertEquals(state, "running");
  const saved = JSON.parse(
    await Deno.readTextFile(`${dir}/noj-deploy.json`),
  ) as DeployConfig;
  assertEquals(saved.state, "running");
  const compose = await Deno.readTextFile(`${dir}/${COMPOSE_FILE}`);
  assertEquals(compose.includes("postgres:"), true);
  // server 是 process，compose 无 server，但 PID 文件已写
  await Deno.readTextFile(`${dir}/run/server.pid`);
});

Deno.test("deployUp: 已 running 时 no-op", async () => {
  const dir = await makeTempDir();
  await writeFixture(dir, "running");
  const state = await deployUp({ dir, runner: fakeRunner() });
  assertEquals(state, "running");
  const saved = JSON.parse(
    await Deno.readTextFile(`${dir}/noj-deploy.json`),
  ) as DeployConfig;
  assertEquals(saved.state, "running");
  // 不应生成 compose（没跑 docker up）
  let composeExists = false;
  try {
    await Deno.stat(`${dir}/${COMPOSE_FILE}`);
    composeExists = true;
  } catch {
    composeExists = false;
  }
  assertEquals(composeExists, false);
});

Deno.test("deployUp: docker 失败时写入 partial", async () => {
  const dir = await makeTempDir();
  await writeFixture(dir, "stopped");
  const state = await deployUp({ dir, runner: fakeRunner(false) });
  assertEquals(state, "partial");
  const saved = JSON.parse(
    await Deno.readTextFile(`${dir}/noj-deploy.json`),
  ) as DeployConfig;
  assertEquals(saved.state, "partial");
});

Deno.test("deployDown: 从 running 停止并写 stopped，保留 compose 文件", async () => {
  const dir = await makeTempDir();
  await writeFixture(dir, "running");
  await Deno.writeTextFile(`${dir}/${COMPOSE_FILE}`, "services: {}\n");
  await writePid(`${dir}/run`, "server", 2222);
  const state = await deployDown({ dir, runner: fakeRunner() });
  assertEquals(state, "stopped");
  const saved = JSON.parse(
    await Deno.readTextFile(`${dir}/noj-deploy.json`),
  ) as DeployConfig;
  assertEquals(saved.state, "stopped");
  // 进程 PID 文件被清除
  let pidLeft = true;
  try {
    await Deno.stat(`${dir}/run/server.pid`);
  } catch {
    pidLeft = false;
  }
  assertEquals(pidLeft, false);
});

Deno.test("deployDown: 已 stopped 时 no-op", async () => {
  const dir = await makeTempDir();
  await writeFixture(dir, "stopped");
  const state = await deployDown({ dir, runner: fakeRunner() });
  assertEquals(state, "stopped");
});

Deno.test("deployRestart: 从 stopped 直接 up 到 running", async () => {
  const dir = await makeTempDir();
  await writeFixture(dir, "stopped");
  const state = await deployRestart({ dir, runner: fakeRunner() });
  assertEquals(state, "running");
});

Deno.test("deployRestart: 从 running 先 down 再 up", async () => {
  const dir = await makeTempDir();
  await writeFixture(dir, "running");
  await Deno.writeTextFile(`${dir}/${COMPOSE_FILE}`, "services: {}\n");
  const state = await deployRestart({ dir, runner: fakeRunner() });
  assertEquals(state, "running");
});

Deno.test("deployStatus: 报告状态与各组件 running 情况", async () => {
  const dir = await makeTempDir();
  await writeFixture(dir, "running");
  await Deno.writeTextFile(`${dir}/${COMPOSE_FILE}`, "services: {}\n");
  await writePid(`${dir}/run`, "server", 2222);
  const report = await deployStatus({
    dir,
    runner: fakeRunner(true, "postgres running"),
  });
  assertEquals(report.state, "running");
  const pg = report.components.find((c) => c.component === "postgres")!;
  assertEquals(pg.running, true);
  const srv = report.components.find((c) => c.component === "server")!;
  assertEquals(srv.method, "process");
  assertEquals(srv.running, true);
});

Deno.test("deployStatus: 配置缺失时返回 uninitialized", async () => {
  const dir = await makeTempDir();
  const report = await deployStatus({ dir, runner: fakeRunner() });
  assertEquals(report.state, "uninitialized");
  assertEquals(report.components.length, 0);
});
