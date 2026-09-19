/**
 * 生产命令的 CLI 接线层（T24）：参数解析 → 调用原生实现。
 *
 * ## 本模块存在的唯一理由（R1 收口）
 *
 * T12–T21 交付了全部生产命令的**原生实现**（`prod/lifecycle.ts`、`prod/backup/*`、
 * `prod/drill/*`、`prod/schedule.ts`、`prod/judge/*`），但它们此前**没有接线**：
 * `cli.ts` 把 `PRODUCTION_COMMANDS` 整体转发给 `bash production.sh`
 * （旧 `production.ts:112`）——那是 `noj-cli/src` 内**唯一**的 R1 违例，
 * 也是"纯 TS 重写"最后一块非 TS 拼图。
 *
 * 本模块把那层转发换成真实调用：
 *
 * ```text
 * 旧：noj-cli status → bash <dir>/scripts/deploy/production.sh status → deploy.sh
 * 新：noj-cli status → prod/lifecycle.ts:status → docker compose ps
 * ```
 *
 * ## 边界
 *
 * 1. **只解析参数与装配依赖**：命令语义一律在 `prod/` 的原生实现里，本模块不复制
 *    任何判定（例如"已 running 时 up 是 no-op"只在 `lifecycle.ts`）。
 * 2. **一切外部访问可注入**：`runner`/`io`/`fetcher`/`isTty` 都可替换，因此
 *    `cli_test` 断言"调到原生实现且不 spawn bash"时不起容器。
 * 3. **`--json` 由原生实现负责**：它们已实现 T6 契约（stdout 只含 JSON），
 *    本模块不得再把人类文字写进 stdout。
 *
 * 本模块不持有模块级可变状态（AGENTS.md §8.2 多副本约束）。
 */

import { join } from "@std/path";
import type { CommandRunner } from "../runtime/command.ts";
import { realRunner } from "../runtime/command.ts";
import { realIO } from "../tui/io.ts";
import type { PromptIO } from "../tui/io.ts";
import { UsageError } from "../util/args.ts";
import { DEFAULT_UPDATE_REPOSITORY } from "./release.ts";
import type { Fetcher } from "./bootstrap.ts";
import { PROD_COMPOSE_FILE, PROD_ENV_FILE } from "./compose.ts";
import {
  install,
  type InstallResult,
  logs,
  type LogsResult,
  restart,
  start,
  status,
  type StatusResult,
  stop,
  uninstall,
  type UninstallResult,
  update,
  type UpdateResult,
} from "./lifecycle.ts";
import type { LifecycleBaseResult } from "./lifecycle.ts";
import {
  type BackupPruneResult,
  type BackupVerifyResult,
  listBackupCommand,
  prodBackupDir,
  pruneCommand,
  restorePlan,
  type RestoreStep,
  verifyCommand,
} from "./backup/commands.ts";
import {
  createContainer,
  type CreateContainerResult,
} from "./backup/container.ts";
import { createProdPayloadOps, realRawDriver } from "./backup/driver.ts";
import { installSchedule, removeSchedule, statusSchedule } from "./schedule.ts";
import type { ScheduleResult } from "./schedule.ts";
import { readEnvValues } from "./drill/plan.ts";
import { DEFAULT_REPOSITORY } from "./install-defaults.ts";

/** 所有生产命令的公共注入点（测试用 fake，生产用真实实现）。 */
export interface ProdCliDeps {
  /** 命令注入点（docker/cosign/lsof/crontab）。 */
  runner?: CommandRunner;
  /** 交互通道（install 向导、uninstall 确认、judge 向导）。 */
  io?: PromptIO;
  /** `isTty` 判定；缺省 `Deno.stdin.isTerminal()`。 */
  isTty?: () => boolean;
  /** Release 资产下载器；缺省全局 fetch。 */
  fetcher?: Fetcher;
  /** 进程环境快照；缺省 `Deno.env.toObject()`。 */
  processEnv?: Record<string, string>;
  /** 人类输出汇聚点（供测试捕获；缺省直写进程流）。 */
  out?: (text: string) => void;
  /** 诊断输出汇聚点（缺省 stderr）。 */
  err?: (text: string) => void;
  /** 时间源（测试注入）。 */
  now?: () => Date;
}

/** 生产命令的解析结果：`--dir` 与其余参数分开。 */
export interface ProdArgs {
  /** `--dir <path>` / `--dir=<path>`；未给出为 undefined。 */
  dir: string | undefined;
  /** 其余参数（原样交给本命令的解析逻辑）。 */
  rest: string[];
}

/**
 * 拆出 `--dir`（T23 后 CLI 只剩这一种目录旗标）。
 *
 * **只认 `--dir`**：`--install-dir` 是 Tier 3 容器命令的旗标（指宿主机安装目录），
 * 在生产命令上出现应报错而不是被悄悄吞掉——静默吞掉会让用户以为它生效了。
 */
export function parseProdArgs(args: string[]): ProdArgs {
  let dir: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--dir") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError("--dir 需要一个目录路径");
      }
      dir = value;
      i++;
      continue;
    }
    if (arg.startsWith("--dir=")) {
      const value = arg.slice("--dir=".length);
      if (value === "") throw new UsageError("--dir 需要一个目录路径");
      dir = value;
      continue;
    }
    if (arg === "--install-dir" || arg.startsWith("--install-dir=")) {
      throw new UsageError(
        "--install-dir 是 Tier 3 容器命令的旗标；生产命令请使用 --dir <安装目录>",
      );
    }
    rest.push(arg);
  }
  return { dir, rest };
}

/** `--json` 是否开启（原生实现自己也会判，这里只为统一读取）。 */
export function hasJson(args: string[]): boolean {
  return args.includes("--json");
}

/** 取 `--flag value` 或 `--flag=value` 的值。 */
export function flagValue(
  args: string[],
  name: string,
): string | undefined {
  const eq = `${name}=`;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === name) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`${name} 需要一个值`);
      }
      return value;
    }
    if (arg.startsWith(eq)) {
      const value = arg.slice(eq.length);
      if (value === "") throw new UsageError(`${name} 需要一个值`);
      return value;
    }
  }
  return undefined;
}

/** 取布尔旗标（支持 `-y` 这类短名）。 */
export function hasFlag(args: string[], ...names: string[]): boolean {
  return args.some((a) => names.includes(a));
}

/** 位置参数（跳过所有 `--xxx` 与它们的值）。 */
export function positionals(args: string[]): string[] {
  const out: string[] = [];
  const valueTaking = new Set([
    "--dir",
    "--env-file",
    "--compose-file",
    "--backup-dir",
    "--passphrase-file",
    "--panel",
    "--tail",
    "--schedule",
    "--project-name",
    "--subnet",
    "--report",
    "--rpo-max-hours",
    "--rto-max-minutes",
    "--zstd-level",
    "--keep",
    "--retention-days",
    "--ref",
  ]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      out.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      // `--flag=value` 自带值；`--flag value` 跳过下一个
      if (!arg.includes("=") && valueTaking.has(arg)) i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}

/** 装配公共依赖（缺省值即生产路径）。 */
export function prodDeps(deps: ProdCliDeps): {
  runner: CommandRunner;
  io: PromptIO;
  isTty: () => boolean;
  processEnv: Record<string, string>;
} {
  return {
    runner: deps.runner ?? realRunner(),
    io: deps.io ?? realIO(),
    isTty: deps.isTty ?? (() => Deno.stdin.isTerminal()),
    processEnv: deps.processEnv ?? Deno.env.toObject(),
  };
}

/** 生产命令的执行结果（统一形状，供 CLI 转退出码）。 */
export interface ProdCliResult {
  /** 0 / 1 / 2。 */
  exitCode: number;
  /** 面向用户的结论（人类模式打印；`--json` 时不打印）。 */
  message: string;
}

// ---------------- 各命令 ----------------

/** `check`：配置与依赖校验（复用 `lifecycle/steps.ts:prepareAndCheck` 六步）。 */
export async function runProdCheck(
  dir: string,
  _args: string[],
  deps: ProdCliDeps,
): Promise<ProdCliResult> {
  const d = prodDeps(deps);
  const { prepareAndCheck } = await import("./lifecycle/steps.ts");
  const prepared = await prepareAndCheck({
    dir,
    runner: d.runner,
    write: (text) => d.io.write(text + "\n"),
  });
  if (!prepared.ok) return { exitCode: 1, message: prepared.error };
  return { exitCode: 0, message: "生产配置检查通过" };
}

/** `install`：唯一生产安装路径（T12）。 */
export async function runProdInstall(
  dir: string,
  args: string[],
  deps: ProdCliDeps,
): Promise<ProdCliResult> {
  const d = prodDeps(deps);
  const result: InstallResult = await install({
    dir,
    repository: flagValue(args, "--repo") ?? DEFAULT_REPOSITORY,
    ref: flagValue(args, "--ref") ?? flagValue(args, "--version") ??
      d.processEnv["NOJ_DEPLOY_DEFAULT_VERSION"] ?? "main",
    io: d.io,
    runner: d.runner,
    fetcher: deps.fetcher,
    isTty: d.isTty(),
    nonInteractive: hasFlag(args, "--non-interactive"),
    passphraseFile: flagValue(args, "--passphrase-file"),
    processEnv: d.processEnv,
    now: deps.now?.(),
  });
  return { exitCode: 0, message: `生产部署完成（${result.dir}）` };
}

/** `status`（T13：含 T4 状态机）。 */
export function runProdStatus(
  dir: string,
  args: string[],
  deps: ProdCliDeps,
): Promise<StatusResult> {
  return status({
    dir,
    runner: prodDeps(deps).runner,
    args,
    io: renderIOOf(deps),
  });
}

/** `start` / `stop` / `restart`（T13：含 no-op 判定）。 */
export function runProdStart(
  dir: string,
  args: string[],
  deps: ProdCliDeps,
): Promise<LifecycleBaseResult> {
  const d = prodDeps(deps);
  return start({ dir, runner: d.runner, args, io: renderIOOf(deps) });
}

/** `stop`。 */
export function runProdStop(
  dir: string,
  args: string[],
  deps: ProdCliDeps,
): Promise<LifecycleBaseResult> {
  const d = prodDeps(deps);
  return stop({ dir, runner: d.runner, args, io: renderIOOf(deps) });
}

/** `restart`。 */
export function runProdRestart(
  dir: string,
  args: string[],
  deps: ProdCliDeps,
): Promise<LifecycleBaseResult> {
  const d = prodDeps(deps);
  return restart({ dir, runner: d.runner, args, io: renderIOOf(deps) });
}

/** `logs`（T14：着色契约 + `--follow` 走 stream）。 */
export function runProdLogs(
  dir: string,
  args: string[],
  deps: ProdCliDeps,
): Promise<LogsResult> {
  const d = prodDeps(deps);
  return logs({
    dir,
    runner: d.runner,
    args,
    io: renderIOOf(deps),
    services: positionals(args),
    follow: hasFlag(args, "--follow", "-f"),
    env: d.processEnv,
  });
}

/**
 * `update` / `upgrade`（T16）。
 *
 * **接线 T16 登记的 carry-forward**：`UpdateOptions.backup` 是**必填注入点**
 * （未注入即明确失败，而不是静默跳过备份）。这里接上 `prod/backup` 的真实实现——
 * "升级前必须备份"这条门禁因此真正生效。
 */
export async function runProdUpdate(
  dir: string,
  args: string[],
  deps: ProdCliDeps,
  upgradeAlias = false,
): Promise<UpdateResult> {
  const d = prodDeps(deps);
  const passphraseFile = flagValue(args, "--passphrase-file");
  return await update({
    dir,
    runner: d.runner,
    args,
    io: renderIOOf(deps),
    latest: upgradeAlias ? false : hasFlag(args, "--latest"),
    repository: d.processEnv["NOJ_UPDATE_REPOSITORY"],
    apiUrl: d.processEnv["NOJ_UPDATE_API_URL"],
    fetcher: deps.fetcher,
    passphraseFile,
    processEnv: d.processEnv,
    now: deps.now?.(),
    warn: (message) => (deps.err ?? ((t: string) => console.error(t)))(message),
    // T16 的注入点：真实备份（此前留空 → 明确失败）
    backup: (ctx) => runUpgradeBackup(d, ctx, passphraseFile, deps),
    // `--files-only` 语义的部署文件同步：缺省走 T9 downloadReleaseFiles
    syncFiles: undefined,
  });
}

/** 升级前备份的装配（`backup create` 的原生实现）。 */
async function runUpgradeBackup(
  _d: { runner: CommandRunner; processEnv: Record<string, string> },
  ctx: {
    dir: string;
    version: string;
    envFile: string;
    passphraseFile: string;
  },
  passphraseFile: string | undefined,
  deps: ProdCliDeps,
): Promise<{ ok: boolean; path: string | null; error: string | null }> {
  try {
    const created = await runBackupCreate(ctx.dir, {
      passphraseFile: passphraseFile ?? ctx.passphraseFile,
      args: [],
      deps,
    });
    return { ok: true, path: created.path, error: null };
  } catch (err) {
    return { ok: false, path: null, error: (err as Error).message };
  }
}

/** `uninstall`（T15：确认词 + 数据卷安全 + 工作区保护）。 */
export function runProdUninstall(
  dir: string,
  args: string[],
  deps: ProdCliDeps,
): Promise<UninstallResult> {
  const d = prodDeps(deps);
  const tty = d.isTty();
  return uninstall({
    dir,
    runner: d.runner,
    args,
    io: renderIOOf(deps),
    yes: hasFlag(args, "--yes", "-y"),
    all: hasFlag(args, "--all"),
    isTty: tty,
    processEnv: d.processEnv,
    // T15 carry-forward：确认读取缺省不读真实 stdin（绝不放行破坏性操作）。
    // 这里由 CLI 层接上真实 PromptIO——**仅在有 TTY 时**（无 TTY 时 uninstall
    // 自己会硬错误，接上读取器反而会掩盖那条可操作提示）。
    readConfirm: tty ? (prompt: string) => d.io.readLine(prompt) : undefined,
  });
}

// ---------------- backup 子命令 ----------------

/** 把 `RenderIO` 从注入的 out/err 构造出来（未注入即缺省，由 render 层直写进程流）。 */
function renderIOOf(deps: ProdCliDeps): import("../output/render.ts").RenderIO {
  const io: import("../output/render.ts").RenderIO = {};
  if (deps.out !== undefined) io.stdout = deps.out;
  if (deps.err !== undefined) io.stderr = deps.err;
  return io;
}

/** `backup create` 的选项（在 CLI 旗标之上再暴露 `args` 便于测试注入）。 */
export interface BackupCreateCliOptions {
  passphraseFile?: string;
  backupDir?: string;
  zstdLevel?: number;
  noEncrypt?: boolean;
  args: string[];
  deps: ProdCliDeps;
}

/**
 * `backup create`（T17 的 `createContainer` 的**命令级装配**）。
 *
 * T17 交付了容器层（`createContainer` + `createProdPayloadOps`），T18 交付了
 * verify/list/prune/restore，但 `create` 的装配此前**只有测试里做过**
 * （`commands_test.ts` 用 fake ops 造容器）。本函数把生产装配补齐：
 * 读 `.env.prod` → 构造 prod-raw 操作集 → 采集 → 打包加密 → 写 sidecar。
 *
 * `migrationStatus` 在 `create` 时**不查库**（那是 T19 drill 的职责：
 * drill 要与快照比对迁移版本）。这里记录"待核对"标记，与 bash
 * `record_migration_status` 在库不可达时的 `migration-status-unavailable` 同义。
 */
export async function runBackupCreate(
  dir: string,
  opts: BackupCreateCliOptions,
): Promise<CreateContainerResult> {
  const d = prodDeps(opts.deps);
  const envFile = join(dir, PROD_ENV_FILE);
  const composeFile = join(dir, PROD_COMPOSE_FILE);
  const backupDir = opts.backupDir ?? prodBackupDir(dir);
  const passphraseFile = opts.passphraseFile;
  const env = await readEnvValues(envFile);

  const ops = createProdPayloadOps({
    runner: d.runner,
    driver: realRawDriver(d.runner),
    compose: {
      composeFile,
      envFile,
      dockerBin: d.processEnv["NOJ_DEPLOY_DOCKER_BIN"] ?? "docker",
      judge: true,
      noAnsi: true,
    },
    env,
  });

  return await createContainer({
    backupDir,
    // staging 与产物同目录：跨目录 rename 可能退化为拷贝并丢失原子性
    stagingParent: backupDir,
    passphraseFile,
    noEncrypt: opts.noEncrypt === true,
    zstdLevel: opts.zstdLevel,
    envFile,
    postgresDatabase: env["POSTGRES_DB"] ?? "noj",
    migrationStatus: "migration-status-unavailable",
    ops,
    now: opts.deps.now?.(),
  });
}

/** `backup verify`（T18 三档）。 */
export async function runBackupVerify(
  _dir: string,
  args: string[],
  deps: ProdCliDeps,
): Promise<BackupVerifyResult> {
  const snapshot = positionals(args)[0];
  if (snapshot === undefined) {
    throw new UsageError("backup verify 需要 <snapshot> 路径");
  }
  const d = prodDeps(deps);
  const work = await Deno.makeTempDir({ prefix: "noj-verify-" });
  try {
    return await verifyCommand({
      path: snapshot,
      workDir: work,
      passphraseFile: flagValue(args, "--passphrase-file"),
      encrypted: !hasFlag(args, "--no-encrypt"),
      deep: hasFlag(args, "--deep"),
      payloadSha: hasFlag(args, "--payload-sha"),
      ops: {
        gpgDecrypt: (src, dest, pass) => gpgDecrypt(d.runner, src, dest, pass),
        untarZst: (src, destDir) => untarZst(d.runner, src, destDir),
      },
    });
  } finally {
    await Deno.remove(work, { recursive: true }).catch(() => {});
  }
}

/** `backup list`（T18）。 */
export function runBackupList(
  dir: string,
  args: string[],
  deps: ProdCliDeps,
): Promise<import("./backup/commands.ts").BackupListResult> {
  const d = prodDeps(deps);
  void d;
  const backupDir = flagValue(args, "--backup-dir") ?? prodBackupDir(dir);
  return listBackupCommand(backupDir);
}

/**
 * `backup prune`（T18：**默认 dry-run**）。
 *
 * `--confirm` 才真正删除——这条安全默认在 `pruneCommand` 里，本函数只透传。
 */
export function runBackupPrune(
  dir: string,
  args: string[],
  deps: ProdCliDeps,
): Promise<BackupPruneResult> {
  void deps;
  const backupDir = flagValue(args, "--backup-dir") ?? prodBackupDir(dir);
  const keepRaw = flagValue(args, "--keep");
  const olderRaw = flagValue(args, "--older-than");
  return pruneCommand(backupDir, {
    keep: keepRaw === undefined ? undefined : Number(keepRaw),
    olderThanDays: olderRaw === undefined ? undefined : Number(olderRaw),
    includeLegacy: hasFlag(args, "--include-legacy"),
    confirm: hasFlag(args, "--confirm"),
  });
}

/** `backup restore --dry-run`（T18：无副作用）。 */
export async function runBackupRestorePlan(
  _dir: string,
  args: string[],
  deps: ProdCliDeps,
): Promise<{ steps: RestoreStep[]; verified: boolean; summary: string }> {
  const snapshot = positionals(args)[0];
  if (snapshot === undefined) {
    throw new UsageError("backup restore 需要 <snapshot> 路径");
  }
  const d = prodDeps(deps);
  const work = await Deno.makeTempDir({ prefix: "noj-restore-plan-" });
  try {
    const plan = await restorePlan({
      path: snapshot,
      workDir: work,
      passphraseFile: flagValue(args, "--passphrase-file"),
      encrypted: !hasFlag(args, "--no-encrypt"),
      restoreEnv: flagValue(args, "--restore-env"),
      bucket: undefined,
      ops: {
        gpgDecrypt: (src, dest, pass) => gpgDecrypt(d.runner, src, dest, pass),
        untarZst: (src, destDir) => untarZst(d.runner, src, destDir),
      },
    });
    return {
      steps: plan.steps,
      verified: plan.verified,
      summary: plan.summary,
    };
  } finally {
    await Deno.remove(work, { recursive: true }).catch(() => {});
  }
}

/** `backup schedule`（T20）。 */
export async function runBackupSchedule(
  dir: string,
  args: string[],
  deps: ProdCliDeps,
): Promise<ScheduleResult> {
  const d = prodDeps(deps);
  const sub = positionals(args)[0] ?? "status";
  const crontabBin = d.processEnv["NOJ_BACKUP_CRONTAB_BIN"];
  const common = {
    runner: d.runner,
    crontabBin,
    installDir: dir,
    envFile: join(dir, PROD_ENV_FILE),
    composeFile: join(dir, PROD_COMPOSE_FILE),
    backupDir: flagValue(args, "--backup-dir") ?? prodBackupDir(dir),
    passphraseFile: flagValue(args, "--passphrase-file") ??
      d.processEnv["NOJ_BACKUP_PASSPHRASE_FILE"],
    log: (line: string) => (deps.out ?? ((t: string) => console.log(t)))(line),
  };
  switch (sub) {
    case "install":
      return await installSchedule({
        ...common,
        schedule: flagValue(args, "--schedule"),
      });
    case "remove":
      return await removeSchedule(common);
    case "status":
      return await statusSchedule(common);
    default:
      throw new UsageError(
        `backup schedule 需要子命令 install/status/remove，收到 "${sub}"`,
      );
  }
}

// ---------------- gpg / tar 薄封装（供 backup 命令复用） ----------------

/** `gpg --decrypt`（供 verify/restore 解包容器）。 */
export async function gpgDecrypt(
  runner: CommandRunner,
  src: string,
  dest: string,
  passphraseFile: string,
): Promise<void> {
  const res = await runner.run("gpg", [
    "--batch",
    "--yes",
    "--pinentry-mode",
    "loopback",
    "--passphrase-file",
    passphraseFile,
    "--decrypt",
    "--output",
    dest,
    src,
  ]);
  if (res.code !== 0) throw new Error(`gpg 解密失败：${res.stderr.trim()}`);
}

/** `tar -I zstd -xf`（供 verify/restore 解包容器）。 */
export async function untarZst(
  runner: CommandRunner,
  src: string,
  destDir: string,
): Promise<void> {
  await Deno.mkdir(destDir, { recursive: true });
  const res = await runner.run("tar", [
    "-I",
    "zstd",
    "-xf",
    src,
    "-C",
    destDir,
  ]);
  if (res.code !== 0) throw new Error(`tar 解包失败：${res.stderr.trim()}`);
}

/** 供测试引用（避免重复字面量）。 */
export { DEFAULT_UPDATE_REPOSITORY };
