/** `backup` 子命令：create / verify / list / prune / restore / schedule 的命令级装配。 */

import { join } from "@std/path";
import type { CommandRunner } from "../../runtime/command.ts";
import { UsageError } from "../../util/args.ts";
import { PROD_COMPOSE_FILE, PROD_ENV_FILE } from "../compose.ts";
import {
  type BackupPruneResult,
  type BackupVerifyResult,
  listBackupCommand,
  prodBackupDir,
  pruneCommand,
  restoreConfirmed,
  restorePlan,
  type RestoreStep,
  verifyCommand,
} from "../backup/commands.ts";
import {
  createContainer,
  type CreateContainerResult,
} from "../backup/container.ts";
import { pruneBackups } from "../backup/list.ts";
import { createProdPayloadOps, realRawDriver } from "../backup/driver.ts";
import { writeBackupMetrics } from "../backup/metrics.ts";
import type { ContainerPayloadOps } from "../backup/container.ts";
import {
  installSchedule,
  removeSchedule,
  statusSchedule,
} from "../schedule.ts";
import type { ScheduleResult } from "../schedule.ts";
import { readEnvValues } from "../drill/plan.ts";
import { gpgDecrypt, untarZst } from "../gpg-tar.ts";
import {
  flagValue,
  hasFlag,
  hasJson,
  optionalCount,
  positionals,
} from "./args.ts";
import { prodDeps, resolveBackupPassphrase } from "./deps.ts";
import type { ProdCliDeps } from "./types.ts";

/**
 * 去掉目录路径的尾随斜杠（根路径除外）。
 *
 * 用途：`backup create` 的 `excludePaths` 与 `listBackups` 拼出的路径必须逐字符
 * 一致，否则"刚创建的那份"保护会静默失效（2026-09-23 复审实测：
 * `--backup-dir /x/` 时 `excludePaths` 完全失配）。
 */
export function normalizeDir(path: string): string {
  if (path.length <= 1) return path;
  return path.replace(/\/+$/, "");
}

/** 校验一个非负整数旗标（未给或非法时的报错口径与 bash `check_numbers` 一致）。 */
function assertNonNegative(value: number, flag: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new UsageError(`${flag} 必须是非负整数，收到 "${value}"`);
  }
  return value;
}

/**
 * 探测目录可用字节数（`df -Pk <dir>` 的等价，经注入 runner）。
 *
 * 与 `drill/plan.ts:probeFreeBytes` 同源，但这里返回**字节**且无法探测时返回
 * `Infinity`（放行）——空间守卫的语义是"明显不足才拒绝"，而不是因为
 * `df` 不可用就拒绝一切备份。
 */
async function probeDirFreeBytes(
  runner: CommandRunner,
  dir: string,
): Promise<number> {
  try {
    const res = await runner.run("df", ["-Pk", dir]);
    if (res.code !== 0) return Number.POSITIVE_INFINITY;
    const lines = res.stdout.trim().split("\n");
    const cols = lines[lines.length - 1]?.split(/\s+/) ?? [];
    const availKb = Number(cols[3]);
    return Number.isFinite(availKb) ? availKb * 1024 : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * 读迁移状态（迁移 bash `record_migration_status`，backup.sh:172-185）。
 *
 * ## 为什么必须真查（评审发现的 Critical）
 *
 * 此前这里硬编码 `"migration-status-unavailable"`，而 `drill` 把
 * `migration-status.txt` 的内容与**真实查询结果**比对并要求相等：
 *
 * ```
 * if (actual !== expected) throw new Error("数据核对失败：迁移版本与快照不一致");
 * ```
 *
 * 于是一个常量字符串**永远不可能**等于真实的 `hash:created_at` 列表 →
 * **`backup drill` 对 `backup create` 产出的任何快照都必然失败**（实测退出码 1）。
 * 即"我们真的能恢复吗"这个唯一保证，对唯一受支持的快照形态**不可达**。
 *
 * ## 语义（逐条对照 bash）
 *
 * 1. 先问 `to_regclass('drizzle.__drizzle_migrations')` 是否存在该表；
 * 2. 不存在/为空 → `not-initialized`（drill 视其为"快照缺少迁移记录"）；
 * 3. 存在 → `hash:created_at` 按 `created_at` 排序，**逐字**与 drill 的查询一致
 *    （两边都必须是 `hash || ':' || created_at::text`，否则永远不相等）；
 * 4. 查询失败 → `migration-status-unavailable`（bash 的同名回退值）。
 */
async function readMigrationStatus(
  runner: CommandRunner,
  composeFile: string,
  envFile: string,
  env: Record<string, string | undefined>,
): Promise<string> {
  const user = env["POSTGRES_USER"] ?? "noj";
  const db = env["POSTGRES_DB"] ?? "noj";
  const psql = async (sql: string): Promise<string | null> => {
    try {
      const res = await runner.run("docker", [
        "compose",
        "--env-file",
        envFile,
        "--file",
        composeFile,
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        user,
        "-d",
        db,
        "-Atqc",
        sql,
      ]);
      if (res.code !== 0) return null;
      return res.stdout.trim();
    } catch {
      return null;
    }
  };
  const exists = await psql(
    "SELECT to_regclass('drizzle.__drizzle_migrations')",
  );
  if (exists === null || exists === "") return "not-initialized";
  const status = await psql(
    "SELECT hash || ':' || created_at::text FROM drizzle.__drizzle_migrations ORDER BY created_at",
  );
  return status === null || status === ""
    ? "migration-status-unavailable"
    : status;
}

/**
 * 读 `.env.prod` 里的 `NOJ_BACKUP_PASSPHRASE_FILE`（文件不存在/不可读时为 undefined）。
 *
 * 备份命令（verify/restore/drill）可能在**安装目录之外**执行（例如只拿到一个
 * 快照文件做校验），因此这里绝不因读不到 `.env.prod` 而失败——口令的必需性
 * 由各命令自己的前置校验决定。
 */
async function readConfiguredPassphrase(
  dir: string,
): Promise<string | undefined> {
  try {
    const env = await readEnvValues(join(dir, PROD_ENV_FILE));
    return env["NOJ_BACKUP_PASSPHRASE_FILE"];
  } catch {
    return undefined;
  }
}

/** `backup create` 的选项（在 CLI 旗标之上再暴露 `args` 便于测试注入）。 */
export interface BackupCreateCliOptions {
  passphraseFile?: string;
  backupDir?: string;
  zstdLevel?: number;
  noEncrypt?: boolean;
  /**
   * 保留天数（`--retention-days` / `NOJ_BACKUP_RETENTION_DAYS`，默认 30）。
   *
   * 语义与 bash 一致：写入 manifest，并在**成功创建快照后**清理
   * 早于该天数的快照（bash `prune_old_snapshots`，`backup.sh:196-203`）。
   */
  retentionDays?: number;
  /**
   * 最低可用空间（MB，`--min-free-mb` / `NOJ_BACKUP_MIN_FREE_MB`，默认 1024）。
   *
   * 对应 bash `check_free_space`（`backup.sh:113-121`）：采集**之前**校验，
   * 空间不足直接失败。此前 TS 侧整体缺失该守卫，`backup create` 可以把磁盘写满。
   */
  minFreeMb?: number;
  args: string[];
  deps: ProdCliDeps;
  /**
   * 采集/打包操作集注入点；缺省用真实的 `createProdPayloadOps`。
   *
   * 存在的理由：**让"create 成功后是否写了指标"这条接线可测**。
   * 真实 ops 需要 pg/redis/minio 与 tar/zstd，单测环境不具备；
   * 若不注入，指标接线就只能靠"手抄一个 writeBackupMetrics 再断言"来假装覆盖
   * （那样测的是 metrics.ts 自身，而非 create 的接线）。
   */
  ops?: ContainerPayloadOps;
  /**
   * 可用空间探测注入点（缺省用 `df -Pk`）。
   *
   * 单独暴露是为了让"空间不足必须拒绝"这条守卫可测——真实 `df` 无法在单测里
   * 造出"磁盘已满"。
   */
  probeFreeBytes?: (dir: string) => Promise<number>;
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
  // **归一化尾随斜杠**（2026-09-23 复审）：`--backup-dir /x/` 与
  // `listBackups` 拼出的 `/x//name` 不一致，会让下面的 `excludePaths` 完全失配
  // → 刚创建的快照仍可能被自己的清理删掉。
  const backupDir = normalizeDir(opts.backupDir ?? prodBackupDir(dir));
  const env = await readEnvValues(envFile);
  // 口令来源：显式选项（旗标）> 进程环境 > `.env.prod`，与 verify/restore/drill
  // 一致。此前只认旗标：`install`/`update` 已把口令路径写进 `.env.prod`，
  // 手动 `backup create` 却仍报"缺少 GPG 口令文件"。
  const passphraseFile = opts.passphraseFile ??
    resolveBackupPassphrase(opts.args, {
      env: d.processEnv,
      configured: env["NOJ_BACKUP_PASSPHRASE_FILE"],
    });

  // ---- 0. 数字旗标校验（bash `check_numbers` :108-111）----
  // **必须在任何副作用之前**：`--retention-days oops` 若拖到清理阶段才报错，
  // 备份已经产出、用户却拿到失败退出码。
  const retentionDays = assertNonNegative(
    opts.retentionDays ?? 30,
    "--retention-days",
  );
  const minFreeMb = assertNonNegative(opts.minFreeMb ?? 1024, "--min-free-mb");

  // ---- 0b. 可用空间守卫（bash `check_free_space` :113-121）----
  // 这是备份场景最常见的自伤方式：磁盘写满后连恢复都没有余量。
  // bash 侧一直有此检查，TS 重写时被整体删除（评审发现）。
  const probe = opts.probeFreeBytes ??
    ((target: string) => probeDirFreeBytes(d.runner, target));
  const freeBytes = await probe(backupDir);
  if (Number.isFinite(freeBytes) && freeBytes < minFreeMb * 1024 * 1024) {
    throw new Error(
      `备份目录可用空间不足：需要至少 ${minFreeMb}MB（可用 ${
        Math.floor(freeBytes / (1024 * 1024))
      }MB）`,
    );
  }

  const ops = opts.ops ?? createProdPayloadOps({
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

  const created = await createContainer({
    backupDir,
    // staging 与产物同目录：跨目录 rename 可能退化为拷贝并丢失原子性
    stagingParent: backupDir,
    passphraseFile,
    noEncrypt: opts.noEncrypt === true,
    zstdLevel: opts.zstdLevel,
    retentionDays,
    envFile,
    postgresDatabase: env["POSTGRES_DB"] ?? "noj",
    migrationStatus: await readMigrationStatus(
      d.runner,
      composeFile,
      envFile,
      env,
    ),
    ops,
    now: opts.deps.now?.(),
  });

  // ---- 13. 备份新鲜度指标（node_exporter textfile）----
  // **只在成功后写**：`NojBackupStale` 的语义是"最近一次**成功**距今多久"，
  // 失败也写会让"备份一直没成功"被掩盖——那正是该告警要抓的。
  // 指标缺失（脚本删掉后 TS 侧曾无写入方）会触发 `NojBackupMetricMissing`
  // 持续报警，进而让人忽略真正的备份故障。
  try {
    const size = (await Deno.stat(created.path)).size;
    const at = opts.deps.now?.() ?? new Date();
    await writeBackupMetrics({
      backupDir,
      explicitDir: d.processEnv["NOJ_BACKUP_METRICS_DIR"],
      unixSeconds: Math.floor(at.getTime() / 1000),
      snapshotBytes: size,
    });
  } catch (err) {
    // 备份**本体**已成功，指标写失败不该把成功报成失败；但必须可见
    // （静默会让"指标缺失"变成无声故障）。
    (opts.deps.err ?? ((t: string) => console.error(t)))(
      `! 备份已完成，但新鲜度指标写入失败：${(err as Error).message}`,
    );
  }

  // ---- 14. 按保留天数清理旧快照（bash `prune_old_snapshots` :291-292）----
  // **只在成功后做**：备份失败时清理旧快照等于把"没有新备份"变成"没有备份"。
  // 删除失败不改变备份已成功的事实，但必须可见（否则"已清理"是假成功）。
  //
  // **人类提示一律走 stderr**（2026-09-23 复审）：`backup create --json` 的 stdout
  // 必须**逐字节为 JSON**（CHANGELOG 的 T6 契约），此前这些 `✓ 已清理…` 走 stdout
  // 会让 `JSON.parse(stdout)` 直接抛错。
  const note = opts.deps.err ?? ((t: string) => console.error(t));
  try {
    const pruned = await pruneBackups(backupDir, {
      olderThanDays: retentionDays,
      confirm: true,
      // **必须把"刚创建的这一份"排除在清理之外**：`--retention-days 0` 的语义是
      // "不留旧快照"，而 bash 的 `-mtime +0` 要求**满 24 小时**且只匹配目录。
      // 若按 `ageDays > 0` 判定，刚产出的快照（ageDays≈0）在某些时钟/时区下会
      // 被判为"过期"并当场删除，只剩孤儿 `.sha256`（复审实测：exit 0 但快照消失）。
      excludePaths: new Set([created.path]),
    });
    for (const path of pruned.deleted) {
      note(`✓ 已清理过期快照：${path}`);
    }
    if (pruned.failed.length > 0) {
      note(
        `! 有 ${pruned.failed.length} 份过期快照清理失败：` +
          pruned.failed.map((f) => f.path).join("、"),
      );
    }
  } catch (err) {
    note(`! 备份已完成，但过期快照清理失败：${(err as Error).message}`);
  }
  return created;
}

/** `backup verify`（T18 三档）。 */
export async function runBackupVerify(
  dir: string,
  args: string[],
  deps: ProdCliDeps,
): Promise<BackupVerifyResult> {
  const snapshot = positionals(args)[0];
  if (snapshot === undefined) {
    throw new UsageError("backup verify 需要 <snapshot> 路径");
  }
  const d = prodDeps(deps);
  // 口令来源：旗标 > 进程环境 > `.env.prod`（评审发现：环境变量此前未接线，
  // 而 `install` 会把它写进 `.env.prod`）。
  const configured = await readConfiguredPassphrase(dir);
  const passphraseFile = resolveBackupPassphrase(args, {
    env: d.processEnv,
    configured,
  });
  const work = await Deno.makeTempDir({ prefix: "noj-verify-" });
  try {
    return await verifyCommand({
      path: snapshot,
      workDir: work,
      passphraseFile,
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
): Promise<import("../backup/commands.ts").BackupListResult> {
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
  // **必须校验**（评审发现的数据丢失缺陷）：`Number("oops")` 是 `NaN`，
  // 而 `planPrune` 的 `Math.max(0, NaN)` 仍是 `NaN`、`slice(0, NaN)` 返回空集，
  // 于是"受数量保护"的集合为空 → **每一份备份都被删**。
  // 用户输入 `--keep oops --confirm` 的本意是"保留一些"，结果全删了。
  return pruneCommand(backupDir, {
    keep: optionalCount(args, "--keep"),
    olderThanDays: optionalCount(args, "--older-than"),
    includeLegacy: hasFlag(args, "--include-legacy"),
    confirm: hasFlag(args, "--confirm"),
  });
}

/**
 * `backup restore`：**`--confirm` 走真实恢复，否则只出 dry-run 计划**。
 *
 * 这是文档承诺的语义（"恢复到已停止的 Compose 环境（需 --confirm）"）：
 * 该旗标是"不可逆操作"的门禁，而不是装饰。此前的实现无条件走
 * `runBackupRestorePlan`，于是带 `--confirm` 也只规划不执行——**文档承诺了
 * 一个不存在的实现**（评审发现）。
 *
 * 失败一律抛错（由 `dispatchProdBackup` 统一转退出码）：
 * 恢复失败绝不能被当成"成功但没什么可做"。
 */
export async function runBackupRestore(
  dir: string,
  args: string[],
  deps: ProdCliDeps,
): Promise<
  | {
    kind: "dry-run";
    steps: RestoreStep[];
    verified: boolean;
    summary: string;
  }
  | { kind: "restored"; summary: string; restored: string[]; path: string }
> {
  const snapshot = positionals(args)[0];
  if (snapshot === undefined) {
    throw new UsageError("backup restore 需要 <snapshot> 路径");
  }
  const d = prodDeps(deps);
  // 口令来源：旗标 > 进程环境 > `.env.prod`（评审发现：环境变量此前未接线）。
  const passphraseFile = resolveBackupPassphrase(args, {
    env: d.processEnv,
    configured: await readConfiguredPassphrase(dir),
  });
  const dockerBin = d.processEnv["NOJ_DEPLOY_DOCKER_BIN"] ?? "docker";
  const work = await Deno.makeTempDir({ prefix: "noj-restore-" });
  try {
    const ops = {
      gpgDecrypt: (src: string, dest: string, pass: string) =>
        gpgDecrypt(d.runner, src, dest, pass),
      untarZst: (src: string, destDir: string) =>
        untarZst(d.runner, src, destDir),
    };
    // 无 --confirm（或显式 --dry-run）：保持 dry-run（零副作用），并明确告知"未执行"
    if (!hasFlag(args, "--confirm")) {
      const plan = await restorePlan({
        path: snapshot,
        workDir: work,
        passphraseFile,
        encrypted: !hasFlag(args, "--no-encrypt"),
        restoreEnv: flagValue(args, "--restore-env"),
        bucket: undefined,
        ops,
      });
      return {
        kind: "dry-run",
        steps: plan.steps,
        verified: plan.verified,
        summary: plan.summary +
          "\n（未执行任何变更；要真正恢复请追加 --confirm）",
      };
    }
    // --confirm：真实恢复
    const result = await restoreConfirmed({
      path: snapshot,
      dir,
      composeFile: join(dir, PROD_COMPOSE_FILE),
      envFile: join(dir, PROD_ENV_FILE),
      runner: d.runner,
      confirm: true,
      workDir: work,
      passphraseFile,
      encrypted: !hasFlag(args, "--no-encrypt"),
      restoreEnv: flagValue(args, "--restore-env"),
      judge: false,
      dockerBin,
      // `--json` 时 stdout 必须逐字节为 JSON（CHANGELOG 的生产命令契约），
      // 因此人类日志改道 stderr（2026-09-23 复审）。
      log: (line) => {
        if (hasJson(args)) console.error(line);
        else (deps.out ?? ((t: string) => console.log(t)))(line);
      },
      ops,
    });
    return {
      kind: "restored",
      summary: result.summary,
      restored: result.restored,
      path: result.path,
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
    // 口令来源与 create/verify 一致：旗标 > 进程环境 > `.env.prod`。
    passphraseFile: resolveBackupPassphrase(args, {
      env: d.processEnv,
      configured: await readConfiguredPassphrase(dir),
    }),
    // 同上：`--json` 时人类日志走 stderr，保证 stdout 干净。
    log: (line: string) => {
      if (hasJson(args)) console.error(line);
      else (deps.out ?? ((t: string) => console.log(t)))(line);
    },
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
