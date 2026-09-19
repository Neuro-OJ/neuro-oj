/**
 * T20 调度测试：crontab 标记区块的幂等与"不碰他人行"。
 *
 * 全部注入 runner（crontab），**不触碰真实 crontab**。
 *
 * 本套测试的三条最高价值断言：
 * 1. **幂等**：install 两次 → 区块恰好一个；换 `--schedule` → 只有新的那条存在；
 * 2. **不碰他人行**：预置的他人任务在 install / remove 后**逐字节不变**（含顺序）；
 * 3. **注入防线**：含 shell 元字符的表达式被拒且**零 crontab 写入**——表达式会被
 *    拼进 crontab 行，这是本模块最需要小心的输入面。
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import type {
  CmdResult,
  CommandRunner,
  SpawnHandle,
} from "../runtime/command.ts";
import { makeTempDir } from "../testing/helpers.ts";
import {
  assertSchedule,
  BACKUP_DIR_MODE,
  CRON_LOG_MODE,
  CRON_LOG_NAME,
  DEFAULT_SCHEDULE,
  extractManagedBlock,
  installSchedule,
  MARKER_BEGIN,
  MARKER_END,
  quoteForCron,
  readCrontab,
  removeManagedBlock,
  removeSchedule,
  renderScheduleEntry,
  statusSchedule,
  upsertManagedBlock,
  writeCrontab,
} from "./schedule.ts";

/** 一次 crontab 调用记录。 */
interface CrontabCall {
  args: string[];
  /** 写入内容（`crontab -` 时给出）。 */
  stdin?: string;
}

/**
 * 以内存字符串模拟系统 crontab 的 fake runner。
 *
 * `writeFails` 让 `crontab -` 返回非 0；`missing` 让所有调用抛 NotFound
 * （模拟二进制不存在）；`failList` 让 `-l` 返回非 0（真实"用户无 crontab"）。
 */
function makeCrontabRunner(
  initial: string,
  opts: {
    writeFails?: boolean;
    missing?: boolean;
    failList?: boolean;
    calls?: CrontabCall[];
  } = {},
): { runner: CommandRunner; state: { content: string } } {
  const state = { content: initial };
  return {
    state,
    runner: {
      run(_cmd, args, runOpts) {
        opts.calls?.push({ args: [...args], stdin: runOpts?.stdin });
        if (opts.missing === true) {
          return Promise.reject(new Deno.errors.NotFound("crontab not found"));
        }
        if (args[0] === "-l") {
          return Promise.resolve({
            code: opts.failList === true ? 1 : 0,
            stdout: opts.failList === true ? "" : state.content,
            stderr: "",
          } as CmdResult);
        }
        if (args[0] === "-") {
          if (opts.writeFails === true) {
            return Promise.resolve({
              code: 1,
              stdout: "",
              stderr: "crontab: permission denied",
            } as CmdResult);
          }
          state.content = runOpts?.stdin ?? "";
          return Promise.resolve(
            { code: 0, stdout: "", stderr: "" } as CmdResult,
          );
        }
        return Promise.resolve(
          { code: 2, stdout: "", stderr: "" } as CmdResult,
        );
      },
      spawn(): SpawnHandle {
        throw new Error("T20 测试不 spawn");
      },
    },
  };
}

/** 建一个"完整安装目录"：备份脚本（可执行）+ .env.prod + compose。 */
async function makeInstallDir(root: string): Promise<string> {
  const dir = join(root, "install");
  await Deno.mkdir(join(dir, "scripts/deploy"), { recursive: true });
  const script = join(dir, "scripts/deploy/backup.sh");
  await Deno.writeTextFile(script, "#!/usr/bin/env bash\nexit 0\n");
  await Deno.chmod(script, 0o755);
  await Deno.writeTextFile(join(dir, ".env.prod"), "NOJ_VERSION=v0.9.5\n");
  await Deno.chmod(join(dir, ".env.prod"), 0o600);
  await Deno.writeTextFile(
    join(dir, "docker-compose.prod.yml"),
    "services: {}\n",
  );
  return dir;
}

/** 口令文件（600）。 */
async function makePassphrase(
  root: string,
  mode = 0o600,
  name = "passphrase",
): Promise<string> {
  const path = join(root, name);
  await Deno.writeTextFile(path, "x".repeat(64));
  await Deno.chmod(path, mode);
  return path;
}

/** 他人任务（含注释与两行命令；用于断言"逐字节不变"）。 */
const HOST_TASKS = [
  "# unrelated host task",
  "0 4 * * * /usr/local/bin/other-job",
  "*/5 * * * * /usr/local/bin/frequent-job --flag",
  "",
].join("\n");

// ---------------- 纯函数：区块解析与合并 ----------------

Deno.test("T20 removeManagedBlock：只删区块，他行逐字节不变", () => {
  const crontab =
    `${HOST_TASKS}${MARKER_BEGIN}\n15 2 * * * /x\n${MARKER_END}\n`;
  assertEquals(removeManagedBlock(crontab), HOST_TASKS);
});

Deno.test("T20 removeManagedBlock：无 END 时删到末尾（保持 bash awk 的行为）", () => {
  // 手工删掉 END 的退化情形：必须把本工具的命令行也删掉，否则它会以"无标记的
  // 孤儿行"永久留在 crontab 里，下次 install 再也认不出。
  const crontab = `${HOST_TASKS}${MARKER_BEGIN}\n15 2 * * * /x\n`;
  assertEquals(removeManagedBlock(crontab), HOST_TASKS);
});

Deno.test("T20 upsertManagedBlock：幂等（重复插入仍只有一个区块）", () => {
  const entry = "30 3 * * * /x create";
  const once = upsertManagedBlock(HOST_TASKS, entry);
  const twice = upsertManagedBlock(once, entry);
  assertEquals(twice, once, "第二次插入必须与原结果逐字节相同");
  assertEquals(countOccurrences(once, MARKER_BEGIN), 1);
  assertEquals(countOccurrences(once, MARKER_END), 1);
  // 区块位于末尾，他行在前且顺序不变
  assert(once.startsWith(HOST_TASKS), "他人任务必须逐字节保留在最前");
  assert(once.endsWith(`${MARKER_END}\n`));
});

Deno.test("T20 upsertManagedBlock：换 schedule 后旧条目消失（更新语义）", () => {
  const first = upsertManagedBlock(HOST_TASKS, "30 3 * * * /x create");
  const second = upsertManagedBlock(first, "45 4 * * * /x create");
  assertEquals(countOccurrences(second, MARKER_BEGIN), 1, "不得产生第二个区块");
  assertStringIncludes(second, "45 4 * * *");
  assertEquals(second.includes("30 3 * * *"), false, "旧调度必须消失");
  assert(second.startsWith(HOST_TASKS));
});

Deno.test("T20 upsertManagedBlock：空 crontab 也能正确落盘（无多余空行）", () => {
  const result = upsertManagedBlock("", "15 2 * * * /x");
  assertEquals(result, `${MARKER_BEGIN}\n15 2 * * * /x\n${MARKER_END}\n`);
});

Deno.test("T20 extractManagedBlock：含两端标记；未安装返回 null", () => {
  const crontab =
    `${HOST_TASKS}${MARKER_BEGIN}\n15 2 * * * /x\n${MARKER_END}\n`;
  const block = extractManagedBlock(crontab);
  assertEquals(block, `${MARKER_BEGIN}\n15 2 * * * /x\n${MARKER_END}`);
  assertEquals(extractManagedBlock(HOST_TASKS), null);
  assertEquals(extractManagedBlock(""), null);
});

// ---------------- 注入防线 ----------------

Deno.test("T20 assertSchedule：五段合法表达式通过", () => {
  for (
    const expr of [
      "15 2 * * *",
      "*/5 * * * *",
      "0 0 1,15 * 3",
      "0-30/5 1-23 ? * *",
      " 15 2 * * *  ",
    ]
  ) {
    assertSchedule(expr);
  }
  assertEquals(DEFAULT_SCHEDULE, "15 2 * * *");
});

Deno.test("T20 assertSchedule：shell 元字符与段数错误一律拒绝", () => {
  // 既有 bash 用例：分号注入
  for (
    const bad of [
      "15 2 * * *; touch /tmp/unsafe",
      "15 2 * * * && rm -rf /",
      "15 2 * * * | tee /tmp/x",
      "15 2 * * $(id)",
      "15 2 * * `id`",
      "15 2 * * * > /tmp/x",
      "15 2 * * *\n15 3 * * *",
      "15 2 2 * * *", // 六段
      "15 2 * *", // 四段
      "",
      "* * * * * %x", // cron 的 % 也是换行符，白名单外
    ]
  ) {
    let message = "";
    try {
      assertSchedule(bad);
    } catch (err) {
      message = (err as Error).message;
    }
    assert(message !== "", `必须拒绝：${JSON.stringify(bad)}`);
  }
});

Deno.test("T20 quoteForCron：含空格/引号/$ 的路径被安全引用", () => {
  // 安全字符集：不加引号（可读性）
  assertEquals(quoteForCron("/opt/noj/backups"), "/opt/noj/backups");
  assertEquals(quoteForCron("15 2 * * *".split(" ")[0]!), "15");
  // 含空格：必须加引号
  assertEquals(quoteForCron("/opt/my noj"), "'/opt/my noj'");
  // 含单引号：POSIX 惯用法 '\''
  assertEquals(quoteForCron("/opt/it's here"), "'/opt/it'\\''s here'");
  // 含 $ 与反引号：单引号内无特殊含义
  assertEquals(quoteForCron("/opt/$HOME/`id`"), "'/opt/$HOME/`id`'");
  assertEquals(quoteForCron(""), "''");
});

Deno.test("T20 renderScheduleEntry：结构逐字对齐 bash（含 >> 与 2>&1）", () => {
  const entry = renderScheduleEntry({
    schedule: "15 2 * * *",
    backupScript: "/opt/noj/scripts/deploy/backup.sh",
    envFile: "/opt/noj/.env.prod",
    composeFile: "/opt/noj/docker-compose.prod.yml",
    backupDir: "/opt/noj/backups",
    passphraseFile: "/etc/noj/backup-passphrase",
  });
  assertEquals(
    entry,
    "15 2 * * * /opt/noj/scripts/deploy/backup.sh create " +
      "--env-file /opt/noj/.env.prod " +
      "--compose-file /opt/noj/docker-compose.prod.yml " +
      "--backup-dir /opt/noj/backups " +
      "--passphrase-file /etc/noj/backup-passphrase " +
      ">> /opt/noj/backups/backup-cron.log 2>&1",
  );
});

Deno.test("T20 renderScheduleEntry：含空格的安装目录仍产出单一命令（引用生效）", async () => {
  const entry = renderScheduleEntry({
    schedule: "15 2 * * *",
    backupScript: "/opt/my noj/scripts/deploy/backup.sh",
    envFile: "/opt/my noj/.env.prod",
    composeFile: "/opt/my noj/docker-compose.prod.yml",
    backupDir: "/opt/my noj/backups",
    passphraseFile: "/etc/noj/backup-passphrase",
  });
  assertStringIncludes(entry, "'/opt/my noj/scripts/deploy/backup.sh'");
  assertStringIncludes(entry, "'/opt/my noj/.env.prod'");
  // `sh -c` 解析后，命令词数应等于未含空格时的词数（证明没被拆成多列）
  const words = await shellWords(entry);
  const plain = await shellWords(renderScheduleEntry({
    schedule: "15 2 * * *",
    backupScript: "/opt/noj/scripts/deploy/backup.sh",
    envFile: "/opt/noj/.env.prod",
    composeFile: "/opt/noj/docker-compose.prod.yml",
    backupDir: "/opt/noj/backups",
    passphraseFile: "/etc/noj/backup-passphrase",
  }));
  // 词数必须与"无空格安装目录"时**完全相同**——若引用失效，含空格的路径会被
  // 拆成多个词，词数就会变多（这正是要防的静默错命令）
  assertEquals(words.length, plain.length, "含空格的路径不得让一行变成多列");
  // 脚本路径必须仍是**一个**完整的词（位于 `create` 之前）
  const createAt = words.indexOf("create");
  assert(createAt > 0, "必须能找到 create 子命令");
  assertEquals(words[createAt - 1], "/opt/my noj/scripts/deploy/backup.sh");
  // 选项值同样是单一完整的词
  const envAt = words.indexOf("--env-file");
  assertEquals(words[envAt + 1], "/opt/my noj/.env.prod");
});

// ---------------- 命令面 ----------------

Deno.test("T20 install：写入区块、建日志（600）与备份目录（700），保留他人任务", async () => {
  const root = await makeTempDir();
  try {
    const dir = await makeInstallDir(root);
    const passphrase = await makePassphrase(root);
    const { runner, state } = makeCrontabRunner(HOST_TASKS);
    const result = await installSchedule({
      runner,
      installDir: dir,
      passphraseFile: passphrase,
      schedule: "30 3 * * *",
    });

    assertEquals(result.exitCode, 0, result.message);
    assertEquals(countOccurrences(state.content, MARKER_BEGIN), 1);
    assertStringIncludes(state.content, "30 3 * * *");
    assert(state.content.startsWith(HOST_TASKS), "他人任务必须逐字节保留");
    // 权限：日志 600、备份目录 700
    assertEquals(
      ((await Deno.stat(join(dir, "backups", CRON_LOG_NAME))).mode ?? 0) &
        0o777,
      CRON_LOG_MODE,
    );
    assertEquals(
      ((await Deno.stat(join(dir, "backups"))).mode ?? 0) & 0o777,
      BACKUP_DIR_MODE,
    );
    // 绝对路径被写进条目
    assertStringIncludes(state.content, join(dir, "scripts/deploy/backup.sh"));
    assertStringIncludes(state.content, passphrase);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T20 install：重复安装幂等（区块仍为 1），换 schedule 后旧条目消失", async () => {
  const root = await makeTempDir();
  try {
    const dir = await makeInstallDir(root);
    const passphrase = await makePassphrase(root);
    const { runner, state } = makeCrontabRunner(HOST_TASKS);

    await installSchedule({
      runner,
      installDir: dir,
      passphraseFile: passphrase,
      schedule: "30 3 * * *",
    });
    await installSchedule({
      runner,
      installDir: dir,
      passphraseFile: passphrase,
      schedule: "45 4 * * *",
    });

    assertEquals(countOccurrences(state.content, MARKER_BEGIN), 1);
    assertStringIncludes(state.content, "45 4 * * *");
    assertEquals(state.content.includes("30 3 * * *"), false);
    assert(state.content.startsWith(HOST_TASKS));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T20 install：危险表达式被拒且**零 crontab 写入**", async () => {
  const root = await makeTempDir();
  try {
    const dir = await makeInstallDir(root);
    const passphrase = await makePassphrase(root);
    const calls: CrontabCall[] = [];
    const { runner, state } = makeCrontabRunner(HOST_TASKS, { calls });
    const result = await installSchedule({
      runner,
      installDir: dir,
      passphraseFile: passphrase,
      schedule: "15 2 * * *; touch /tmp/unsafe",
    });

    assertEquals(result.exitCode, 2, result.message);
    assertStringIncludes(result.message, "shell 元字符");
    assertEquals(
      calls.filter((c) => c.args[0] === "-").length,
      0,
      "表达式非法时必须零 crontab 写入",
    );
    assertEquals(state.content, HOST_TASKS, "crontab 不得被改动");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T20 install：前置失败（口令/缺文件/不可执行脚本）→ 2 且零写入", async () => {
  const root = await makeTempDir();
  try {
    const dir = await makeInstallDir(root);
    const passphrase = await makePassphrase(root);

    // 1) 缺口令
    {
      const calls: CrontabCall[] = [];
      const { runner, state } = makeCrontabRunner(HOST_TASKS, { calls });
      const result = await installSchedule({ runner, installDir: dir });
      assertEquals(result.exitCode, 2);
      assertStringIncludes(result.message, "passphrase-file");
      assertEquals(calls.length, 0, "前置失败必须零 crontab 调用");
      assertEquals(state.content, HOST_TASKS);
    }

    // 2) 口令权限过宽（644）
    {
      const wide = await makePassphrase(root, 0o644, "wide-passphrase");
      const calls: CrontabCall[] = [];
      const { runner } = makeCrontabRunner(HOST_TASKS, { calls });
      const result = await installSchedule({
        runner,
        installDir: dir,
        passphraseFile: wide,
      });
      assertEquals(result.exitCode, 2);
      assertStringIncludes(result.message, "600 或 400");
      assertEquals(calls.length, 0);
    }

    // 3) 缺 .env.prod
    {
      await Deno.remove(join(dir, ".env.prod"));
      const calls: CrontabCall[] = [];
      const { runner } = makeCrontabRunner(HOST_TASKS, { calls });
      const result = await installSchedule({
        runner,
        installDir: dir,
        passphraseFile: passphrase,
      });
      assertEquals(result.exitCode, 2);
      assertStringIncludes(result.message, "生产环境文件不存在");
      assertEquals(calls.length, 0);
    }

    // 4) 备份脚本不可执行
    {
      const dir2 = await makeInstallDir(join(root, "i2"));
      await Deno.chmod(join(dir2, "scripts/deploy/backup.sh"), 0o644);
      const calls: CrontabCall[] = [];
      const { runner } = makeCrontabRunner(HOST_TASKS, { calls });
      const result = await installSchedule({
        runner,
        installDir: dir2,
        passphraseFile: passphrase,
      });
      assertEquals(result.exitCode, 2);
      assertStringIncludes(result.message, "不可执行");
      assertEquals(calls.length, 0);
    }

    // 5) 相对路径 → 拒绝（cron 不继承 PATH，必须绝对路径）
    {
      const { runner } = makeCrontabRunner(HOST_TASKS);
      const result = await installSchedule({
        runner,
        installDir: "relative/dir",
        passphraseFile: passphrase,
      });
      assertEquals(result.exitCode, 2);
      assertStringIncludes(result.message, "绝对路径");
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T20 install：无 crontab（-l 非 0）视为空，仍成功", async () => {
  const root = await makeTempDir();
  try {
    const dir = await makeInstallDir(root);
    const passphrase = await makePassphrase(root);
    const { runner, state } = makeCrontabRunner("", { failList: true });
    const result = await installSchedule({
      runner,
      installDir: dir,
      passphraseFile: passphrase,
    });
    assertEquals(result.exitCode, 0, result.message);
    assertEquals(countOccurrences(state.content, MARKER_BEGIN), 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T20 install：crontab 二进制缺失 → 2（前置，零写入）", async () => {
  const root = await makeTempDir();
  try {
    const dir = await makeInstallDir(root);
    const passphrase = await makePassphrase(root);
    const calls: CrontabCall[] = [];
    const { runner } = makeCrontabRunner("", { missing: true, calls });
    const result = await installSchedule({
      runner,
      installDir: dir,
      passphraseFile: passphrase,
    });
    assertEquals(result.exitCode, 2);
    assertStringIncludes(result.message, "找不到 crontab");
    assertEquals(calls.filter((c) => c.args[0] === "-").length, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T20 install：写入失败 → 退出码 1 并报出 crontab 的错误", async () => {
  const root = await makeTempDir();
  try {
    const dir = await makeInstallDir(root);
    const passphrase = await makePassphrase(root);
    const { runner } = makeCrontabRunner(HOST_TASKS, { writeFails: true });
    const result = await installSchedule({
      runner,
      installDir: dir,
      passphraseFile: passphrase,
    });
    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.message, "写入 crontab 失败");
    assertStringIncludes(result.message, "permission denied");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T20 status：已安装时输出区块（含两端标记）", async () => {
  const root = await makeTempDir();
  try {
    const dir = await makeInstallDir(root);
    const installed = upsertManagedBlock(HOST_TASKS, "30 3 * * * /x create");
    const { runner } = makeCrontabRunner(installed);
    const lines: string[] = [];
    const result = await statusSchedule({
      runner,
      installDir: dir,
      log: (l) => lines.push(l),
    });
    assertEquals(result.exitCode, 0);
    assertEquals(
      result.block,
      `${MARKER_BEGIN}\n30 3 * * * /x create\n${MARKER_END}`,
    );
    assertStringIncludes(lines.join("\n"), MARKER_BEGIN);
    assertStringIncludes(lines.join("\n"), MARKER_END);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T20 status：未安装 → 退出码 1 且提示可读", async () => {
  const root = await makeTempDir();
  try {
    const dir = await makeInstallDir(root);
    const { runner } = makeCrontabRunner(HOST_TASKS);
    const lines: string[] = [];
    const result = await statusSchedule({
      runner,
      installDir: dir,
      log: (l) => lines.push(l),
    });
    assertEquals(result.exitCode, 1);
    assertEquals(result.block, null);
    assertStringIncludes(result.message, "未安装 Neuro OJ 备份调度");
    assertStringIncludes(lines.join("\n"), "未安装");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T20 remove：删区块但保留他人任务；无区块时不写 crontab", async () => {
  const root = await makeTempDir();
  try {
    const dir = await makeInstallDir(root);

    // 1) 有区块 → 删除且保留他人任务
    {
      const installed = upsertManagedBlock(HOST_TASKS, "30 3 * * * /x create");
      const { runner, state } = makeCrontabRunner(installed);
      const result = await removeSchedule({ runner, installDir: dir });
      assertEquals(result.exitCode, 0);
      assertStringIncludes(result.message, "已删除");
      assertEquals(state.content.includes("NEURO-OJ BACKUP"), false);
      assertEquals(state.content, HOST_TASKS, "他人任务必须逐字节保留");
    }

    // 2) 无区块 → 成功且**不调用** crontab -
    {
      const calls: CrontabCall[] = [];
      const { runner, state } = makeCrontabRunner(HOST_TASKS, { calls });
      const result = await removeSchedule({ runner, installDir: dir });
      assertEquals(result.exitCode, 0);
      assertStringIncludes(result.message, "未找到");
      assertEquals(
        calls.filter((c) => c.args[0] === "-").length,
        0,
        "无变化时不得触发无意义的 crontab 写入",
      );
      assertEquals(state.content, HOST_TASKS);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T20 remove：crontab 缺失 → 2；写入失败 → 1", async () => {
  const root = await makeTempDir();
  try {
    const dir = await makeInstallDir(root);
    const installed = upsertManagedBlock(HOST_TASKS, "30 3 * * * /x create");

    {
      const { runner } = makeCrontabRunner(installed, { missing: true });
      const result = await removeSchedule({ runner, installDir: dir });
      assertEquals(result.exitCode, 2);
      assertStringIncludes(result.message, "找不到 crontab");
    }
    {
      const { runner } = makeCrontabRunner(installed, { writeFails: true });
      const result = await removeSchedule({ runner, installDir: dir });
      assertEquals(result.exitCode, 1);
      assertStringIncludes(result.message, "写入 crontab 失败");
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T20 readCrontab/writeCrontab：直连原语的错误传播", async () => {
  const { runner, state } = makeCrontabRunner("seed\n");
  assertEquals(await readCrontab(runner, "crontab"), "seed\n");
  await writeCrontab(runner, "crontab", "new\n");
  assertEquals(state.content, "new\n");
  await assertRejects(
    () =>
      writeCrontab(
        makeCrontabRunner("", { writeFails: true }).runner,
        "crontab",
        "x",
      ),
    Error,
    "写入 crontab 失败",
  );
  // 缺失二进制：读返回空串（按"无 crontab"处理）
  assertEquals(
    await readCrontab(
      makeCrontabRunner("", { missing: true }).runner,
      "crontab",
    ),
    "",
  );
});

Deno.test("T20 install：备份目录/日志已存在时不报错（幂等前置）", async () => {
  const root = await makeTempDir();
  try {
    const dir = await makeInstallDir(root);
    const passphrase = await makePassphrase(root);
    // 预置一个 700 的备份目录与 600 的日志
    await Deno.mkdir(join(dir, "backups"), { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(join(dir, "backups", CRON_LOG_NAME), "old log\n");
    await Deno.chmod(join(dir, "backups", CRON_LOG_NAME), 0o600);

    const { runner } = makeCrontabRunner(HOST_TASKS);
    const result = await installSchedule({
      runner,
      installDir: dir,
      passphraseFile: passphrase,
    });
    assertEquals(result.exitCode, 0, result.message);
    // 既有日志内容保留（append 打开，不截断）
    assertStringIncludes(
      await Deno.readTextFile(join(dir, "backups", CRON_LOG_NAME)),
      "old log",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------- 辅助 ----------------

/** 计数子串出现次数。 */
function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let at = 0;
  for (;;) {
    const idx = text.indexOf(needle, at);
    if (idx === -1) break;
    count++;
    at = idx + needle.length;
  }
  return count;
}

/**
 * 用 `sh` 把一行按 shell 规则切成词（验证引用正确性）。
 *
 * 两个坑（都实测踩过）：
 * 1. **待切分的行不能放进脚本文本**：外层 shell 会先展开 `$1`、反引号之类，
 *    测试本身就变成注入演示。故经 **base64 + argv** 传入（base64 只含
 *    `[A-Za-z0-9+/=]`，既无展开面也无引号面）。
 * 2. **不能直接 `eval` 整行**：行里有 `>> ... 2>&1`，eval 会**真的执行重定向**
 *    （实测报"没有那个文件或目录"）。因此只对**命令之前的部分**做词切分——
 *    本测试要验证的正是"路径引用是否让每个词保持完整"，重定向不是被测对象。
 */
async function shellWords(line: string): Promise<string[]> {
  // 只取到 `>>` 之前（词切分语义不受其影响）
  const head = line.split(" >> ")[0]!;
  const payload = base64(new TextEncoder().encode(head));
  // `set -f` 关闭 glob：cron 表达式里的 `* * *` 会被 glob 展开成当前目录的文件名
  // （实测踩到：words[1] 变成 "2"、词数暴涨）。本测试验证的是**引用的正确性**，
  // 不是 glob 语义，故关掉它让词切分确定。
  const script = [
    'line=$(printf %s "$1" | base64 -d)',
    "set -f",
    'eval "set -- $line"',
    'printf "%s\\n" "$@"',
  ].join("; ");
  const cmd = new Deno.Command("sh", {
    args: ["-c", script, "noj-words", payload],
    stdout: "piped",
    stderr: "null",
  });
  const out = await cmd.output();
  return new TextDecoder().decode(out.stdout).split("\n").filter((l) =>
    l !== ""
  );
}

/** 标准库 base64 编码（测试辅助）。 */
function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
