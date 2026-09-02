import { assertEquals } from "@std/assert";
import type { DeployConfig } from "../config/types.ts";
import type {
  CmdResult,
  CommandRunner,
  SpawnHandle,
  SpawnOpts,
} from "../runtime/command.ts";
import { collectLogs, followLogs, parseModulesArg } from "./logs.ts";
import {
  baseConfig,
  makeTempDir,
  secrets,
  writeFixture,
} from "../testing/helpers.ts";

function config(): DeployConfig {
  return baseConfig({
    type: "dev",
    state: "running",
    components: {
      server: { enabled: true, method: "docker", image: "x", env: {} },
      ui: { enabled: true, method: "process", binary: "deno", env: {} },
      judge: { enabled: false, method: "docker", image: "y", env: {} },
    },
    reverse_proxy: {
      type: "nginx",
      config_dir: "/etc/nginx/conf.d",
      domain: "localhost",
      upstream_port: 8080,
    },
  });
}

/** 可编程 fake runner：记录 run 调用，stream 逐行回调。 */
function fakeRunner(records: string[][], dockerOut: string): CommandRunner {
  return {
    run(cmd, args) {
      records.push([cmd, ...args]);
      const r: CmdResult = { code: 0, stdout: dockerOut, stderr: "" };
      return Promise.resolve(r);
    },
    spawn(_opts: SpawnOpts): SpawnHandle {
      throw new Error("fake runner 不 spawn");
    },
    stream(cmd, args, onLine) {
      records.push([cmd, ...args]);
      for (const l of dockerOut.split("\n")) {
        if (l.length > 0) onLine(l);
      }
      return Promise.resolve(0);
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
  const dir = await makeTempDir();
  await writeFixture(dir, { ...config(), install_dir: dir }, secrets());
  await Deno.mkdir(`${dir}/run/logs`, { recursive: true });
  await Deno.writeTextFile(`${dir}/run/logs/ui.log`, "ui-line-1\nui-line-2\n");
  const records: string[][] = [];
  const runner = fakeRunner(records, "server-line-1\nserver-line-2\n");
  const out = await collectLogs({
    dir,
    modules: ["server", "ui"],
    follow: false,
    runner,
  });
  assertEquals(records[0], [
    "docker",
    "compose",
    "-f",
    `${dir}/docker-compose.noj.yml`,
    "logs",
    "--no-color",
    "server",
  ]);
  const server = out.find((m) => m.module === "server")!;
  assertEquals(server.lines, ["server-line-1", "server-line-2"]);
  const ui = out.find((m) => m.module === "ui")!;
  assertEquals(ui.lines, ["ui-line-1", "ui-line-2"]);
});

Deno.test("followLogs: docker 用 stream，process 用 followLogFile", async () => {
  const dir = await makeTempDir();
  await writeFixture(dir, { ...config(), install_dir: dir }, secrets());
  await Deno.mkdir(`${dir}/run/logs`, { recursive: true });
  await Deno.writeTextFile(`${dir}/run/logs/ui.log`, "ui-old\n");
  const records: string[][] = [];
  const runner = fakeRunner(records, "server-follow-1\n");
  const seen: string[] = [];
  const done = followLogs(
    { dir, modules: ["server", "ui"], follow: true, runner },
    (m, l) => seen.push(`${m}:${l}`),
  );
  // 等待 followLogFile 完成初始 offset 定位，再追加新内容
  await new Promise((r) => setTimeout(r, 20));
  await Deno.writeTextFile(`${dir}/run/logs/ui.log`, "ui-follow-1\n", {
    append: true,
  });
  await new Promise((r) => setTimeout(r, 150));
  await done;
  assertEquals(records[0], [
    "docker",
    "compose",
    "-f",
    `${dir}/docker-compose.noj.yml`,
    "logs",
    "--no-color",
    "--follow",
    "server",
  ]);
  assertEquals(seen.includes("server:server-follow-1"), true);
  assertEquals(seen.includes("ui:ui-follow-1"), true);
});
