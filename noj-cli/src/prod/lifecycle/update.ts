// update / upgrade（含别名）：升级序列编排、注入点、结果形状与提示文案。

import { join } from "@std/path";
import { emitHuman, emitJson } from "../../output/render.ts";
import type { Fetcher } from "../bootstrap.ts";
import { PROD_ENV_FILE } from "../compose.ts";
import {
  configuredVersion,
  DEFAULT_UPDATE_REPOSITORY,
  normalizedVersion,
  stageConfigVersion,
} from "../release.ts";
import { failed, lifecycleContext } from "./context.ts";
import { reusableCandidateDir } from "./update-recover.ts";
import type { ResolvedTargetConfig } from "./target.ts";
import type { DrainOptions } from "./drain.ts";
import type { ReleaseSet } from "../release-set.ts";
import {
  advanceUpgradeState,
  readUpgradeState,
  upgradeStatePath,
  writeUpgradeState,
} from "../upgrade-state.ts";
import type { UpgradeState } from "../upgrade-state.ts";
import { resolveLatestTarget, runUpdateSync, upgradeWith } from "./upgrade.ts";
import type { LifecycleOptions } from "./services.ts";
import type { LifecycleBaseResult } from "./services.ts";

export interface UpdateOptions extends LifecycleOptions, DrainOptions {
  /** `--latest`：升级到最新稳定 Release；缺省按 `.env.prod` 的版本升级。 */
  latest?: boolean;
  /** 仓库地址（`NOJ_UPDATE_REPOSITORY`）；缺省官方仓库。 */
  repository?: string;
  /** 显式 API 地址（`NOJ_UPDATE_API_URL`）；仅供离线/私有镜像验证。 */
  apiUrl?: string;
  /** Release 元数据下载器；缺省全局 fetch（测试必须注入）。 */
  fetcher?: Fetcher;
  /** `--passphrase-file`（升级前的备份口令）。 */
  passphraseFile?: string;
  /** 进程环境快照；缺省 `Deno.env.toObject()`。 */
  processEnv?: Record<string, string>;
  /** 备份口令新生成时的告警汇聚点。 */
  warn?: (message: string) => void;
  /** docker 可执行名（`NOJ_DEPLOY_DOCKER_BIN` 的等价）。 */
  dockerBin?: string;
  /** cosign 可执行名。 */
  cosignBin?: string;
  /** cosign 可用性探测（与 install 同语义：缺省经 runner 真实探测）。 */
  cosignAvailable?: () => Promise<boolean>;
  /** judge socket 存在性探测（`prepareAndCheck` 的注入点）。 */
  socketExists?: (path: string) => Promise<boolean>;
  /** 元数据时间戳（测试注入固定值）。 */
  now?: Date;
  /**
   * 升级前备份（bash `run_backup "upgrade"`）。
   *
   * T17–T19 之前必须由调用方注入；缺省返回失败文案（见模块内注释）。
   */
  backup?: (context: UpdateBackupContext) => Promise<UpdateBackupResult>;
  /**
   * `--files-only` 语义的部署文件同步（bash `run_files_sync --files-only`）。
   *
   * 缺省用 T9 {@link downloadReleaseFiles}（`overwrite:true`）实现：以目标 ref
   * 重新拉取 compose / example 并 SHA-256 校验，**不动 `.env.prod`**。
   */
  syncFiles?: (context: UpdateSyncContext) => Promise<void>;
  /** 直接注入已校验的发布集（仅测试/离线调用；生产由 Release 资产下载）。 */
  releaseSet?: ReleaseSet;
  /** 允许从上一次未完成/失败 checkpoint 重新进入固定升级序列。 */
  recover?: boolean;
  /** checkpoint 路径覆盖点；生产默认为 `<dir>/backups/upgrade-state.json`。 */
  upgradeStatePath?: string;
  /** 显式迁移覆盖点；生产缺省按 migrate → gateway-migrate 顺序执行。 */
  migrate?: (context: UpdateMigrationContext) => Promise<void>;
}

/** 升级前备份的上下文（供 T17–T19 实现消费）。 */
export interface UpdateBackupContext {
  /** 归一化安装目录。 */
  dir: string;
  /** 目标版本（即将升级到的版本）。 */
  version: string;
  /** `.env.prod` 路径。 */
  envFile: string;
  /** 口令文件路径（可能为空串：尚未解析出）。 */
  passphraseFile: string;
}

/** 升级前备份的结果。 */
export interface UpdateBackupResult {
  ok: boolean;
  /** 备份产物路径；未产出时为 null。 */
  path: string | null;
  /** 失败文案；成功为 null。 */
  error: string | null;
}

/** 部署文件同步的上下文。 */
export interface UpdateSyncContext {
  dir: string;
  /** 目标 ref（`update` 恒等于目标版本标签）。 */
  ref: string;
  repository: string;
}

/** 显式数据库迁移的输入；不暴露口令或环境值。 */
export interface UpdateMigrationContext {
  dir: string;
  target: ResolvedTargetConfig;
}

/** {@link update} 的结果。 */
export interface UpdateResult extends LifecycleBaseResult {
  /** 升级前的版本（`.env.prod` 的 `NOJ_VERSION`）。 */
  from: string;
  /** 目标版本；no-op 时等于 `from`。 */
  to: string;
  /** 是否 no-op（`--latest` 且已是最新，未重启、未备份、未写配置）。 */
  noOp: boolean;
  /** 是否走 `--latest` 模式。 */
  latest: boolean;
  /** 是否已同步部署文件。 */
  filesSynced: boolean;
  /** 备份产物路径；未备份（no-op / 失败前）时为 null。 */
  backupPath: string | null;
}

/** `--latest` 且已是最新时的文案（production.sh:396 逐字）。 */
export const UPDATE_UP_TO_DATE_HINT = "当前已经是最新稳定 Release，无需升级";

/** 升级成功文案（production.sh:431 逐字，仅版本号参数化）。 */
export function updateSuccessHint(version: string): string {
  return `已升级到最新稳定 Release：${version}`;
}

/** 升级前备份未接线时的失败文案（T17–T19 之前）。 */
export const UPDATE_BACKUP_UNAVAILABLE_HINT =
  "升级前备份尚未接线（备份子系统由 T17–T19 交付）；为安全起见已中止升级";

/**
 * `update`（production.sh:345-436）：两种模式共用同一套升级序列。
 *
 * 编排（**顺序即断言**）：前置校验（零变更）→ `--latest` 解析并比较版本（相等即
 * no-op，零 compose/备份/写配置；否则先写暂存配置）→ 同步部署文件（`.env.prod`
 * 不受影响）→ 升级序列 → **仅升级成功后**才提交暂存配置（bash :428-432）。
 *
 * 退出码：0 成功（含 no-op）；1 运行失败（前置/版本/同步/备份/compose/健康检查/
 * 配置提交/drain 失败）；用法错误 2 由 CLI 层产出。`--json` 时 stdout 只含一个
 * JSON 文档（人类文字全部改道 stderr）。
 * drain exit 失败属**半完成**：提交暂存配置后返回 1 并提示人工 `noj-cli maintain exit`。
 */
export async function update(opts: UpdateOptions): Promise<UpdateResult> {
  const ctx = lifecycleContext(opts);
  const envFile = join(ctx.dir, PROD_ENV_FILE);
  const latest = opts.latest === true;

  const finish = (result: UpdateResult): UpdateResult => {
    if (ctx.jsonMode) emitJson(updatePayload(result), ctx.io);
    return result;
  };
  const fail = (from: string, to: string, error: string): UpdateResult => {
    ctx.error(error);
    return finish({
      ...failed(ctx.dir, error),
      from,
      to,
      noOp: false,
      latest,
      filesSynced: false,
      backupPath: null,
    });
  };

  // ---- 1. 读当前版本：缺失即失败（升级不可能无目标）----
  let from: string;
  try {
    from = await configuredVersion(envFile);
  } catch (err) {
    return fail("", "", (err as Error).message);
  }

  const checkpointPath = opts.upgradeStatePath ?? upgradeStatePath(ctx.dir);
  let previous: UpgradeState | null = null;
  try {
    previous = await readUpgradeState(checkpointPath);
    if (
      previous !== null && previous.phase !== "completed" &&
      opts.recover !== true
    ) {
      return fail(
        from,
        previous.to,
        `发现未完成的升级 checkpoint（阶段 ${previous.phase}，目标 ${previous.to}）；请确认备份后使用 --recover 重新执行升级`,
      );
    }
  } catch (err) {
    return fail(from, "", (err as Error).message);
  }
  // 恢复同一候选发布集：目标版本与暂存目录都沿用 checkpoint 记录，避免
  // “同一 run 前后两次升级到不同版本”或重新下载已校验文件。
  const recovering = previous !== null && previous.phase !== "completed";

  // ---- 2. --latest：解析目标版本；相等即 no-op（零副作用）----
  let to: string;
  if (latest) {
    try {
      to = await resolveLatestTarget(opts);
    } catch (err) {
      return fail(from, "", (err as Error).message);
    }
    emitHuman(`当前生产版本：${from}\n`, ctx.io);
    emitHuman(`最新稳定版本：${to}\n`, ctx.io);
    if (recovering && previous !== null && previous.to !== to) {
      emitHuman(
        `沿用未完成升级的目标版本：${previous.to}（checkpoint 阶段 ${previous.phase}）\n`,
        ctx.io,
      );
      to = previous.to;
    }
    if (normalizedVersion(to) === normalizedVersion(from)) {
      ctx.status("success", UPDATE_UP_TO_DATE_HINT);
      return finish({
        dir: ctx.dir,
        state: "running",
        noOp: true,
        exitCode: 0,
        error: null,
        from,
        to: from,
        latest,
        filesSynced: false,
        backupPath: null,
      });
    }
  } else {
    // 恢复未完成升级时目标版本取自 checkpoint，而不是当前安装版本。
    to = recovering && previous !== null ? previous.to : from;
  }

  // ---- 3. 前置校验与目标配置解析都在升级序列内；暂存配置只在 --latest 有新版时创建 ----
  let staged: string | null = null;
  // --latest 有新版，或 --recover 沿用了 checkpoint 里更高的目标版本时，都要先
  // 暂存目标版本配置；否则恢复会拿旧 .env.prod 去匹配新发布集。
  if (latest || (recovering && to !== from)) {
    try {
      staged = await stageConfigVersion(envFile, to);
    } catch (err) {
      return fail(from, to, (err as Error).message);
    }
  }

  const discardStaged = async (): Promise<void> => {
    if (staged !== null) await Deno.remove(staged).catch(() => {});
  };

  // ---- 4. 同步部署文件到暂存目录（预检通过后才切换）----
  emitHuman(`同步生产部署文件：${to}\n`, ctx.io);
  let stagedFiles: string | null = null;
  // --recover：上次暂存目录仍在且摘要与 checkpoint 一致时直接复用，
  // 保证恢复的是同一候选发布集；任一不符则重新拉取并记录原因。
  const reusableDir = recovering && opts.syncFiles === undefined
    ? await reusableCandidateDir(previous)
    : null;
  try {
    if (opts.syncFiles !== undefined) {
      await runUpdateSync(opts, {
        dir: ctx.dir,
        ref: to,
        repository: opts.repository ?? DEFAULT_UPDATE_REPOSITORY,
      });
    } else if (reusableDir !== null) {
      stagedFiles = reusableDir;
      emitHuman(`复用未完成升级的暂存发布文件：${reusableDir}\n`, ctx.io);
    } else {
      if (recovering) {
        emitHuman(
          "上次暂存发布文件不可复用（缺失或摘要变化），重新拉取\n",
          ctx.io,
        );
      }
      stagedFiles = join(ctx.dir, `.update-staging-${crypto.randomUUID()}`);
      await Deno.mkdir(stagedFiles, { recursive: true });
      await runUpdateSync(opts, {
        dir: stagedFiles,
        ref: to,
        repository: opts.repository ?? DEFAULT_UPDATE_REPOSITORY,
      });
    }
  } catch (err) {
    if (stagedFiles !== null) {
      await Deno.remove(stagedFiles, { recursive: true }).catch(() => {});
    }
    await discardStaged();
    return fail(from, to, (err as Error).message);
  }

  const discardStagedFiles = async (): Promise<void> => {
    if (stagedFiles !== null) {
      await Deno.remove(stagedFiles, { recursive: true }).catch(() => {});
    }
  };

  // ---- 5. 升级序列：解析目标配置 → 备份 → pull → 验签 → 预检 → wait ----
  const upgraded = await upgradeWith(
    opts,
    ctx,
    staged ?? undefined,
    stagedFiles ?? undefined,
  );
  if (upgraded.error !== null) {
    // 候选文件只在升级序列内部“排空后、迁移前”提交；失败分支不再发布任何
    // 目标文件，避免出现“新 compose + 旧版本环境配置”的组合。
    await discardStagedFiles();
    await discardStaged();
    const result = fail(from, to, upgraded.error);
    result.filesSynced = upgraded.filesCommitted === true;
    result.backupPath = upgraded.backupPath;
    return result;
  }
  const updateCheckpoint = async (
    phase: UpgradeState["phase"],
    error?: string,
  ): Promise<void> => {
    const path = upgraded.checkpointPath ?? checkpointPath;
    try {
      const state = await readUpgradeState(path);
      if (state === null || state.phase === "completed") return;
      const next = advanceUpgradeState(
        state,
        phase,
        error === undefined ? {} : { error },
        opts.now ?? new Date(),
      );
      await writeUpgradeState(path, next);
    } catch (stateError) {
      ctx.error(`升级 checkpoint 更新失败：${(stateError as Error).message}`);
    }
  };

  // 暂存配置已在升级序列内“排空后、迁移前”提交；这里只处理退出维护失败。
  // 退出维护失败：服务已升级但仍在维护模式——显式报告半完成（不得静默）
  if (upgraded.drainExitError != null) {
    const result = fail(from, to, upgraded.drainExitError);
    result.filesSynced = upgraded.filesCommitted === true;
    result.backupPath = upgraded.backupPath;
    await updateCheckpoint("failed", upgraded.drainExitError);
    return result;
  }

  // 只有文件、配置、服务健康与退出维护全部成功，才标记完成并清理暂存文件。
  await updateCheckpoint("completed");
  await discardStagedFiles();
  await discardStaged();

  ctx.status("success", latest ? updateSuccessHint(to) : "生产服务已升级");
  return finish({
    dir: ctx.dir,
    state: "running",
    noOp: false,
    exitCode: 0,
    error: null,
    from,
    to,
    latest,
    filesSynced: true,
    backupPath: upgraded.backupPath,
  });
}

/**
 * `upgrade`：`update` 的**别名**（bash :518-519 两个词进同一函数）。
 *
 * 行为与 `update` 完全一致；独立导出只为 CLI 层与 `commands.ts` 的声明同形，
 * 不复制任何编排（别名若有第二份实现，迟早会漂移）。
 */
export async function upgrade(opts: UpdateOptions): Promise<UpdateResult> {
  return await update({ ...opts, latest: false });
}

/** `update` 的 `--json` 载荷（stdout 只含这一个 JSON 文档）。 */

function updatePayload(result: UpdateResult): Record<string, unknown> {
  return {
    dir: result.dir,
    from: result.from,
    to: result.to,
    state: result.state,
    noOp: result.noOp,
    latest: result.latest,
    filesSynced: result.filesSynced,
    backupPath: result.backupPath,
    error: result.error,
  };
}
