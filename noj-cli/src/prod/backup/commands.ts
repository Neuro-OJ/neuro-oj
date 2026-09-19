/**
 * 备份命令面（T18）：`verify` / `list` / `prune` / `restore --dry-run`。
 *
 * ## 三条硬约束（都由测试锁死，且都是实测过的缺陷面）
 *
 * 1. **三档 verify 累加**：默认档（文件完整性）⊂ `--deep`（结构可解析）⊂
 *    `--payload-sha`（payload 摘要）。高档必须在低档失败时也失败——
 *    否则"加个旗标"会让弱检查通过强检查失败的东西。
 * 2. **`prune` 默认 dry-run**：不 `--confirm` 时**零删除**。判定复用
 *    `maintain/backup_index.ts:planPrune`（既有实现，含 legacy 默认保留的语义），
 *    本模块**不重写**该算法。
 * 3. **这些命令都不创建备份**：生产 profile 的 `list`/`prune` 曾误路由到 JSON
 *    模态的创建路径（实测缺陷）。测试断言备份目录在命令前后**逐项不变**。
 *
 * ## 与 `maintain/` 的关系
 *
 * `maintain/backup_index.ts` / `backup_list.ts` 是纯逻辑（无文件系统以外的依赖），
 * 与模态无关，因此**直接复用**：`list` 的产物格式（`SnapshotEntry`）与
 * `snapshot-*.nojbackup` 单文件天然契合（T17 的文件名可在其 `parseBackupName`
 * 下解析）。这两点让 T18 无需为 prod 重写索引与保留策略。
 *
 * 本模块不持有模块级可变状态（AGENTS.md §8.2 多副本约束）。
 */

import { join } from "@std/path";
import {
  listBackups,
  type ListResult,
  pruneBackups,
  type PruneResult,
} from "../../maintain/backup_list.ts";
import type { PruneOptions } from "../../maintain/backup_index.ts";
import {
  CONTAINER_FILES,
  type ContainerPayloadOps,
  verifyContainer,
  type VerifyContainerResult,
} from "./container.ts";

/** `list` 的结果（复用 `maintain/backup_list.ts` 的形状，不新造）。 */
export type BackupListResult = ListResult;

/**
 * `list`：列举备份目录内的快照（`.nojbackup` 单文件 + legacy 目录）。
 *
 * **纯读**：不创建、不修改、不删除任何东西。目录不存在时按"空目录"返回
 * （首次使用是正常状态，不是错误）。
 */
export async function listBackupCommand(
  backupDir: string,
): Promise<BackupListResult> {
  return await listBackups(backupDir);
}

/** {@link pruneCommand} 的结果（在 `PruneResult` 上补充模式信息）。 */
export interface BackupPruneResult extends PruneResult {
  /** 是否真的执行了删除（`--confirm`）。false 即 dry-run。 */
  applied: boolean;
  /** 备份目录。 */
  dir: string;
}

/**
 * `prune`：按计划清理快照，**默认 dry-run**。
 *
 * `confirm !== true` 时只返回计划（`deleted` 恒空），**零文件系统副作用**。
 * 判定完全委托 `maintain/backup_index.ts:planPrune`——包括"两个条件都不给则
 * 什么都不删"与"legacy 默认保留"这两条安全默认。
 */
export async function pruneCommand(
  backupDir: string,
  options: PruneOptions & { confirm?: boolean },
): Promise<BackupPruneResult> {
  const result = await pruneBackups(backupDir, options);
  return { ...result, applied: options.confirm === true, dir: backupDir };
}

/** {@link verifyCommand} 的结果（在容器校验结果上补充路径信息）。 */
export interface BackupVerifyResult extends VerifyContainerResult {
  /** 被校验的容器路径。 */
  path: string;
  /** 汇总文案（人类通道用）。 */
  summary: string;
}

/** {@link verifyCommand} 的注入点。 */
export interface VerifyCommandOptions {
  /** 容器路径（必须是 `.nojbackup` 单文件）。 */
  path: string;
  /** 解包临时目录（调用方负责创建/清理之外的收尾；本函数不删它）。 */
  workDir: string;
  passphraseFile?: string;
  /** 容器是否加密；缺省 true（`create` 的默认产物）。 */
  encrypted?: boolean;
  deep?: boolean;
  payloadSha?: boolean;
  /** 解包/解密操作集。 */
  ops: Pick<ContainerPayloadOps, "gpgDecrypt" | "untarZst">;
}

/**
 * 路径形态守卫：verify/restore/drill 只接受 `.nojbackup` 单文件。
 *
 * 对照 bash `validate_snapshot_path`（:296-300）的意图——那里因为形态是目录而
 * 校验 `snapshot-*` 目录名；纯 TS 重写后形态**唯一**（T17 单文件），故守卫改为
 * 校验后缀，并**明确拒绝** legacy 目录（否则会走到解包失败，报出难以理解的错）。
 */
export function assertContainerPath(path: string): void {
  if (!path.endsWith(".nojbackup")) {
    throw new Error(
      `只支持 .nojbackup 单文件快照：${path}（目录形态的旧快照请先用 backup.sh 迁移）`,
    );
  }
  if (path.split("/").includes("..")) {
    throw new Error(`非法的快照路径：${path}`);
  }
}

/**
 * `verify`：按请求的档位校验容器。
 *
 * 三档**累加**由 `verifyContainer` 保证（高档为 `false` 时低档也必为 `false`，
 * 因为每一档都以上一档为前提）。本函数只做路径守卫、汇总文案与把
 * `skippedDecrypt` 如实转成可操作提示。
 */
export async function verifyCommand(
  opts: VerifyCommandOptions,
): Promise<BackupVerifyResult> {
  assertContainerPath(opts.path);
  const result = await verifyContainer({
    path: opts.path,
    destDir: opts.workDir,
    passphraseFile: opts.passphraseFile,
    encrypted: opts.encrypted ?? true,
    ops: opts.ops,
    deep: opts.deep,
    payloadSha: opts.payloadSha,
  });

  const summary = result.pass
    ? `快照校验通过：${opts.path}` +
      (opts.deep === true ? "（含 --deep 结构校验）" : "") +
      (opts.payloadSha === true ? "（含 --payload-sha 摘要校验）" : "") +
      (result.skippedDecrypt ? "；未提供口令，已跳过环境文件解密" : "")
    : `快照校验失败：${opts.path}\n` +
      result.issues.map((i) => `  - [${i.level}] ${i.message}`).join("\n");

  return { ...result, path: opts.path, summary };
}

// ---------------- restore --dry-run ----------------

/** 恢复计划的一步（dry-run 输出，供人工审阅与自动化断言）。 */
export interface RestoreStep {
  /** 步骤名（英文标识符，便于机器消费）。 */
  name:
    | "verify"
    | "stop-check"
    | "start-infra"
    | "restore-globals"
    | "restore-postgres"
    | "restore-redis"
    | "restore-minio"
    | "stop-infra"
    | "restore-env";
  /** 面向用户的中文说明。 */
  detail: string;
  /** 该步是否**变更**状态（dry-run 下全部不执行）。 */
  mutates: boolean;
}

/** {@link restorePlan} 的结果。 */
export interface BackupRestorePlanResult {
  path: string;
  /** 是否 dry-run（本任务恒为 true，真实恢复未实现）。 */
  dryRun: boolean;
  steps: RestoreStep[];
  /** 校验是否通过（不通过则没有后续步骤）。 */
  verified: boolean;
  manifest: VerifyContainerResult["manifest"];
  issues: VerifyContainerResult["issues"];
  summary: string;
}

/** {@link restorePlan} 的注入点。 */
export interface RestorePlanOptions {
  path: string;
  workDir: string;
  passphraseFile?: string;
  encrypted?: boolean;
  /** 是否把加密的 `.env.prod` 恢复到目标文件（`--restore-env FILE`）。 */
  restoreEnv?: string;
  ops: Pick<ContainerPayloadOps, "gpgDecrypt" | "untarZst">;
  /** judge 是否启用（决定是否含 judge 相关步骤的说明）。 */
  judge?: boolean;
  /** 目标数据卷是否保留（仅用于文案）。 */
  bucket?: string;
}

/**
 * `restore --dry-run`：完整规划恢复步骤，**零副作用**。
 *
 * 与真实 restore 的区别只有"执行"这一步：解包、校验、步骤规划全部真实发生
 * （否则 dry-run 会漏掉"快照根本解不开"这类问题），但**不碰 docker**、
 * 不写目标数据、不改 `.env.prod`。
 *
 * 这也是为什么本函数接受 `ops` 但**只要** `gpgDecrypt`/`untarZst` 两项：
 * 类型上就没有采集与恢复能力，想越权必须先改签名。
 *
 * 真实恢复（写目标数据）**本任务不实现**：它是不可逆操作，需要与 drill 同级的
 * 隔离与确认设计（T19 之后的独立任务）。
 */
export async function restorePlan(
  opts: RestorePlanOptions,
): Promise<BackupRestorePlanResult> {
  assertContainerPath(opts.path);
  const verified = await verifyContainer({
    path: opts.path,
    destDir: opts.workDir,
    passphraseFile: opts.passphraseFile,
    encrypted: opts.encrypted ?? true,
    ops: opts.ops,
    deep: true,
  });

  const steps: RestoreStep[] = [{
    name: "verify",
    detail: "解包并校验快照（文件完整性 + 结构可解析）",
    mutates: false,
  }];
  if (verified.pass) {
    steps.push({
      name: "stop-check",
      detail: "确认 Compose 服务已停止（恢复前必须停机）",
      mutates: false,
    });
    steps.push({
      name: "start-infra",
      detail: "启动 postgres / redis / minio 并等待健康",
      mutates: true,
    });
    steps.push({
      name: "restore-globals",
      detail:
        `恢复 PostgreSQL 全局对象（${CONTAINER_FILES.postgresGlobals}，已幂等化）`,
      mutates: true,
    });
    steps.push({
      name: "restore-postgres",
      detail:
        `pg_restore --clean --if-exists --no-owner --exit-on-error < ${CONTAINER_FILES.postgresDump}`,
      mutates: true,
    });
    steps.push({
      name: "restore-redis",
      detail: `停止 redis → 写入 ${CONTAINER_FILES.redisRdb} → 重新启动`,
      mutates: true,
    });
    steps.push({
      name: "restore-minio",
      detail: `mc mirror --overwrite --remove 到桶 ${
        opts.bucket ?? "noj-support-packages"
      }`,
      mutates: true,
    });
    steps.push({
      name: "stop-infra",
      detail: "停止 postgres / redis / minio，等待人工检查后再启动业务服务",
      mutates: true,
    });
    if (opts.restoreEnv !== undefined && opts.restoreEnv !== "") {
      steps.push({
        name: "restore-env",
        detail: `把加密环境文件恢复到 ${opts.restoreEnv}`,
        mutates: true,
      });
    }
  }

  const summary = verified.pass
    ? `[dry-run] 将按 ${steps.length} 步恢复：${opts.path}（未执行任何变更）`
    : `[dry-run] 快照校验未通过，恢复不可行：${opts.path}\n` +
      verified.issues.map((i) => `  - [${i.level}] ${i.message}`).join("\n");

  return {
    path: opts.path,
    dryRun: true,
    steps,
    verified: verified.pass,
    manifest: verified.manifest,
    issues: verified.issues,
    summary,
  };
}

/** 备份目录内快照数量的便捷读取（供 `--json` 载荷）。 */
export async function backupCount(backupDir: string): Promise<number> {
  const { entries } = await listBackups(backupDir);
  return entries.length;
}

/**
 * prod 侧的默认备份子目录（`<install-dir>/backups`）。
 *
 * 命名带 `prod` 前缀是**有意**的：`maintain/backup.ts` 已导出同名的
 * `defaultBackupDir(config)`（JSON 模态，签名也不同）。两者在 T23 收敛前并存，
 * 同名会让包入口（`mod.ts`）的再导出撞名——而"撞名"正是双模态遗留问题的表征，
 * 不应靠改名掩盖，故这里用前缀显式区分，并在 T23 一并收敛。
 *
 * 落点与 `install` 的 `record-metadata` 一致（`<dir>/backups`）。
 */
export function prodBackupDir(installDir: string): string {
  return join(installDir, "backups");
}
