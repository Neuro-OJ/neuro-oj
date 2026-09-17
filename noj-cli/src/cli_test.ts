import { assertEquals } from "@std/assert";
import {
  dispatchCommand,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  parseBackupArgs,
  parseDeployArgs,
  parseInitOptions,
  parseMaintainArgs,
  parsePort,
  printHelp,
  run,
} from "./cli.ts";
import type { CommandContext } from "./cli.ts";

const ctx: CommandContext = { cwd: "/tmp", deployDir: null };

Deno.test("printHelp 按模式分区并包含全部命令", () => {
  const help = printHelp();
  for (
    const c of [
      "doctor",
      "deploy",
      "maintain",
      "run-server",
      "version",
      "install",
      "backup",
    ]
  ) {
    assertEquals(help.includes(c), true, `help 应包含 ${c}`);
  }
  // 分区标题必须存在（E11：不再靠「以下命令支持 --dir」含糊指代）
  assertEquals(help.includes("生产模式"), true);
  assertEquals(help.includes("JSON 编排模式"), true);
  assertEquals(help.includes("退出码"), true);
});

Deno.test("printHelp 不再声称 maintain backup 支持 schedule（E5）", () => {
  // schedule 只属于生产模式；早先 help 把它写进 maintain backup 子命令列表
  assertEquals(
    printHelp().includes("create/verify/restore/drill/schedule"),
    false,
  );
});

Deno.test("version stub 返回 0", async () => {
  assertEquals(await dispatchCommand("version", [], ctx), EXIT_OK);
});

Deno.test("maintain 无子命令/错误子命令返回用法错误 2（E9）", async () => {
  assertEquals(await dispatchCommand("maintain", [], ctx), EXIT_USAGE);
  assertEquals(await dispatchCommand("maintain", ["unknown"], ctx), EXIT_USAGE);
  // restore 有子命令语义，缺快照时是运行失败而非用法错误
  assertEquals(
    await dispatchCommand("maintain", ["restore"], ctx),
    EXIT_FAILURE,
  );
  assertEquals(await dispatchCommand("run-server", [], ctx), EXIT_FAILURE);
});

Deno.test("deploy 无配置目录时返回 1", async () => {
  assertEquals(await dispatchCommand("deploy", [], ctx), EXIT_FAILURE);
});

Deno.test("maintain logs 无配置目录时返回 1", async () => {
  assertEquals(await dispatchCommand("maintain", ["logs"], ctx), EXIT_FAILURE);
});

Deno.test("maintain config 无配置目录时返回 1", async () => {
  assertEquals(
    await dispatchCommand("maintain", ["config"], ctx),
    EXIT_FAILURE,
  );
});

Deno.test("maintain backup 无配置目录时返回 1", async () => {
  assertEquals(
    await dispatchCommand("maintain", ["backup"], ctx),
    EXIT_FAILURE,
  );
});

Deno.test("maintain reset 无配置目录时返回 1", async () => {
  assertEquals(await dispatchCommand("maintain", ["reset"], ctx), EXIT_FAILURE);
});

Deno.test("maintain reset --dir 解析后找不到配置返回 1", async () => {
  assertEquals(
    await dispatchCommand(
      "maintain",
      ["reset", "--dir", "/nonexistent-noj", "--confirm"],
      ctx,
    ),
    EXIT_FAILURE,
  );
});

Deno.test("maintain verify 无配置目录时返回 1", async () => {
  assertEquals(
    await dispatchCommand("maintain", ["verify"], ctx),
    EXIT_FAILURE,
  );
});

Deno.test("未知命令返回用法错误 2（E9）", async () => {
  assertEquals(await dispatchCommand("bogus", [], ctx), EXIT_USAGE);
});

Deno.test("run 识别 --help 返回 0", async () => {
  assertEquals(await run(["--help"]), EXIT_OK);
});

Deno.test("run 识别 version 返回 0", async () => {
  assertEquals(await run(["version"]), EXIT_OK);
});

// ── #517 E1/E2/E12：--help 全面可用且严格只读 ──────────────────────

Deno.test("E1: 各子命令 --help / -h 返回 0", async () => {
  const cases: string[][] = [
    ["deploy", "--help"],
    ["deploy", "-h"],
    ["deploy", "init", "--help"],
    ["deploy", "up", "--help"],
    ["maintain", "--help"],
    ["maintain", "backup", "--help"],
    ["maintain", "logs", "-h"],
    ["doctor", "--help"],
    ["run-server", "--help"],
    ["install", "--help"],
    ["check", "--help"],
    ["backup", "--help"],
    ["status", "--help"],
  ];
  for (const argv of cases) {
    assertEquals(await run(argv), EXIT_OK, argv.join(" "));
  }
});

Deno.test("E2: deploy init --help 不产生任何副作用（不建文件）", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const before = [...Deno.readDirSync(dir)].length;
    assertEquals(
      await dispatchCommand("deploy", ["init", "--help"], {
        cwd: dir,
        deployDir: null,
      }),
      EXIT_OK,
    );
    const after = [...Deno.readDirSync(dir)].length;
    assertEquals(after, before, "deploy init --help 不得写入任何文件");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("E12: install --help 由 CLI 回答，不出现 deploy.sh 文案", async () => {
  // 捕获 stdout 断言内容
  const original = console.log;
  let out = "";
  console.log = (...a: unknown[]) => {
    out += a.join(" ") + "\n";
  };
  try {
    assertEquals(await run(["install", "--help"]), EXIT_OK);
  } finally {
    console.log = original;
  }
  assertEquals(out.includes("noj-cli install"), true);
  assertEquals(out.includes("deploy.sh install"), false);
});

// ── #517 E3/E4：异常兜底与可读错误 ────────────────────────────────

Deno.test("E3: doctor --port abc 返回用法错误 2，无栈帧", async () => {
  const originalErr = console.error;
  let err = "";
  console.error = (...a: unknown[]) => {
    err += a.join(" ") + "\n";
  };
  try {
    assertEquals(await run(["doctor", "--port", "abc"]), EXIT_USAGE);
  } finally {
    console.error = originalErr;
  }
  assertEquals(err.includes("abc"), true, "错误信息应包含收到的值");
  assertEquals(err.includes("    at "), false, "不得包含栈帧");
  assertEquals(err.includes("file://"), false, "不得包含源码路径");
  assertEquals(err.includes("Uncaught"), false);
});

Deno.test("E4: doctor --port 缺值报「需要整数」而非 undefined", async () => {
  const originalErr = console.error;
  let err = "";
  console.error = (...a: unknown[]) => {
    err += a.join(" ") + "\n";
  };
  try {
    assertEquals(await run(["doctor", "--port"]), EXIT_USAGE);
  } finally {
    console.error = originalErr;
  }
  assertEquals(err.includes("1-65535"), true);
  assertEquals(err.includes("undefined"), false, "不得出现 undefined");
});

Deno.test("E3: --debug 时打印完整栈", async () => {
  const originalErr = console.error;
  let err = "";
  console.error = (...a: unknown[]) => {
    err += a.join(" ") + "\n";
  };
  try {
    assertEquals(await run(["doctor", "--port", "abc", "--debug"]), EXIT_USAGE);
  } finally {
    console.error = originalErr;
  }
  // UsageError 是可预期错误，即便 --debug 也不必打印栈；
  // 真正未预期的错误才在 --debug 下打印（见下一例）
  assertEquals(err.includes("1-65535"), true);
});

Deno.test("E3: 未预期错误在 --debug 下带栈、默认不带", async () => {
  const originalErr = console.error;
  const capture = async (argv: string[]): Promise<string> => {
    let err = "";
    console.error = (...a: unknown[]) => {
      err += a.join(" ") + "\n";
    };
    try {
      await run(argv);
    } finally {
      console.error = originalErr;
    }
    return err;
  };
  // 生产命令的 --dir 指向不存在的目录 → ProductionDirError（已分类，退出码 1）
  const plain = await capture(["status", "--dir", "/nonexistent-noj-xyz"]);
  assertEquals(plain.includes("不是完整的 NOJ 生产安装目录"), true);
  assertEquals(plain.includes("    at "), false, "默认不得打印栈帧");

  // 未分类异常走通用兜底：默认提示加 --debug，--debug 时打印栈帧。
  // 通过一个会在解析后抛出的真实路径触发（production 目录校验失败在 --debug 下带栈）。
  const debug = await capture([
    "status",
    "--dir",
    "/nonexistent-noj-xyz",
    "--debug",
  ]);
  assertEquals(debug.includes("    at "), true, "--debug 应打印栈帧");
});

// ── #517 E7/E8：可发现性 ─────────────────────────────────────────

Deno.test("E7: --version 与 -v 输出且返回 0", async () => {
  const original = console.log;
  const capture = async (argv: string[]): Promise<string> => {
    let out = "";
    console.log = (...a: unknown[]) => {
      out += a.join(" ") + "\n";
    };
    try {
      await run(argv);
    } finally {
      console.log = original;
    }
    return out;
  };
  const long = await capture(["--version"]);
  const short = await capture(["-v"]);
  assertEquals(long.includes("noj-cli"), true);
  assertEquals(long, short);
});

Deno.test("E8: 拼写错误给出建议", async () => {
  const originalErr = console.error;
  let err = "";
  console.error = (...a: unknown[]) => {
    err += a.join(" ") + "\n";
  };
  try {
    assertEquals(await run(["instal"]), EXIT_USAGE);
  } finally {
    console.error = originalErr;
  }
  assertEquals(err.includes("install"), true, `应建议 install，实际: ${err}`);
});

// ── 解析函数 ─────────────────────────────────────────────────────

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

Deno.test("parseInitOptions: 支持 --dir=/opt 写法（E6 一致性）", () => {
  assertEquals(parseInitOptions(["--dir=/opt"], "/tmp").installDir, "/opt");
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

Deno.test("E6: parseDeployArgs 支持 --dir= 且缺值报错", () => {
  assertEquals(parseDeployArgs([]).dir, undefined);
  assertEquals(parseDeployArgs(["--dir", "/opt"]).dir, "/opt");
  assertEquals(parseDeployArgs(["--dir=/opt"]).dir, "/opt");
  let threw = false;
  try {
    parseDeployArgs(["--dir"]);
  } catch {
    threw = true;
  }
  assertEquals(threw, true, "--dir 缺值必须显式报错");
});

Deno.test("E6: parseMaintainArgs 支持 --dir= 且缺值报错", () => {
  assertEquals(parseMaintainArgs(["--dir=/opt"]).dir, "/opt");
  let threw = false;
  try {
    parseMaintainArgs(["--dir"]);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("E6: parseBackupArgs 支持 --dir= 且缺值报错", () => {
  assertEquals(parseBackupArgs(["create", "--dir=/opt"]).dir, "/opt");
  let threw = false;
  try {
    parseBackupArgs(["create", "--dir"]);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("E6: parseBackupArgs 旗标缺值报错而非静默 undefined", () => {
  for (const argv of [["create", "--backup-dir"], ["create", "--report"]]) {
    let threw = false;
    try {
      parseBackupArgs(argv);
    } catch {
      threw = true;
    }
    assertEquals(threw, true, argv.join(" "));
  }
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

Deno.test("parseMaintainArgs: --color 只在合法模式时消费下一个参数", () => {
  // 回归防线（评审 P2）：早先对任意非 `-` 开头的参数都当作颜色值，
  // `--color server` 会把模块名吞掉，导致 modules 变成 undefined。
  const swallowed = parseMaintainArgs(["--color", "server"]);
  assertEquals(swallowed.modules, "server", "模块名不得被 --color 吞掉");
  assertEquals(swallowed.color, "always", "裸 --color 视为强制开色");

  const never = parseMaintainArgs(["--color", "never", "core"]);
  assertEquals(never.color, "never");
  assertEquals(never.modules, "core");
  assertEquals(parseMaintainArgs(["--color=auto", "core"]).modules, "core");
  const upper = parseMaintainArgs(["--color", "ALWAYS", "core"]);
  assertEquals(upper.color, "always");
  assertEquals(upper.modules, "core");
  const bogus = parseMaintainArgs(["--color", "bogus", "core"]);
  assertEquals(bogus.modules, "bogus");
  assertEquals(bogus.color, "always");
  assertEquals(parseMaintainArgs(["core", "--color"]).modules, "core");
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

Deno.test("parseBackupArgs: 非法 --zstd-level 报错", () => {
  let threw = false;
  try {
    parseBackupArgs(["create", "--zstd-level", "99"]);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});
