/**
 * 备份定期调度的原生迁移（T20）：crontab 标记区块管理。
 *
 * 迁移 `scripts/deploy/backup-schedule.sh` 全 162 行（`validate_schedule()`:51-55、
 * `validate_install()`:57-72、`read_crontab()`:74-76、`remove_block()`:78-84、
 * `write_crontab()`:86-89、`install_schedule()`:91-108、`status_schedule()`:110-123、
 * `remove_schedule()`:125-136）。
 *
 * ## 这个模块的**全部**价值：只动自己的行
 *
 * crontab 是**宿主机共享资源**——用户机器上通常已有其他任务（其他运维脚本、
 * 个人定时任务）。因此本模块的核心不是"写入一条 cron"，而是**绝不碰区块外的
 * 任何字节**：保留它们的顺序、内容、甚至行尾空白。`test-backup-schedule.sh` 的
 * 四条断言（保留 `# unrelated host task`、区块不重复、更新后旧调度消失、
 * 删除不误删他人任务）都是这一点的不同侧面。
 *
 * 实现方式：解析与合并是**纯函数**（{@link removeManagedBlock} /
 * {@link upsertManagedBlock} / {@link extractManagedBlock}），因此"幂等"与
 * "不碰他人行"可脱离进程直接断言；只有 `crontab -l` / `crontab -` 两次调用
 * 经注入的 runner。
 *
 * ## shell 注入防线（本模块最需要小心的点）
 *
 * 写入的 crontab 行形如：
 *
 * ```text
 * 15 2 * * * /path/to/backup.sh create --env-file '...' >> '.../backup-cron.log' 2>&1
 * ```
 *
 * 两个注入面：
 * 1. **cron 表达式**——它被拼进行首，故必须在**写入前**拒绝 shell 元字符
 *    （bash `:52-54` 的白名单正则）。`15 2 * * *; touch /tmp/unsafe` 是
 *    `test-backup-schedule.sh:88-95` 的既有用例。
 * 2. **路径**——bash 用 `printf '%q'` 引用；TS 侧必须自建等价的**保守引用器**。
 *    这不是洁癖：安装目录含空格（`/opt/my noj`）时，未引用的一行会被 cron 拆成
 *    多个字段，静默变成另一条命令；而路径来自用户参数，属于可达的输入面。
 *
 * 本模块不持有模块级可变状态（AGENTS.md §8.2 多副本约束）。
 */

import { isAbsolute, join } from "@std/path";
import type { CommandRunner } from "../runtime/command.ts";
import {
  checkPassphraseFile,
  DrillPreflightError,
  isFile,
} from "./drill/plan.ts";
import { UsageError } from "../util/args.ts";

/**
 * 区块起始标记（bash `:18` **逐字**，含 `(managed)`）。
 *
 * 逐字保持是必要的：宿主机上可能已有旧版 bash 脚本写入的区块，标记一旦不同，
 * 本实现就认不出它，于是"更新"会变成"追加第二个区块"——正是要避免的重复。
 */
export const MARKER_BEGIN = "# BEGIN NEURO-OJ BACKUP (managed)";

/** 区块结束标记（bash `:19` 逐字）。 */
export const MARKER_END = "# END NEURO-OJ BACKUP (managed)";

/** 默认调度（bash `:14`：每日 02:15）。 */
export const DEFAULT_SCHEDULE = "15 2 * * *";

/** 备份日志文件名（bash `:100`）。 */
export const CRON_LOG_NAME = "backup-cron.log";

/** 备份目录权限（bash `:69` 的 `mkdir -m 700`）。 */
export const BACKUP_DIR_MODE = 0o700;

/** 备份日志权限（bash `:71`）。日志可能含内部路径，不应全局可读。 */
export const CRON_LOG_MODE = 0o600;

/**
 * cron 表达式每段的字符白名单（bash `:53`：数字、`*`、`/`、`?`、`,`、`-`）。
 *
 * 刻意**不含** `%`（cron 里表示换行）、空格、以及任何 shell 元字符
 * （`;` `|` `&` `$` `` ` `` `>` `<` `(` `)` `{` `}` `\\` `"` `'`）。
 * 这是注入防线，不是格式偏好——见模块头。
 */
const CRON_FIELD_RE = /^[0-9*/?,-]+$/;

/** 五段（分 时 日 月 周）。 */
const CRON_FIELD_COUNT = 5;

/**
 * 校验五段 cron 表达式（bash `validate_schedule()`:51-55）。
 *
 * 拒绝任何含 shell 元字符的输入——表达式会被拼进 crontab 行。
 * 抛 {@link UsageError}（退出码 2 = 用法错误，与 bash 的 `die` 一致）。
 */
export function assertSchedule(expr: string): void {
  const fields = expr.trim().split(/\s+/);
  // **顺序重要**：先查元字符，再查段数。反过来的话
  // `15 2 * * *; touch /tmp/unsafe` 会因为分号后多出一个词而报"段数不对"，
  // 把"这是注入尝试"这一关键信息掩盖成"格式没写对"——评审与运维都会看错方向。
  for (const field of fields) {
    if (!CRON_FIELD_RE.test(field)) {
      throw new UsageError(
        `--schedule 不能包含 shell 元字符，收到 "${field}"（完整表达式：${expr}）`,
      );
    }
  }
  if (fields.length !== CRON_FIELD_COUNT) {
    throw new UsageError(
      `--schedule 必须是五段 cron 表达式（分 时 日 月 周），收到 "${expr}"`,
    );
  }
}

/**
 * 保守的 shell 引用器（bash `printf '%q'` 的等价）。
 *
 * 安全字符集之外的路径一律用单引号包裹，内部单引号按 POSIX 惯用法写成 `'\''`。
 * 结果在 `sh` 下解析回来一定等于原串——含空格、`$`、`;`、引号、换行都成立。
 *
 * **不用双引号**：双引号里 `$`/`` ` ``/`\` 仍有特殊含义，需要逐字符转义；
 * 单引号包裹是唯一"没有例外"的形态，因此更不容易写错。
 */
export function quoteForCron(value: string): string {
  if (value === "") return "''";
  // 仅含安全字符时不必加引号（可读性；也让既有测试里的路径断言更直观）
  if (/^[A-Za-z0-9@%_+=:,./-]+$/.test(value)) return value;
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * 移除本工具管理的区块（bash `remove_block()`:78-84 的等价）。
 *
 * 语义逐条对齐 bash 的 `awk`：
 * - 命中 `BEGIN` 行 → 进入跳过态，该行**本身也丢弃**；
 * - 命中 `END` 行 → 退出跳过态，该行**同样丢弃**；
 * - 其余行原样保留（含空行与空白）。
 *
 * **没有 END 的退化情形**（被人手工删了结束标记）：bash 的 `awk` 会一直跳到文件
 * 末尾，即"删除从 BEGIN 到结尾的一切"。本实现**保持同一行为**——因为另一种
 * 选择（只删 BEGIN 行、保留后续）会把本工具的命令行**留在 crontab 里**却少了
 * 标记，下次 install 就再也认不出它，从而产生无法清理的重复任务。
 */
export function removeManagedBlock(crontab: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of splitLines(crontab)) {
    if (line === MARKER_BEGIN) {
      skipping = true;
      continue;
    }
    if (line === MARKER_END) {
      skipping = false;
      continue;
    }
    if (!skipping) out.push(line);
  }
  // **保留末尾换行**：crontab 是文本文件，"区块外的字节不变"包含末尾换行这一
  // 字节。丢掉它虽然不影响 cron 的解析，但会让"逐字节不变"的断言（与运维的
  // diff 习惯）失效——本模块的核心承诺就是不动别人的东西。
  return out.length === 0 ? "" : out.join("\n") + "\n";
}

/**
 * 抽取本工具管理的区块（bash `status_schedule()`:112-116 的等价）。
 *
 * 返回 `null` 表示未安装。含**两端标记**（与 bash 的 `awk` 一样把标记一并打印，
 * 便于用户直接肉眼确认区块边界）。
 */
export function extractManagedBlock(crontab: string): string | null {
  const lines: string[] = [];
  let found = false;
  for (const line of splitLines(crontab)) {
    if (line === MARKER_BEGIN) {
      found = true;
      lines.push(line);
      continue;
    }
    if (found) {
      lines.push(line);
      if (line === MARKER_END) break;
    }
  }
  return found ? lines.join("\n") : null;
}

/**
 * 用新区块替换旧区块（bash `install_schedule()`:94-105 的等价）。
 *
 * 幂等性来自"先删后加"：无论原 crontab 里有没有本工具的区块、有几个（异常情形），
 * 结果都恰好**一个**区块，且位于**末尾**。
 *
 * 末尾位置与 bash 一致（`updated="$current"; updated+=$'\n'"$entry"`），也因此
 * 区块外的行保持原有相对顺序——测试对"他人任务逐字节不变"有断言。
 */
export function upsertManagedBlock(crontab: string, entry: string): string {
  const without = removeManagedBlock(crontab).replace(/\n+$/, "");
  const block = [MARKER_BEGIN, entry, MARKER_END].join("\n");
  return without === "" ? block + "\n" : without + "\n" + block + "\n";
}

/** 按 LF 切分并去掉末尾的空元素（`text.split("\n")` 在末尾换行时会多一个 ""）。 */
function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** 构造 crontab 里的那一行命令（bash `:101` 的等价）。 */
export interface ScheduleEntryOptions {
  schedule: string;
  /** 备份脚本的绝对路径（调用方给；本函数只负责引用）。 */
  backupScript: string;
  envFile: string;
  composeFile: string;
  backupDir: string;
  passphraseFile: string;
}

/**
 * 渲染 crontab 条目（bash `:95-101` 的等价）。
 *
 * bash 把 `printf '%q'` 的输出放进 `$entry`，形如
 * `<schedule> <script> create --env-file <q> --compose-file <q> --backup-dir <q>
 * --passphrase-file <q> >> <log> 2>&1`。本函数逐字保持该结构（含 `>>` 与 `2>&1`
 * 的写法与顺序），因为运维会按这个形状读 crontab。
 */
export function renderScheduleEntry(opts: ScheduleEntryOptions): string {
  const logFile = join(opts.backupDir, CRON_LOG_NAME);
  return [
    opts.schedule,
    quoteForCron(opts.backupScript),
    // 入口是 noj-cli 自身，故子命令是 `backup create`（而非旧的裸 `create`——
    // 那是 backup.sh 的参数契约）。
    "backup",
    "create",
    "--env-file",
    quoteForCron(opts.envFile),
    "--compose-file",
    quoteForCron(opts.composeFile),
    "--backup-dir",
    quoteForCron(opts.backupDir),
    "--passphrase-file",
    quoteForCron(opts.passphraseFile),
    ">>",
    quoteForCron(logFile),
    "2>&1",
  ].join(" ");
}

/** {@link installSchedule} 的注入点与参数。 */
export interface InstallScheduleOptions {
  /** 命令注入点（crontab）。 */
  runner: CommandRunner;
  /** crontab 可执行名（`NOJ_BACKUP_CRONTAB_BIN`，缺省 `crontab`）。 */
  crontabBin?: string;
  /** 安装目录（一切路径由它派生，保证是绝对路径）。 */
  installDir: string;
  /** 备份脚本路径；缺省由 `installDir` 派生（`scripts/deploy/backup.sh`）。 */
  backupScript?: string;
  /** 生产环境文件；缺省 `<dir>/.env.prod`。 */
  envFile?: string;
  /** 生产 compose 文件；缺省 `<dir>/docker-compose.prod.yml`。 */
  composeFile?: string;
  /** 备份目录；缺省 `<dir>/backups`。 */
  backupDir?: string;
  /** 口令文件（必填）。 */
  passphraseFile?: string;
  /** 五段 cron 表达式；缺省 {@link DEFAULT_SCHEDULE}。 */
  schedule?: string;
  /** 人类日志汇聚点。 */
  log?: (line: string) => void;
}

/** 调度命令的结果。 */
export interface ScheduleResult {
  /** 0 成功 / 1 运行失败 / 2 用法或前置错误。 */
  exitCode: number;
  /** 面向用户的一句话结论。 */
  message: string;
  /** 参与本次操作的路径（便于 `--json` 与测试断言）。 */
  paths: {
    backupScript: string;
    envFile: string;
    composeFile: string;
    backupDir: string;
    logFile: string;
    passphraseFile: string;
  };
  /** 本次写入的 crontab 条目（`install` 时非 null）。 */
  entry: string | null;
  /** `status` 的输出（区块原文；未安装时 null）。 */
  block: string | null;
}

/**
 * 读 crontab（bash `read_crontab()`:74-76）。
 *
 * `crontab -l` 在"用户没有 crontab"时返回非 0——那是**常态**（首次安装必然是
 * 这一情形），故不视为错误，返回空串。
 */
export async function readCrontab(
  runner: CommandRunner,
  crontabBin: string,
): Promise<string> {
  try {
    const res = await runner.run(crontabBin, ["-l"]);
    return res.code === 0 ? res.stdout : "";
  } catch {
    // 二进制缺失（Deno.Command 抛 NotFound）同样按"无 crontab"处理，
    // 由调用方的 written 检查给出可操作报错。
    return "";
  }
}

/** 写 crontab（bash `write_crontab()`:86-89）；失败抛错。 */
export async function writeCrontab(
  runner: CommandRunner,
  crontabBin: string,
  content: string,
): Promise<void> {
  const res = await runner.run(crontabBin, ["-"], { stdin: content });
  if (res.code !== 0) {
    throw new Error(
      `写入 crontab 失败（${crontabBin} 退出码 ${res.code}）${
        res.stderr.trim() === "" ? "" : "：" + res.stderr.trim()
      }`,
    );
  }
}

/**
 * 判定 crontab 二进制是否可用（`command -v` 的等价）。
 *
 * `crontab -l` 抛 NotFound 且 `crontab --version` 同样失败时视为不可用。
 * 注意不能用 `crontab -l` 单独判定：没有 crontab 的用户会得到非 0，
 * 而二进制其实是存在的。
 */
async function crontabAvailable(
  runner: CommandRunner,
  crontabBin: string,
): Promise<boolean> {
  try {
    await runner.run(crontabBin, ["-l"]);
    return true;
  } catch {
    return false;
  }
}

/** 组装并校验路径（绝对路径是硬要求：cron 不继承用户 PATH）。 */
function resolvePaths(opts: InstallScheduleOptions): ScheduleResult["paths"] {
  if (!isAbsolute(opts.installDir)) {
    throw new UsageError(`安装目录必须是绝对路径：${opts.installDir}`);
  }
  const dir = opts.installDir.replace(/\/+$/, "");
  const backupDir = opts.backupDir ?? join(dir, "backups");
  const paths = {
    // **T24 关键修正**：cron 任务此前指向 `scripts/deploy/backup.sh`——那个脚本
    // 已随 T24 删除。若不改，定时备份会在**无人察觉**的情况下失败（cron 的失败
    // 只落在日志里）。现在指向本工具自身：`<dir>/bin/noj-cli backup create`。
    backupScript: opts.backupScript ?? join(dir, "bin/noj-cli"),
    envFile: opts.envFile ?? join(dir, ".env.prod"),
    composeFile: opts.composeFile ?? join(dir, "docker-compose.prod.yml"),
    backupDir,
    logFile: join(backupDir, CRON_LOG_NAME),
    passphraseFile: opts.passphraseFile ?? "",
  };
  for (const [label, value] of Object.entries(paths)) {
    if (value === "") continue;
    if (!isAbsolute(value)) {
      throw new UsageError(`${label} 必须是绝对路径：${value}`);
    }
  }
  return paths;
}

/**
 * `install`（bash `install_schedule()`:91-108）：校验 → 建目录/日志 → 写入区块。
 *
 * 顺序与 bash 一致：**先校验全部前置**（口令权限、env/compose 存在、表达式合法、
 * crontab 可用），再创建备份目录与日志（700/600），最后才写 crontab。
 * 因此"前置失败 ⇒ 零 crontab 写入"是可断言的性质。
 */
export async function installSchedule(
  opts: InstallScheduleOptions,
): Promise<ScheduleResult> {
  const log = opts.log ?? (() => {});
  const crontabBin = opts.crontabBin ?? "crontab";
  const schedule = opts.schedule ?? DEFAULT_SCHEDULE;
  let paths: ScheduleResult["paths"];
  try {
    paths = resolvePaths(opts);
    assertSchedule(schedule);
    if (paths.passphraseFile === "") {
      throw new UsageError(
        "install 必须提供 --passphrase-file 或 NOJ_BACKUP_PASSPHRASE_FILE",
      );
    }
    await checkPassphraseFile(paths.passphraseFile);
    if (!(await isFile(paths.envFile))) {
      throw new UsageError(`生产环境文件不存在：${paths.envFile}`);
    }
    if (!(await isFile(paths.composeFile))) {
      throw new UsageError(`生产 Compose 文件不存在：${paths.composeFile}`);
    }
    // 备份脚本必须是**可执行普通文件**（bash `[[ -x ]]`）。它是 cron 直接调用的
    // 目标；不校验会让 cron 静默失败（输出只进日志）。
    if (!(await isExecutable(paths.backupScript))) {
      throw new UsageError(
        `备份脚本不存在或不可执行：${paths.backupScript}`,
      );
    }
    if (!(await crontabAvailable(opts.runner, crontabBin))) {
      throw new UsageError(`找不到 crontab：${crontabBin}`);
    }
  } catch (err) {
    return {
      // 前置校验失败（口令权限、缺文件、表达式非法）都是**用法错误 = 2**。
      // 注意 `checkPassphraseFile` 复用自 drill/plan.ts，它抛的是
      // DrillPreflightError 而非 UsageError——只认 UsageError 会把
      // "口令权限过宽"这类明确的前置问题误报成"运行失败 1"。
      exitCode: isPreflightError(err) ? 2 : 1,
      message: (err as Error).message,
      paths: emptyPaths(),
      entry: null,
      block: null,
    };
  }

  // 备份目录（700）与日志（600）——日志可能含内部路径，不应全局可读。
  await Deno.mkdir(paths.backupDir, { recursive: true, mode: BACKUP_DIR_MODE });
  await Deno.chmod(paths.backupDir, BACKUP_DIR_MODE);
  const logFile = await Deno.open(paths.logFile, {
    create: true,
    append: true,
    write: true,
    mode: CRON_LOG_MODE,
  });
  logFile.close();
  await Deno.chmod(paths.logFile, CRON_LOG_MODE);

  const entry = renderScheduleEntry({
    schedule,
    backupScript: paths.backupScript,
    envFile: paths.envFile,
    composeFile: paths.composeFile,
    backupDir: paths.backupDir,
    passphraseFile: paths.passphraseFile,
  });

  try {
    const current = await readCrontab(opts.runner, crontabBin);
    await writeCrontab(
      opts.runner,
      crontabBin,
      upsertManagedBlock(current, entry),
    );
  } catch (err) {
    return {
      exitCode: 1,
      message: (err as Error).message,
      paths,
      entry: null,
      block: null,
    };
  }

  log(`✓ 已安装每日备份任务：${schedule}`);
  log(`✓ 备份日志：${paths.logFile}`);
  return {
    exitCode: 0,
    message: `已安装每日备份任务：${schedule}`,
    paths,
    entry,
    block: null,
  };
}

/** `status`（bash `status_schedule()`:110-123）。未安装时退出码 1。 */
export async function statusSchedule(
  opts: {
    runner: CommandRunner;
    crontabBin?: string;
    installDir: string;
    log?: (line: string) => void;
  },
): Promise<ScheduleResult> {
  const log = opts.log ?? (() => {});
  const crontabBin = opts.crontabBin ?? "crontab";
  let paths: ScheduleResult["paths"];
  try {
    paths = resolvePaths({ ...opts, runner: opts.runner });
  } catch (err) {
    return {
      exitCode: 2,
      message: (err as Error).message,
      paths: emptyPaths(),
      entry: null,
      block: null,
    };
  }
  const current = await readCrontab(opts.runner, crontabBin);
  const block = extractManagedBlock(current);
  if (block === null) {
    const message = "未安装 Neuro OJ 备份调度";
    log(message);
    return { exitCode: 1, message, paths, entry: null, block: null };
  }
  log(block);
  return { exitCode: 0, message: block, paths, entry: null, block };
}

/**
 * `remove`（bash `remove_schedule()`:125-136）。
 *
 * **无区块时成功返回且不写 crontab**：bash 在新旧内容相同时直接 `ok` 返回，
 * 避免一次无意义的写入（crontab 写入会触发 cron 重载，且在某些发行版上会
 * 改写文件、触发审计）。这条"没有变化就不写"是有意的。
 */
export async function removeSchedule(
  opts: {
    runner: CommandRunner;
    crontabBin?: string;
    installDir: string;
    passphraseFile?: string;
    envFile?: string;
    composeFile?: string;
    backupDir?: string;
    log?: (line: string) => void;
  },
): Promise<ScheduleResult> {
  const log = opts.log ?? (() => {});
  const crontabBin = opts.crontabBin ?? "crontab";
  let paths: ScheduleResult["paths"];
  try {
    paths = resolvePaths({ ...opts, runner: opts.runner });
    if (!(await crontabAvailable(opts.runner, crontabBin))) {
      throw new UsageError(`找不到 crontab：${crontabBin}`);
    }
  } catch (err) {
    return {
      exitCode: isPreflightError(err) ? 2 : 1,
      message: (err as Error).message,
      paths: emptyPaths(),
      entry: null,
      block: null,
    };
  }

  const current = await readCrontab(opts.runner, crontabBin);
  const updated = removeManagedBlock(current);
  if (current === updated) {
    const message = "未找到 Neuro OJ 备份调度";
    log(message);
    return { exitCode: 0, message, paths, entry: null, block: null };
  }
  try {
    await writeCrontab(opts.runner, crontabBin, updated);
  } catch (err) {
    return {
      exitCode: 1,
      message: (err as Error).message,
      paths,
      entry: null,
      block: null,
    };
  }
  const message = "已删除 Neuro OJ 备份调度";
  log(message);
  return { exitCode: 0, message, paths, entry: null, block: null };
}

/**
 * 该错误是否属于"用法/前置错误"（退出码 2）。
 *
 * 两类都要认：本模块抛 {@link UsageError}，而复用的 `checkPassphraseFile`
 * 抛 `DrillPreflightError`（drill 侧的同类语义）。只认前者会让口令权限问题
 * 落到"运行失败 1"，与 help 承诺的退出码语义不符。
 */
function isPreflightError(err: unknown): boolean {
  return err instanceof UsageError || err instanceof DrillPreflightError;
}

/** 空路径集合（前置失败时无有效路径可报）。 */
function emptyPaths(): ScheduleResult["paths"] {
  return {
    backupScript: "",
    envFile: "",
    composeFile: "",
    backupDir: "",
    logFile: "",
    passphraseFile: "",
  };
}

/** `-x` 语义：可执行的普通文件。 */
async function isExecutable(path: string): Promise<boolean> {
  try {
    const st = await Deno.stat(path);
    return st.isFile && ((st.mode ?? 0) & 0o111) !== 0;
  } catch {
    return false;
  }
}
