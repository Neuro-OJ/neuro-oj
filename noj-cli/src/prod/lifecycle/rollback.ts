/**
 * 生产一键回滚编排（`rollback`）：前置校验 → 迁移门禁 → 排空服务 → 回切配置与部署文件 →
 * 按需恢复备份 → 启动与健康等待。
 *
 * 设计要点：
 * 1. **安全门禁优先**：跨版本回退若检测到已发生数据库迁移或跨越主/次版本，
 *    未指定 `--restore-backup` 时默认安全拒绝单纯回切镜像，并给出恢复指引
 *    （需提供 `--restore-backup <path>` 或显式 `--force-app-only`）。
 * 2. **支持 `--dry-run` 零副作用预演**：完成全部前置校验、目标解析、迁移门禁与
 *    备份只读校验，输出完整计划，绝不修改 `.env.prod` / Compose / 容器 / 数据。
 * 3. **暂存与回退保护**：目标部署文件先同步到暂存目录并拉取/验签镜像，成功后再
 *    排空、切换 `.env.prod` 的 `NOJ_VERSION` 与部署文件；文件替换失败自动还原旧文件。
 */

import { basename, dirname, join } from "@std/path";
import { emitHuman, emitJson } from "../../output/render.ts";
import { isFile } from "../../util/fs.ts";
import { downloadReleaseFiles, type Fetcher } from "../bootstrap.ts";
import { composePull, PROD_COMPOSE_FILE, PROD_ENV_FILE } from "../compose.ts";
import {
  DEPLOYMENT_MANIFEST_FILE,
  recordDeploymentMetadata,
  verifyImageSignatures,
} from "../config.ts";
import {
  configuredVersion,
  DEFAULT_UPDATE_REPOSITORY,
  normalizedVersion,
  stageConfigVersion,
  validateReleaseTag,
  writeConfigVersion,
} from "../release.ts";
import {
  readUpgradeState,
  type UpgradeState,
  upgradeStatePath,
} from "../upgrade-state.ts";
import {
  assertContainerPath,
  restoreConfirmed,
  verifyCommand,
} from "../backup/commands.ts";
import { gpgDecrypt, untarZst } from "../gpg-tar.ts";
import { failed, lifecycleContext } from "./context.ts";
import {
  drainAfterUpgrade,
  drainBeforeUpgrade,
  type DrainOptions,
} from "./drain.ts";
import { probeCosign } from "./install.ts";
import {
  type LifecycleBaseResult,
  type LifecycleOptions,
  prepareLifecycle,
} from "./services.ts";
import {
  composeOutputText,
  ensureCommandPassphrase,
  runComposeSub,
  WAIT_FAILURE_HINT,
  waitForStack,
} from "./steps.ts";
import { resolveTargetConfig } from "./target.ts";
import { digestCandidateFiles } from "./upgrade.ts";

/** 回滚计划的阶段名（英文标识符，供机器断言）。 */
export type RollbackPlanStepName =
  | "preflight"
  | "drain"
  | "switch-files"
  | "restore-backup"
  | "start-and-wait";

/** 回滚预演/执行步骤。 */
export interface RollbackPlanStep {
  name: RollbackPlanStepName;
  detail: string;
  mutates: boolean;
}

/** 回滚快照只读校验结果（与 `verifyCommand` 对齐的子集）。 */
export interface RollbackBackupVerifyResult {
  pass: boolean;
  issues: ReadonlyArray<{ level: string; message: string }>;
  summary?: string;
}

/** {@link rollback} 的输入选项（外部副作用均可注入以便单测）。 */
export interface RollbackOptions extends LifecycleOptions, DrainOptions {
  /** 显式目标版本（`--to`）；缺省读取 `upgrade-state.json` 中的 `from`。 */
  to?: string;
  /** 可选恢复的 `.nojbackup` 单文件快照路径（`--restore-backup`）。 */
  restoreBackup?: string;
  /** GPG 口令文件路径（`--passphrase-file`）。 */
  passphraseFile?: string;
  /** 快照是否未加密（`--no-encrypt`）。 */
  noEncrypt?: boolean;
  /** 跳过跨版本迁移安全门禁（`--force-app-only`，仅回切镜像与配置）。 */
  forceAppOnly?: boolean;
  /** 零副作用预演（`--dry-run`）。 */
  dryRun?: boolean;
  /** 进程环境快照；缺省 `Deno.env.toObject()`。 */
  processEnv?: Record<string, string>;
  /** 告警输出回调。 */
  warn?: (message: string) => void;
  /** Release 仓库地址（`NOJ_UPDATE_REPOSITORY`）。 */
  repository?: string;
  /** Release 元数据/文件下载器注入点。 */
  fetcher?: Fetcher;
  /** checkpoint 路径覆盖点；默认 `<dir>/backups/upgrade-state.json`。 */
  upgradeStatePath?: string;
  /** cosign 可执行名。 */
  cosignBin?: string;
  /** cosign 可用性探测注入点。 */
  cosignAvailable?: () => Promise<boolean>;
  /** 时间戳注入点。 */
  now?: Date;
  /** 目标版本部署文件同步覆盖点（不覆盖 `.env.prod`）。 */
  syncFiles?: (context: {
    dir: string;
    ref: string;
    repository: string;
  }) => Promise<void>;
  /** 备份快照只读校验覆盖点（缺省走 `verifyCommand`）。 */
  verifyBackup?: (context: {
    path: string;
    workDir: string;
    passphraseFile: string;
    encrypted: boolean;
  }) => Promise<RollbackBackupVerifyResult>;
  /** 数据快照真实恢复覆盖点（缺省走 `restoreConfirmed`）。 */
  restore?: (context: {
    path: string;
    dir: string;
    composeFile: string;
    envFile: string;
    workDir: string;
    passphraseFile: string;
    encrypted: boolean;
    judge: boolean;
  }) => Promise<{ restored: string[] }>;
  /** 额外跨版本数据库迁移探测覆盖点（供扩展检测）。 */
  detectSchemaMigration?: (context: {
    dir: string;
    from: string;
    to: string;
    upgradeState: UpgradeState | null;
  }) => Promise<boolean>;
}

/** {@link rollback} 的返回值。 */
export interface RollbackResult extends LifecycleBaseResult {
  from: string;
  to: string;
  dryRun: boolean;
  restoredBackup: string | null;
  forceAppOnly: boolean;
  filesSwitched: boolean;
  steps: RollbackPlanStep[];
}

/** 解析 Release 标签中的主次版本号（用于跨 minor/major 迁移门禁判定）。 */
export function parseSemverMajorMinor(
  tag: string,
): { major: number; minor: number } | null {
  const match = /^v?(\d+)\.(\d+)\.\d+(?:-[0-9A-Za-z.-]+)?$/.exec(tag.trim());
  if (match === null) return null;
  const major = Number.parseInt(match[1]!, 10);
  const minor = Number.parseInt(match[2]!, 10);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) return null;
  return { major, minor };
}

/**
 * 跨版本数据库迁移安全门禁判定。
 *
 * 当升级记录标明迁移已开始/已完成跨版本升级，或当前版本与目标版本跨越主/次版本，
 * 或外部迁移探测返回 true 时，认为单纯回切镜像存在数据库 schema 不兼容风险。
 */
export function assessRollbackMigrationRisk(input: {
  currentVersion: string;
  targetVersion: string;
  upgradeState: UpgradeState | null;
  customDetected?: boolean;
}): { risky: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const { currentVersion, targetVersion, upgradeState, customDetected } = input;

  if (upgradeState !== null) {
    if (upgradeState.migration_started) {
      reasons.push(
        "升级记录（upgrade-state.json）显示数据库迁移已开始（migration_started=true）",
      );
    } else if (
      upgradeState.phase === "completed" &&
      normalizedVersion(upgradeState.from) ===
        normalizedVersion(targetVersion) &&
      normalizedVersion(upgradeState.to) === normalizedVersion(currentVersion)
    ) {
      reasons.push(
        `升级记录显示已完成 ${upgradeState.from} -> ${upgradeState.to} 升级（可能包含数据库结构迁移）`,
      );
    }
  }

  const curMM = parseSemverMajorMinor(currentVersion);
  const tgtMM = parseSemverMajorMinor(targetVersion);
  if (
    curMM !== null && tgtMM !== null &&
    (curMM.major !== tgtMM.major || curMM.minor !== tgtMM.minor)
  ) {
    reasons.push(
      `版本跨度 ${currentVersion} -> ${targetVersion} 跨越主/次版本（major.minor 变更）`,
    );
  }

  if (customDetected === true) {
    reasons.push("检测到目标版本与当前库结构存在跨版本迁移差异");
  }

  return { risky: reasons.length > 0, reasons };
}

/** 构造安全门禁拦截文案（含具体恢复指令指引）。 */
export function formatMigrationGuardError(input: {
  targetVersion: string;
  reasons: string[];
  suggestedBackupPath: string | null;
}): string {
  const backupExample = input.suggestedBackupPath ?? "<snapshot.nojbackup>";
  return [
    `安全门禁已阻止仅回切镜像到 ${input.targetVersion}：`,
    ...input.reasons.map((r) => `  - ${r}`),
    "若直接降级应用容器，可能因数据库 schema/数据不兼容导致服务启动失败或数据损坏。",
    "请选择以下安全恢复方式之一：",
    `  1) 连同数据快照一起回滚（推荐）：noj-cli rollback --to ${input.targetVersion} --restore-backup ${backupExample}`,
    `  2) 确认目标版本与当前数据库完全兼容时强制仅回切应用：noj-cli rollback --to ${input.targetVersion} --force-app-only`,
  ].join("\n");
}

/** 读取历史部署元数据摘要（`backups/current-deployment.txt`，不存在则返回 null）。 */
async function readDeploymentHistoryVersion(
  backupDir: string,
): Promise<string | null> {
  try {
    const text = await Deno.readTextFile(
      join(backupDir, DEPLOYMENT_MANIFEST_FILE),
    );
    for (const line of text.split("\n")) {
      if (line.startsWith("version=")) {
        const value = line.slice("version=".length).trim();
        return value === "" ? null : value;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** 原子替换单个文件（同目录写临时文件再 rename）。 */
async function replaceFileAtomic(
  source: string,
  target: string,
): Promise<void> {
  const tmp = join(
    dirname(target),
    `.${basename(target)}.tmp-${crypto.randomUUID()}`,
  );
  try {
    await Deno.copyFile(source, tmp);
    await Deno.rename(tmp, target);
  } catch (error) {
    await Deno.remove(tmp).catch(() => {});
    throw error;
  }
}

/** 构造本次回滚的执行计划（dry-run 与实际执行共享同一规划逻辑）。 */
export function buildRollbackPlan(input: {
  from: string;
  to: string;
  skipDrain: boolean;
  restoreBackup: string | null;
  forceAppOnly: boolean;
}): RollbackPlanStep[] {
  const steps: RollbackPlanStep[] = [
    {
      name: "preflight",
      detail:
        `校验安装目录、历史版本元数据，确定回滚目标 ${input.from} -> ${input.to}` +
        (input.forceAppOnly ? "（已启用 --force-app-only）" : ""),
      mutates: false,
    },
  ];
  if (!input.skipDrain) {
    steps.push({
      name: "drain",
      detail:
        "进入维护模式（maintain enter）并等待在途评测排空（maintain wait）",
      mutates: true,
    });
  }
  steps.push({
    name: "switch-files",
    detail:
      `同步 ${input.to} 部署文件并回切 .env.prod 的 NOJ_VERSION=${input.to}`,
    mutates: true,
  });
  if (input.restoreBackup !== null) {
    steps.push({
      name: "restore-backup",
      detail:
        `停止服务并从快照 ${input.restoreBackup} 恢复 PostgreSQL / Redis / MinIO`,
      mutates: true,
    });
  }
  steps.push({
    name: "start-and-wait",
    detail:
      `启动 ${input.to} 服务、等待健康检查通过，并退出维护模式与记录部署元数据`,
    mutates: true,
  });
  return steps;
}

/** 同步目标版本部署文件（缺省只拉取 compose 与 env 示例，兼容历史版本）。 */
async function syncRollbackFiles(
  opts: RollbackOptions,
  context: { dir: string; ref: string; repository: string },
): Promise<void> {
  if (opts.syncFiles !== undefined) {
    await opts.syncFiles(context);
    return;
  }
  await downloadReleaseFiles({
    repository: context.repository,
    ref: context.ref,
    targetDir: context.dir,
    overwrite: true,
    fetcher: opts.fetcher,
  });
}

/** 归档已回滚的未完成升级 checkpoint，避免阻塞后续 `update`。 */
async function archiveRolledBackUpgradeState(
  checkpointPath: string,
  state: UpgradeState | null,
): Promise<void> {
  if (state === null) return;
  const archived = join(
    dirname(checkpointPath),
    `upgrade-state.rolled-back-${state.run_id}.json`,
  );
  try {
    await Deno.rename(checkpointPath, archived);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      await Deno.remove(checkpointPath).catch(() => {});
    }
  }
}

/**
 * 执行生产一键回滚（含 `--dry-run` 预演）。
 *
 * 退出码：0 成功（含 dry-run 校验通过）；1 运行失败；用法错误 2 由 CLI 解析层产出。
 */
export async function rollback(opts: RollbackOptions): Promise<RollbackResult> {
  const ctx = lifecycleContext(opts);
  const envFile = join(ctx.dir, PROD_ENV_FILE);
  const dryRun = opts.dryRun === true;
  const forceAppOnly = opts.forceAppOnly === true;
  const skipDrain = opts.skipDrain === true;
  const restoreBackup = opts.restoreBackup ?? null;
  const processEnv = opts.processEnv ?? Deno.env.toObject();

  const finish = (result: RollbackResult): RollbackResult => {
    if (ctx.jsonMode) emitJson(rollbackPayload(result), ctx.io);
    return result;
  };
  const fail = (
    from: string,
    to: string,
    error: string,
    steps: RollbackPlanStep[] = [],
    filesSwitched = false,
  ): RollbackResult => {
    ctx.error(error);
    return finish({
      ...failed(ctx.dir, error),
      from,
      to,
      dryRun,
      restoredBackup: restoreBackup,
      forceAppOnly,
      filesSwitched,
      steps,
    });
  };

  // ---- 1. 前置校验（安装目录、权限、compose 配置）----
  const prepared = await prepareLifecycle(ctx, opts);
  if (!prepared.ok) {
    return fail("", "", prepared.error);
  }

  let currentVersion: string;
  try {
    currentVersion = await configuredVersion(envFile);
  } catch (err) {
    return fail("", "", (err as Error).message);
  }

  const checkpointPath = opts.upgradeStatePath ?? upgradeStatePath(ctx.dir);
  let upgradeState: UpgradeState | null = null;
  try {
    upgradeState = await readUpgradeState(checkpointPath);
  } catch (err) {
    return fail(
      currentVersion,
      "",
      `读取升级记录失败：${(err as Error).message}`,
    );
  }

  const backupDir = join(ctx.dir, "backups");
  const deployedHistoryVersion = await readDeploymentHistoryVersion(backupDir);
  if (
    deployedHistoryVersion !== null &&
    normalizedVersion(deployedHistoryVersion) !==
      normalizedVersion(currentVersion)
  ) {
    emitHuman(
      `提示：当前 .env.prod 版本为 ${currentVersion}，最近部署元数据记录版本为 ${deployedHistoryVersion}\n`,
      ctx.io,
    );
  }

  // ---- 2. 解析目标回滚版本 ----
  let targetVersion: string;
  if (opts.to !== undefined) {
    try {
      targetVersion = validateReleaseTag(opts.to);
    } catch (err) {
      return fail(currentVersion, opts.to, (err as Error).message);
    }
  } else if (upgradeState !== null && upgradeState.from !== "") {
    try {
      targetVersion = validateReleaseTag(upgradeState.from);
    } catch (err) {
      return fail(
        currentVersion,
        upgradeState.from,
        `升级记录中的历史版本非法：${(err as Error).message}`,
      );
    }
  } else {
    return fail(
      currentVersion,
      "",
      "无法自动确定回滚目标版本：缺少升级记录（backups/upgrade-state.json 中的 from），请显式指定 --to <version>",
    );
  }

  if (
    normalizedVersion(targetVersion) === normalizedVersion(currentVersion) &&
    restoreBackup === null
  ) {
    return fail(
      currentVersion,
      targetVersion,
      `当前生产版本已是 ${currentVersion}；如需恢复数据快照请附加 --restore-backup <path> 或使用 noj-cli backup restore`,
    );
  }

  // ---- 3. 安全门禁：跨版本数据库迁移与备份检查 ----
  const customDetected = opts.detectSchemaMigration !== undefined
    ? await opts.detectSchemaMigration({
      dir: ctx.dir,
      from: currentVersion,
      to: targetVersion,
      upgradeState,
    })
    : false;
  const risk = assessRollbackMigrationRisk({
    currentVersion,
    targetVersion,
    upgradeState,
    customDetected,
  });

  if (risk.risky && restoreBackup === null && !forceAppOnly) {
    return fail(
      currentVersion,
      targetVersion,
      formatMigrationGuardError({
        targetVersion,
        reasons: risk.reasons,
        suggestedBackupPath: upgradeState?.backup_path ?? null,
      }),
    );
  }

  // ---- 4. 若指定 --restore-backup：校验快照存在性、口令与结构完整性（只读）----
  let resolvedPassphraseFile = "";
  const encrypted = opts.noEncrypt !== true;
  if (restoreBackup !== null) {
    try {
      assertContainerPath(restoreBackup);
    } catch (err) {
      return fail(currentVersion, targetVersion, (err as Error).message);
    }
    if (!(await isFile(restoreBackup))) {
      return fail(
        currentVersion,
        targetVersion,
        `指定的恢复快照不存在：${restoreBackup}`,
      );
    }
    if (encrypted) {
      const passphrase = await ensureCommandPassphrase({
        envFile: prepared.envFile,
        env: prepared.env,
        processEnv,
        passphraseFile: opts.passphraseFile,
        warn: opts.warn,
      });
      if (passphrase.error !== null) {
        return fail(currentVersion, targetVersion, passphrase.error);
      }
      resolvedPassphraseFile = passphrase.path;
    }

    const workDir = await Deno.makeTempDir({ prefix: "noj-rollback-verify-" });
    try {
      const verified = opts.verifyBackup !== undefined
        ? await opts.verifyBackup({
          path: restoreBackup,
          workDir,
          passphraseFile: resolvedPassphraseFile,
          encrypted,
        })
        : await verifyCommand({
          path: restoreBackup,
          workDir,
          passphraseFile: resolvedPassphraseFile,
          encrypted,
          deep: true,
          ops: {
            gpgDecrypt: (src, dest, pass) =>
              gpgDecrypt(opts.runner, src, dest, pass),
            untarZst: (src, destDir) => untarZst(opts.runner, src, destDir),
          },
        });
      if (!verified.pass) {
        const detail = verified.issues
          .map((i) => `  - [${i.level}] ${i.message}`)
          .join("\n");
        return fail(
          currentVersion,
          targetVersion,
          `回滚前快照校验未通过，已中止回滚：\n${detail}`,
        );
      }
    } catch (err) {
      return fail(
        currentVersion,
        targetVersion,
        `回滚前快照校验失败：${(err as Error).message}`,
      );
    } finally {
      await Deno.remove(workDir, { recursive: true }).catch(() => {});
    }
  }

  const steps = buildRollbackPlan({
    from: currentVersion,
    to: targetVersion,
    skipDrain,
    restoreBackup,
    forceAppOnly,
  });

  // ---- 5. --dry-run：零副作用预演后直接返回 ----
  if (dryRun) {
    emitHuman(
      `\n[dry-run] 回滚预演计划（${currentVersion} -> ${targetVersion}，未执行任何变更）：\n`,
      ctx.io,
    );
    for (const [idx, step] of steps.entries()) {
      emitHuman(`  ${idx + 1}. [${step.name}] ${step.detail}\n`, ctx.io);
    }
    ctx.status(
      "success",
      `[dry-run] 回滚前置校验通过：${currentVersion} -> ${targetVersion}`,
    );
    return finish({
      dir: ctx.dir,
      state: "running",
      noOp: false,
      exitCode: 0,
      error: null,
      from: currentVersion,
      to: targetVersion,
      dryRun: true,
      restoredBackup: restoreBackup,
      forceAppOnly,
      filesSwitched: false,
      steps,
    });
  }

  // ---- 6. 暂存目标部署文件与配置，并预拉取/验签目标镜像（失败不中断线上服务）----
  let stagedEnvFile: string | null = null;
  let stagedFilesDir: string | null = null;
  const cleanupStaging = async (): Promise<void> => {
    if (stagedEnvFile !== null) {
      await Deno.remove(stagedEnvFile).catch(() => {});
    }
    if (stagedFilesDir !== null) {
      await Deno.remove(stagedFilesDir, { recursive: true }).catch(() => {});
    }
  };

  try {
    stagedEnvFile = await stageConfigVersion(envFile, targetVersion);
    stagedFilesDir = join(ctx.dir, `.rollback-staging-${crypto.randomUUID()}`);
    await Deno.mkdir(stagedFilesDir, { recursive: true });
    await syncRollbackFiles(opts, {
      dir: stagedFilesDir,
      ref: targetVersion,
      repository: opts.repository ?? DEFAULT_UPDATE_REPOSITORY,
    });
  } catch (err) {
    await cleanupStaging();
    return fail(
      currentVersion,
      targetVersion,
      `准备目标版本 ${targetVersion} 部署文件失败：${(err as Error).message}`,
      steps,
    );
  }

  const candidateCompose = join(stagedFilesDir, PROD_COMPOSE_FILE);
  const stagedComposeExists = await isFile(candidateCompose);
  const stagedPlan = await resolveTargetConfig(
    prepared,
    stagedEnvFile,
    stagedComposeExists ? candidateCompose : undefined,
  );
  if (!stagedPlan.ok) {
    await cleanupStaging();
    return fail(currentVersion, targetVersion, stagedPlan.error, steps);
  }
  const stagedTarget = stagedPlan.target;

  emitHuman(`\n== 拉取回滚目标版本镜像 (${targetVersion}) ==\n`, ctx.io);
  const pulled = await composePull(opts.runner, stagedTarget.composeOptions);
  const pullText = composeOutputText(pulled);
  if (pullText !== "") emitHuman(pullText, ctx.io);
  if (!Array.isArray(pulled) && pulled.code !== 0) {
    await cleanupStaging();
    return fail(
      currentVersion,
      targetVersion,
      "拉取回滚目标镜像失败：" +
        (pulled.stderr.trim() || `docker compose 退出码 ${pulled.code}`),
      steps,
    );
  }

  const verify = await verifyImageSignatures(stagedTarget.env, {
    runner: opts.runner,
    cosignAvailable: opts.cosignAvailable ??
      probeCosign(opts.runner, opts.cosignBin ?? "cosign"),
    dockerBin: opts.dockerBin,
    cosignBin: opts.cosignBin,
    warn: opts.warn,
  });
  if (!verify.ok) {
    await cleanupStaging();
    return fail(
      currentVersion,
      targetVersion,
      verify.error ?? "回滚目标镜像签名校验失败",
      steps,
    );
  }

  // ---- 7. 排空服务 ----
  const drainError = await drainBeforeUpgrade(opts, stagedTarget, ctx);
  if (drainError !== null) {
    await cleanupStaging();
    return fail(currentVersion, targetVersion, drainError, steps);
  }

  // 若需要恢复数据快照，必须在切换后停机执行恢复，因此先停服务
  if (restoreBackup !== null) {
    const stopped = await runComposeSub(opts.runner, prepared.composeOptions, [
      "stop",
    ]);
    const stopText = composeOutputText(stopped);
    if (stopText !== "") emitHuman(stopText, ctx.io);
    if (!Array.isArray(stopped) && stopped.code !== 0) {
      const exitErr = await drainAfterUpgrade(opts, prepared, ctx);
      await cleanupStaging();
      return fail(
        currentVersion,
        targetVersion,
        "恢复数据前停止服务失败：" +
          (stopped.stderr.trim() || `docker compose 退出码 ${stopped.code}`) +
          (exitErr === null ? "" : `；${exitErr}`),
        steps,
      );
    }
  }

  // ---- 8. 回切 .env.prod 的 NOJ_VERSION 与对应部署文件 ----
  const backupFilesDir = join(
    ctx.dir,
    `.rollback-backup-${crypto.randomUUID()}`,
  );
  let filesSwitched = false;
  try {
    const candidateFiles = await digestCandidateFiles(stagedFilesDir);
    await Deno.mkdir(backupFilesDir, { recursive: true });
    await Deno.copyFile(envFile, join(backupFilesDir, PROD_ENV_FILE));
    for (const file of candidateFiles) {
      const dest = join(ctx.dir, file.name);
      try {
        await Deno.copyFile(dest, join(backupFilesDir, file.name));
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
      }
      await replaceFileAtomic(join(stagedFilesDir, file.name), dest);
    }
    await writeConfigVersion(envFile, targetVersion);
    await Deno.chmod(envFile, 0o600);
    filesSwitched = true;
  } catch (err) {
    // 若配置/文件切换中途失败，尝试从备份恢复
    try {
      await replaceFileAtomic(join(backupFilesDir, PROD_ENV_FILE), envFile);
      await Deno.chmod(envFile, 0o600);
    } catch {
      // 保留备份目录供人工处理
    }
    const exitErr = await drainAfterUpgrade(opts, prepared, ctx);
    await cleanupStaging();
    return fail(
      currentVersion,
      targetVersion,
      `回切配置文件失败：${(err as Error).message}` +
        (exitErr === null ? "" : `；${exitErr}`),
      steps,
      filesSwitched,
    );
  }
  await cleanupStaging();

  // ---- 9. 按需恢复数据备份 ----
  const activeComposeOptions = {
    composeFile: prepared.composeFile,
    projectDirectory: ctx.dir,
    envFile,
    judge: stagedTarget.judge,
  };
  if (restoreBackup !== null) {
    const restoreWorkDir = await Deno.makeTempDir({
      prefix: "noj-rollback-restore-",
    });
    try {
      if (opts.restore !== undefined) {
        await opts.restore({
          path: restoreBackup,
          dir: ctx.dir,
          composeFile: prepared.composeFile,
          envFile,
          workDir: restoreWorkDir,
          passphraseFile: resolvedPassphraseFile,
          encrypted,
          judge: stagedTarget.judge,
        });
      } else {
        await restoreConfirmed({
          path: restoreBackup,
          dir: ctx.dir,
          composeFile: prepared.composeFile,
          envFile,
          runner: opts.runner,
          confirm: true,
          workDir: restoreWorkDir,
          passphraseFile: resolvedPassphraseFile,
          encrypted,
          judge: stagedTarget.judge,
          dockerBin: opts.dockerBin,
          log: (line) => emitHuman(line + "\n", ctx.io),
          ops: {
            gpgDecrypt: (src, dest, pass) =>
              gpgDecrypt(opts.runner, src, dest, pass),
            untarZst: (src, destDir) => untarZst(opts.runner, src, destDir),
          },
        });
      }
    } catch (err) {
      await Deno.remove(restoreWorkDir, { recursive: true }).catch(() => {});
      return fail(
        currentVersion,
        targetVersion,
        `数据快照恢复失败（旧配置副本保留在 ${backupFilesDir}）：${
          (err as Error).message
        }`,
        steps,
        filesSwitched,
      );
    }
    await Deno.remove(restoreWorkDir, { recursive: true }).catch(() => {});
  }

  // ---- 10. 启动目标版本服务并等待健康 ----
  const wait = await waitForStack(
    opts.runner,
    activeComposeOptions,
    (text) => emitHuman(text, ctx.io),
  );
  if (!wait.ok) {
    let error = wait.error ?? WAIT_FAILURE_HINT;
    const drainExitError = await drainAfterUpgrade(
      opts,
      { composeOptions: activeComposeOptions, envFile },
      ctx,
    );
    if (drainExitError !== null) {
      ctx.error(drainExitError);
      error += "\n" + drainExitError;
    }
    return fail(currentVersion, targetVersion, error, steps, filesSwitched);
  }

  const drainExitError = await drainAfterUpgrade(
    opts,
    { composeOptions: activeComposeOptions, envFile },
    ctx,
  );
  if (drainExitError !== null) {
    return fail(
      currentVersion,
      targetVersion,
      drainExitError,
      steps,
      filesSwitched,
    );
  }

  try {
    await recordDeploymentMetadata({
      version: targetVersion,
      at: opts.now ?? new Date(),
      verified: verify.digests,
      backupDir,
    });
  } catch (err) {
    return fail(
      currentVersion,
      targetVersion,
      `记录部署元数据失败：${(err as Error).message}`,
      steps,
      filesSwitched,
    );
  }

  await archiveRolledBackUpgradeState(checkpointPath, upgradeState);
  await Deno.remove(backupFilesDir, { recursive: true }).catch(() => {});

  ctx.status(
    "success",
    `已回滚生产服务：${currentVersion} -> ${targetVersion}` +
      (restoreBackup !== null ? `（并恢复快照 ${restoreBackup}）` : ""),
  );
  return finish({
    dir: ctx.dir,
    state: "running",
    noOp: false,
    exitCode: 0,
    error: null,
    from: currentVersion,
    to: targetVersion,
    dryRun: false,
    restoredBackup: restoreBackup,
    forceAppOnly,
    filesSwitched,
    steps,
  });
}

function rollbackPayload(result: RollbackResult): Record<string, unknown> {
  return {
    dir: result.dir,
    from: result.from,
    to: result.to,
    state: result.state,
    dryRun: result.dryRun,
    restoredBackup: result.restoredBackup,
    forceAppOnly: result.forceAppOnly,
    filesSwitched: result.filesSwitched,
    steps: result.steps,
    error: result.error,
  };
}
