import { assertEquals } from "@std/assert";
import {
  dispatchCommand,
  parseBackupArgs,
  parseDeployArgs,
  parseInitOptions,
  parseMaintainArgs,
  parseObservabilityArgs,
  parsePort,
  parseServerArgs,
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

Deno.test("maintain 无子命令或错误子命令返回失败；run-server 无配置目录返回 1", async () => {
  assertEquals(await dispatchCommand("maintain", [], ctx), 1);
  assertEquals(await dispatchCommand("maintain", ["unknown"], ctx), 1);
  assertEquals(await dispatchCommand("maintain", ["restore"], ctx), 1);
  assertEquals(await dispatchCommand("run-server", [], ctx), 1);
});

Deno.test("deploy 无配置目录时返回 1", async () => {
  assertEquals(await dispatchCommand("deploy", [], ctx), 1);
});

Deno.test("maintain logs 无配置目录时返回 1", async () => {
  assertEquals(await dispatchCommand("maintain", ["logs"], ctx), 1);
});

Deno.test("maintain config 无配置目录时返回 1", async () => {
  assertEquals(await dispatchCommand("maintain", ["config"], ctx), 1);
});

Deno.test("maintain backup 无配置目录时返回 1", async () => {
  assertEquals(await dispatchCommand("maintain", ["backup"], ctx), 1);
});

Deno.test("maintain reset 无配置目录时返回 1", async () => {
  assertEquals(await dispatchCommand("maintain", ["reset"], ctx), 1);
});

Deno.test("maintain reset --dir 解析后找不到配置返回 1", async () => {
  assertEquals(
    await dispatchCommand(
      "maintain",
      ["reset", "--dir", "/nonexistent-noj", "--confirm"],
      ctx,
    ),
    1,
  );
});

Deno.test("maintain verify 无配置目录时返回 1", async () => {
  assertEquals(await dispatchCommand("maintain", ["verify"], ctx), 1);
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

Deno.test("parseBackupArgs: create 旗标解析", () => {
  const a = parseBackupArgs([
    "create",
    "--backup-dir",
    "/bk",
    "--passphrase-file",
    "/pw",
    "--zstd-level",
    "19",
    "--no-encrypt",
    "--dir",
    "/opt",
  ]);
  assertEquals(a.sub, "create");
  assertEquals(a.backupDir, "/bk");
  assertEquals(a.passphraseFile, "/pw");
  assertEquals(a.zstdLevel, 19);
  assertEquals(a.noEncrypt, true);
  assertEquals(a.dir, "/opt");
});

Deno.test("parseBackupArgs: verify 位置参数 snapshot", () => {
  const a = parseBackupArgs([
    "verify",
    "/bk/snapshot-2026.nojbackup",
    "--dir",
    "/opt",
  ]);
  assertEquals(a.sub, "verify");
  assertEquals(a.snapshot, "/bk/snapshot-2026.nojbackup");
});

Deno.test("parseBackupArgs: restore 旗标", () => {
  const a = parseBackupArgs([
    "restore",
    "x.nojbackup",
    "--confirm",
    "--include-deploy-configs",
    "--passphrase-file",
    "/pw",
  ]);
  assertEquals(a.sub, "restore");
  assertEquals(a.confirm, true);
  assertEquals(a.includeDeployConfigs, true);
  assertEquals(a.passphraseFile, "/pw");
});

Deno.test("parseBackupArgs: drill report 旗标", () => {
  const a = parseBackupArgs(["drill", "x.nojbackup", "--report", "/r.json"]);
  assertEquals(a.sub, "drill");
  assertEquals(a.report, "/r.json");
});

Deno.test("parseObservabilityArgs: check 参数解析", () => {
  const a = parseObservabilityArgs([
    "check",
    "--base-url",
    "http://noj.test",
    "--check-notifications",
    "--alertmanager-url",
    "http://am:9093",
  ]);
  assertEquals(a.sub, "check");
  assertEquals(a.baseUrl, "http://noj.test");
  assertEquals(a.checkNotifications, true);
  assertEquals(a.alertmanagerUrl, "http://am:9093");
});

Deno.test("parseObservabilityArgs: alert-drill 参数解析", () => {
  const a = parseObservabilityArgs([
    "alert-drill",
    "--alertmanager-url",
    "http://am:9093",
    "--hold",
    "0",
  ]);
  assertEquals(a.sub, "alert-drill");
  assertEquals(a.alertmanagerUrl, "http://am:9093");
  assertEquals(a.holdSeconds, 0);
});

Deno.test("observability 无子命令返回 1", async () => {
  assertEquals(await dispatchCommand("observability", [], ctx), 1);
});

Deno.test("server 无上下文时返回 1", async () => {
  assertEquals(await dispatchCommand("server", ["db", "migrate"], ctx), 1);
});

Deno.test("printHelp 包含 server", () => {
  assertEquals(printHelp().includes("server <cmd>"), true);
});

Deno.test("parseObservabilityArgs: 未知参数抛错", () => {
  let threw = false;
  try {
    parseObservabilityArgs(["check", "--unknown"]);
  } catch (e) {
    threw = true;
    assertEquals((e as Error).message.includes("未知 observability"), true);
  }
  assertEquals(threw, true);
});

Deno.test("parseObservabilityArgs: 缺少 --base-url/--alertmanager-url/--hold 值抛错", () => {
  for (
    const args of [
      ["check", "--base-url"],
      ["alert-drill", "--alertmanager-url"],
      ["alert-drill", "--hold"],
    ]
  ) {
    let threw = false;
    try {
      parseObservabilityArgs(args);
    } catch (e) {
      threw = true;
      assertEquals((e as Error).message.includes("缺少值"), true);
    }
    assertEquals(threw, true, `应抛错: ${args.join(" ")}`);
  }
});

Deno.test("parseObservabilityArgs: --hold 必须是非负整数", () => {
  for (const bad of ["-1", "1.5", "abc", "0x10"]) {
    let threw = false;
    try {
      parseObservabilityArgs(["alert-drill", "--hold", bad]);
    } catch (e) {
      threw = true;
      assertEquals((e as Error).message.includes("非负整数"), true);
    }
    assertEquals(threw, true, `非法 --hold 应抛错: ${bad}`);
  }
});

Deno.test("dispatch observability 参数错误返回 1", async () => {
  assertEquals(await dispatchCommand("observability", ["--unknown"], ctx), 1);
  assertEquals(
    await dispatchCommand("observability", ["check", "--base-url"], ctx),
    1,
  );
});

Deno.test("parseServerArgs: 无全局 --dir 时原样透传", () => {
  assertEquals(parseServerArgs(["db", "migrate"]), {
    dir: undefined,
    args: ["db", "migrate"],
  });
});

Deno.test("parseServerArgs: 全局 --dir 被剥离并记录目录", () => {
  assertEquals(parseServerArgs(["--dir", "/src", "db", "migrate"]), {
    dir: "/src",
    args: ["db", "migrate"],
  });
});

Deno.test("parseServerArgs: 子命令内部 --dir 不被剥离", () => {
  assertEquals(
    parseServerArgs(["problems", "import", "--dir", "/data"]),
    {
      dir: undefined,
      args: ["problems", "import", "--dir", "/data"],
    },
  );
});

Deno.test("parseServerArgs/server dispatch: 缺少 --dir 值时返回清晰错误并返回 1", async () => {
  let threw = false;
  try {
    parseServerArgs(["--dir"]);
  } catch (e) {
    threw = true;
    assertEquals((e as Error).message.includes("--dir 缺少目录参数"), true);
  }
  assertEquals(threw, true);
  assertEquals(await dispatchCommand("server", ["--dir"], ctx), 1);
});

Deno.test("printHelp 将 observability/server 放在运维与观测分组", () => {
  const help = printHelp();
  const obsIndex = help.indexOf("observability check");
  const serverIndex = help.indexOf("server <cmd>");
  const jsonIndex = help.indexOf("JSON 配置部署工具");
  const opsIndex = help.indexOf("运维与观测命令");
  assertEquals(obsIndex > jsonIndex, true);
  assertEquals(serverIndex > jsonIndex, true);
  assertEquals(opsIndex !== -1 && opsIndex < obsIndex, true);
  assertEquals(opsIndex !== -1 && opsIndex < serverIndex, true);
});
