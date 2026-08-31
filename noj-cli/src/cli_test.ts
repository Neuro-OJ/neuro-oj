import { assertEquals } from "@std/assert";
import {
  dispatchCommand,
  parseDeployArgs,
  parseInitOptions,
  parseMaintainArgs,
  parsePort,
  printHelp,
  run,
} from "./cli.ts";
import type { CommandContext } from "./cli.ts";

const ctx: CommandContext = { cwd: "/tmp", deployDir: null };

Deno.test("printHelp 包含全部顶层命令", () => {
  const help = printHelp();
  for (const c of ["doctor", "deploy", "maintain", "run-server", "version"]) {
    assertEquals(help.includes(c), true, `help 应包含 ${c}`);
  }
});

Deno.test("version stub 返回 0", async () => {
  assertEquals(await dispatchCommand("version", [], ctx), 0);
});

Deno.test("maintain/run-server stub 返回 0", async () => {
  assertEquals(await dispatchCommand("maintain", [], ctx), 0);
  assertEquals(await dispatchCommand("run-server", [], ctx), 0);
});

Deno.test("deploy 无配置目录时返回 1", async () => {
  assertEquals(await dispatchCommand("deploy", [], ctx), 1);
});

Deno.test("maintain 子命令返回 0", async () => {
  for (const sub of ["backup", "restore", "verify", "reset"]) {
    assertEquals(
      await dispatchCommand("maintain", [sub], ctx),
      0,
      `maintain ${sub}`,
    );
  }
});

Deno.test("maintain logs 无配置目录时返回 1", async () => {
  assertEquals(await dispatchCommand("maintain", ["logs"], ctx), 1);
});

Deno.test("maintain config 无配置目录时返回 1", async () => {
  assertEquals(await dispatchCommand("maintain", ["config"], ctx), 1);
});

Deno.test("未知命令返回 1", async () => {
  assertEquals(await dispatchCommand("bogus", [], ctx), 1);
});

Deno.test("run 识别 --help 返回 0", async () => {
  assertEquals(await run(["--help"]), 0);
});

Deno.test("run 识别 version 返回 0", async () => {
  assertEquals(await run(["version"]), 0);
});

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

Deno.test("parseInitOptions: 缺省 mode/port/installDir", () => {
  const opts = parseInitOptions([], "/tmp");
  assertEquals(opts.mode, undefined);
  assertEquals(opts.port, undefined);
  assertEquals(opts.installDir, "/tmp");
});

Deno.test("parseInitOptions: 解析 --mode prod --port 9000 --dir /opt", () => {
  const opts = parseInitOptions(
    ["--mode", "prod", "--port", "9000", "--dir", "/opt"],
    "/tmp",
  );
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

Deno.test("parseDeployArgs: 无 --dir 时返回 undefined", () => {
  assertEquals(parseDeployArgs([]).dir, undefined);
});

Deno.test("parseDeployArgs: 解析 --dir /opt", () => {
  assertEquals(parseDeployArgs(["--dir", "/opt"]).dir, "/opt");
});

Deno.test("parseMaintainArgs: 缺省 modules/follow/dir", () => {
  const a = parseMaintainArgs([]);
  assertEquals(a.modules, undefined);
  assertEquals(a.follow, false);
  assertEquals(a.dir, undefined);
});

Deno.test("parseMaintainArgs: 解析 modules 与 --follow --dir", () => {
  const a = parseMaintainArgs(["server,ui", "--follow", "--dir", "/opt"]);
  assertEquals(a.modules, "server,ui");
  assertEquals(a.follow, true);
  assertEquals(a.dir, "/opt");
});
