import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { dispatchCommand, run } from "./cli.ts";
import {
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
} from "./cli-commands/exit-codes.ts";
import {
  formatBytes,
  parseInstallDirArg,
  stripCliOwnedFlags,
} from "./cli-commands/args.ts";
import { parseBackupArgs } from "./cli-commands/backup-args.ts";
import {
  dispatchContainer,
  parseContainerCommand,
} from "./cli-commands/container.ts";
import type { CommandContext } from "./cli-commands/context.ts";
import { printHelp } from "./cli-commands/help.ts";
import { parseProblemArgs } from "./problem/command.ts";
import { UsageError } from "./util/args.ts";

const ctx: CommandContext = { cwd: "/tmp" };

/** 造一个满足生产安装目录特征文件的临时目录。 */
function makeProductionDir(): string {
  const dir = Deno.makeTempDirSync({ prefix: "noj-prod-" });
  Deno.writeTextFileSync(join(dir, ".env.prod"), "");
  Deno.writeTextFileSync(join(dir, "docker-compose.prod.yml"), "");
  return dir;
}

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
    ["install", "--help"],
    ["check", "--help"],
    ["backup", "--help"],
    ["status", "--help"],
    ["start", "--help"],
    ["stop", "--help"],
    ["logs", "--help"],
    ["update", "--help"],
    ["config", "--help"],
    ["uninstall", "--help"],
    ["problem", "--help"],
    ["problem", "init", "--help"],
  ];
  for (const argv of cases) {
    assertEquals(await run(argv), EXIT_OK, argv.join(" "));
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

Deno.test("T26: 生产命令在缺少安装目录时报运行失败（1），并给出可操作提示", async () => {
  const originalErr = console.error;
  let err = "";
  console.error = (...a: unknown[]) => {
    err += a.join(" ") + "\n";
  };
  let code = -1;
  try {
    code = await run(["status", "--dir", "/nonexistent-noj-xyz"]);
  } finally {
    console.error = originalErr;
  }
  assertEquals(code, EXIT_FAILURE);
  // 提示必须指向可执行的下一步（--dir / 安装目录），而不是只报"失败"
  assertEquals(
    err.includes("--dir") || err.includes("安装目录"),
    true,
    `错误信息应给出可操作提示，实得：${err}`,
  );
});

// ── #517 E3/E4：异常兜底与可读错误 ────────────────────────────────

Deno.test("E3: --debug 下用法错误仍只给可读文案（不打印栈）", async () => {
  // 用法错误是可预期错误，即便 --debug 也只给可读文案（栈只留给未预期错误）。
  const originalErr = console.error;
  let err = "";
  console.error = (...a: unknown[]) => {
    err += a.join(" ") + "\n";
  };
  try {
    assertEquals(await run(["status", "--dir", "--debug"]), EXIT_USAGE);
  } finally {
    console.error = originalErr;
  }
  assertEquals(err.includes("--dir"), true, err);
  assertEquals(err.includes("    at "), false, "用法错误不该打印栈");
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
  // --dir 指向不存在路径 → findProductionDir 抛 ProductionDirError（退出码 1）。
  const plain = await capture([
    "status",
    "--dir",
    "/nonexistent-noj-xyz",
  ]);
  assertEquals(plain.includes("不是完整的 NOJ 生产安装目录"), true);
  assertEquals(plain.includes("    at "), false, "默认不得打印栈帧");

  const debug = await capture([
    "status",
    "--dir",
    "/nonexistent-noj-xyz",
    "--debug",
  ]);
  assertEquals(debug.includes("    at "), true, "--debug 应打印栈帧");
});

Deno.test("评审 P2: --debug 在命令名前也可用（全局选项剥离）", async () => {
  const originalErr = console.error;
  const capture = async (
    argv: string[],
  ): Promise<{ code: number; err: string }> => {
    let err = "";
    console.error = (...a: unknown[]) => {
      err += a.join(" ") + "\n";
    };
    let code = -1;
    try {
      code = await run(argv);
    } finally {
      console.error = originalErr;
    }
    return { code, err };
  };
  const base = [
    "status",
    "--dir",
    "/nonexistent-noj-xyz",
  ];
  // 前置 --debug 不得被当作顶层命令（旧行为：未知命令 → 2）
  const preDebug = await capture(["--debug", ...base]);
  assertEquals(preDebug.code, EXIT_FAILURE);
  assertEquals(
    preDebug.err.includes("    at "),
    true,
    "--debug 前置时应打印栈帧",
  );
  assertEquals(
    preDebug.err.includes("未知命令"),
    false,
    "--debug 不得被当作命令",
  );
  // 后置 --debug 同样生效
  const postDebug = await capture([...base, "--debug"]);
  assertEquals(postDebug.err.includes("    at "), true);
  // 普通命令语义不受影响：用法错误仍是 2
  const plain = await capture(["status", "--dir", "--debug"]);
  assertEquals(plain.code, EXIT_USAGE);
  assertEquals(plain.err.includes("--dir"), true);
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

Deno.test("parseBackupArgs: drill 隔离 daemon 与 report 旗标", () => {
  const a = parseBackupArgs([
    "drill",
    "x.nojbackup",
    "--report",
    "/r.json",
    "--docker-host",
    "unix:///run/noj-restore-drill/test/docker.sock",
  ]);
  assertEquals(a.sub, "drill");
  assertEquals(a.report, "/r.json");
  assertEquals(a.dockerHost, "unix:///run/noj-restore-drill/test/docker.sock");
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
// ── Tier 3 ──────────────────────────────────────────────────────

Deno.test("stripCliOwnedFlags: 剔除 --install-dir 与 --dry-run，保留容器侧 --dir", () => {
  // 评审 M1：CLI 自身的安装目录选项是 --install-dir；
  // 容器命令自己的 --dir（如 problems import --dir <包目录>）必须透传。
  assertEquals(
    stripCliOwnedFlags(["db", "migrate", "--dry-run", "--install-dir", "/opt"]),
    ["db", "migrate"],
  );
  assertEquals(
    stripCliOwnedFlags(["db", "migrate", "--install-dir=/opt"]),
    ["db", "migrate"],
  );
  // 业务参数（含容器侧 --dir）必须保留
  assertEquals(
    stripCliOwnedFlags([
      "bootstrap",
      "first-admin",
      "--username",
      "alice",
      "--dir",
      "/pkg",
    ]),
    ["bootstrap", "first-admin", "--username", "alice", "--dir", "/pkg"],
  );
});

Deno.test("评审 B2: 旗标缺值走统一兜底（用法错误 2，无栈帧）", async () => {
  const orig = console.error;
  let err = "";
  console.error = (...a: unknown[]) => {
    err += a.join(" ") + "\n";
  };
  try {
    assertEquals(await run(["status", "--dir"]), EXIT_USAGE);
  } finally {
    console.error = orig;
  }
  assertEquals(err.includes("--dir"), true);
  assertEquals(err.includes("Uncaught"), false, "不得出现未捕获异常");
  assertEquals(err.includes("    at "), false, "不得打印栈帧");
  assertEquals(err.includes("file://"), false, "不得泄露源码路径");
});

Deno.test("评审 M1: stripCliOwnedFlags 保留容器命令的 --dir", () => {
  // 容器命令自身的 --dir 必须透传
  assertEquals(
    stripCliOwnedFlags(["problems", "import", "--dir", "/pkg"]),
    ["problems", "import", "--dir", "/pkg"],
  );
  // CLI 自身的 --install-dir 与 --dry-run 被剔除
  assertEquals(
    stripCliOwnedFlags([
      "problems",
      "import",
      "--dir",
      "/pkg",
      "--install-dir",
      "/opt",
      "--dry-run",
    ]),
    ["problems", "import", "--dir", "/pkg"],
  );
  assertEquals(
    stripCliOwnedFlags(["db", "migrate", "--install-dir=/opt"]),
    ["db", "migrate"],
  );
});

Deno.test("评审 M1: parseInstallDirArg 支持两种写法", () => {
  assertEquals(parseInstallDirArg(["--install-dir", "/opt"]), "/opt");
  assertEquals(parseInstallDirArg(["--install-dir=/opt"]), "/opt");
  assertEquals(parseInstallDirArg([]), undefined);
});
Deno.test("评审: Tier 3 子命令 help 必须写 --install-dir 而非 --dir", async () => {
  // 阻塞项：help 写 --dir 但 dispatchContainer 只认 --install-dir，
  // 照 help 抄的命令会 exit 1。
  const original = console.log;
  let out = "";
  console.log = (...a: unknown[]) => {
    out += a.join(" ") + "\n";
  };
  try {
    await run(["db", "migrate", "--help"]);
  } finally {
    console.log = original;
  }
  assertEquals(
    out.includes("--install-dir <path>"),
    true,
    "help 必须宣称 --install-dir",
  );
  assertEquals(
    /--dir <path>\s+生产安装目录/.test(out),
    false,
    "help 不得再把 --dir 说成生产安装目录",
  );
  assertEquals(out.includes("原样透传"), true, "应说明 --dir 透传给容器");
});

// ── 第四轮评审修正：problem lint/pack 的 --dir 不得被 positional 覆盖 ──

Deno.test("评审: problem lint/pack 只有位置参数存在时才覆盖 --dir", () => {
  // 阻塞项：无位置参数时 out.dir = positional[0]（undefined）会覆盖 --dir，
  // 导致 lint/pack 静默改用 cwd 并返回 0（假阳性）。
  assertEquals(
    parseProblemArgs(["lint", "--dir", "/some/problem"]).dir,
    "/some/problem",
  );
  assertEquals(
    parseProblemArgs(["pack", "--dir", "/some/problem"]).dir,
    "/some/problem",
  );
  // 显式位置参数优先
  assertEquals(
    parseProblemArgs(["lint", "/positional", "--dir", "/flag"]).dir,
    "/positional",
  );
  // 两者都没有：dir 保持 undefined（由调用方回落到 cwd）
  assertEquals(parseProblemArgs(["lint"]).dir, undefined);
});
// ── #515 P6：备份 list/prune 的 CLI 契约 ─────────────────────────────

Deno.test("P6: parseBackupArgs 解析 list/prune 旗标", () => {
  const a = parseBackupArgs([
    "prune",
    "--keep",
    "3",
    "--older-than",
    "7",
    "--include-legacy",
    "--json",
  ]);
  assertEquals(a.sub, "prune");
  assertEquals(a.keep, 3);
  assertEquals(a.olderThanDays, 7);
  assertEquals(a.includeLegacy, true);
  assertEquals(a.json, true);
});

Deno.test("P6: --keep/--older-than 非法值报用法错误", () => {
  for (
    const argv of [["prune", "--keep", "x"], ["prune", "--older-than", "-1"]]
  ) {
    let threw = false;
    try {
      parseBackupArgs(argv);
    } catch (e) {
      threw = e instanceof UsageError;
    }
    assertEquals(threw, true, argv.join(" "));
  }
});

Deno.test("P6: prune 默认不 confirm（安全默认 = dry-run）", () => {
  assertEquals(parseBackupArgs(["prune"]).confirm, false);
  assertEquals(parseBackupArgs(["prune", "--confirm"]).confirm, true);
  // 默认不删旧目录格式（存量数据保护）
  assertEquals(parseBackupArgs(["prune"]).includeLegacy, false);
});

Deno.test("P6: formatBytes 人类可读", () => {
  assertEquals(formatBytes(0), "0B");
  assertEquals(formatBytes(512), "512B");
  assertEquals(formatBytes(2048), "2.0K");
  assertEquals(formatBytes(5 * 1024 * 1024), "5.0M");
});

// ── 第四轮评审修正：problem lint/pack 的 --dir 不得被 positional 覆盖 ──

Deno.test("评审: problem lint/pack 只有位置参数存在时才覆盖 --dir", () => {
  // 阻塞项：无位置参数时 out.dir = positional[0]（undefined）会覆盖 --dir，
  // 导致 lint/pack 静默改用 cwd 并返回 0（假阳性）。
  assertEquals(
    parseProblemArgs(["lint", "--dir", "/some/problem"]).dir,
    "/some/problem",
  );
  assertEquals(
    parseProblemArgs(["pack", "--dir", "/some/problem"]).dir,
    "/some/problem",
  );
  // 显式位置参数优先
  assertEquals(
    parseProblemArgs(["lint", "/positional", "--dir", "/flag"]).dir,
    "/positional",
  );
  // 两者都没有：dir 保持 undefined（由调用方回落到 cwd）
  assertEquals(parseProblemArgs(["lint"]).dir, undefined);
});
// ── 评审 B2/B3：新命令必须可从 help 发现；单数名可到达 Tier 3 ─────────

Deno.test("评审 B2: 顶层 help 必须登记 problem init/lint/pack", () => {
  // #517 E5：help 是命令清单唯一事实源；新命令不登记则用户无法发现。
  const help = printHelp();
  for (const cmd of ["problem init", "problem lint", "problem pack"]) {
    assertEquals(help.includes(cmd), true, `顶层 help 缺少 ${cmd}`);
  }
});

Deno.test("评审 B3: 单数 problem 也能到达 Tier 3 build/import", () => {
  // canonical 名是单数（core 已改名、problems 为别名），
  // 若容器包装只认复数，canonical 名就无法到达这两个命令。
  for (const sub of ["build", "import"]) {
    const singular = parseContainerCommand(["problem", sub]);
    const plural = parseContainerCommand(["problems", sub]);
    assertEquals(singular.matched, true, `problem ${sub} 必须命中 Tier 3`);
    assertEquals(plural.matched, true, `problems ${sub} 必须命中 Tier 3`);
  }
  // 本地出题子命令不得被误判为 Tier 3
  assertEquals(parseContainerCommand(["problem", "lint"]).matched, false);
  assertEquals(parseContainerCommand(["problem", "pack"]).matched, false);
  assertEquals(parseContainerCommand(["problem", "init"]).matched, false);
});

// ── #516 评审 P1/P2：drill 快照形态与错误码（集成回归） ───────────────

Deno.test("problem import: --domain 与包目录原样透传 core 容器", () => {
  assertEquals(
    stripCliOwnedFlags([
      "problem",
      "import",
      "--domain",
      "school",
      "--dir",
      "/packages",
    ]),
    ["problem", "import", "--domain", "school", "--dir", "/packages"],
  );
});

// ── P1d：maintain（维护模式/排空）的容器包装 ──────────────────────

Deno.test("P1d: maintain --help 由 CLI 回答（不要求生产目录）", async () => {
  const original = console.log;
  let out = "";
  console.log = (...a: unknown[]) => {
    out += a.join(" ") + "\n";
  };
  try {
    assertEquals(await run(["maintain", "--help"]), EXIT_OK);
  } finally {
    console.log = original;
  }
  for (
    const expected of ["maintain", "enter", "status", "wait", "exit", "--json"]
  ) {
    assertEquals(out.includes(expected), true, `help 缺少 ${expected}`);
  }
});

Deno.test("P1d: maintain 以 --no-deps 进入容器（--dry-run 可见）", async () => {
  const dir = makeProductionDir();
  const original = console.log;
  let out = "";
  console.log = (...a: unknown[]) => {
    out += a.join(" ") + "\n";
  };
  try {
    // CLI 自身选项也进入 match.args（真实分发路径如此），maintain.ts 负责剥离
    const match = parseContainerCommand([
      "maintain",
      "status",
      "--json",
      "--install-dir",
      dir,
      "--dry-run",
    ]);
    assertEquals(match.matched, true);
    assertEquals(match.noDeps, true);
    const code = await dispatchContainer(match, [
      "status",
      "--json",
      "--install-dir",
      dir,
      "--dry-run",
    ]);
    assertEquals(code, EXIT_OK);
  } finally {
    console.log = original;
    Deno.removeSync(dir, { recursive: true });
  }
  assertEquals(
    out.includes(
      "run --rm --no-deps --entrypoint /app/bin/noj core maintain status --json",
    ),
    true,
    out,
  );
});

Deno.test("P1d: maintain 未知子命令 → 宿主机用法错误（不起容器）", async () => {
  const dir = makeProductionDir();
  const originalErr = console.error;
  console.error = () => {};
  try {
    assertEquals(
      await run(["maintain", "bogus", "--install-dir", dir]),
      EXIT_USAGE,
    );
  } finally {
    console.error = originalErr;
    Deno.removeSync(dir, { recursive: true });
  }
});
