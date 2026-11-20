/**
 * 生产升级 checkpoint（P8）。
 *
 * checkpoint 只记录可恢复编排所需的公开事实，不保存口令、token、环境值或
 * compose 输出。阶段单调推进，写入原子化；中断后 CLI 可以明确发现未完成升级，
 * 要求显式 `--recover` 重新执行固定序列，而不会把半完成状态误报成成功。
 */

import { dirname, join } from "@std/path";
import { validateReleaseTag } from "./release.ts";

export const UPGRADE_STATE_SCHEMA_VERSION = 1 as const;
export const UPGRADE_STATE_FILE = "upgrade-state.json";

export const UPGRADE_PHASES = [
  "resolved",
  "backed_up",
  "pulled",
  "verified",
  "draining",
  "committing",
  "migrating",
  "started",
  "completed",
  "failed",
] as const;

export type UpgradePhase = (typeof UPGRADE_PHASES)[number];

/** 候选发布文件摘要；恢复时据此确认暂存文件未被替换。 */
export interface UpgradeCandidateFile {
  name: string;
  sha256: string;
}

export interface UpgradeState {
  schema_version: typeof UPGRADE_STATE_SCHEMA_VERSION;
  run_id: string;
  from: string;
  to: string;
  phase: UpgradePhase;
  backup_path: string | null;
  release_set_release: string | null;
  error: string | null;
  updated_at: string;
  /** 本次候选发布文件（安装目录内文件名 + SHA-256）；旧 checkpoint 缺省为空。 */
  files: UpgradeCandidateFile[];
  /** 候选文件暂存目录；缺失表示本次升级没有暂存文件集。 */
  files_staged_dir: string | null;
  /** 是否已经开始执行数据库迁移；一旦为 true，失败后不得自动回退旧程序。 */
  migration_started: boolean;
}

const PHASE_INDEX = new Map<UpgradePhase, number>(
  UPGRADE_PHASES.map((phase, index) => [phase, index]),
);

export function upgradeStatePath(dir: string): string {
  return join(dir, "backups", UPGRADE_STATE_FILE);
}

export function createUpgradeState(input: {
  runId: string;
  from: string;
  to: string;
  now?: Date;
  releaseSetRelease?: string | null;
}): UpgradeState {
  validateReleaseTag(input.to);
  if (input.from !== "") validateReleaseTag(input.from);
  if (input.runId.trim() === "") throw new Error("升级 checkpoint 缺少 run_id");
  return {
    schema_version: UPGRADE_STATE_SCHEMA_VERSION,
    run_id: input.runId,
    from: input.from,
    to: input.to,
    phase: "resolved",
    backup_path: null,
    release_set_release: input.releaseSetRelease ?? null,
    error: null,
    updated_at: (input.now ?? new Date()).toISOString(),
    files: [],
    files_staged_dir: null,
    migration_started: false,
  };
}

/** 推进单调阶段；failed 是终止态，completed 后不允许再改写。 */
export function advanceUpgradeState(
  state: UpgradeState,
  phase: UpgradePhase,
  patch: Partial<
    Pick<
      UpgradeState,
      | "backup_path"
      | "release_set_release"
      | "error"
      | "files"
      | "files_staged_dir"
      | "migration_started"
    >
  > = {},
  now = new Date(),
): UpgradeState {
  const currentIndex = PHASE_INDEX.get(state.phase)!;
  const nextIndex = PHASE_INDEX.get(phase)!;
  if (state.phase === "completed") {
    throw new Error("已完成的升级 checkpoint 不可再次推进");
  }
  if (
    phase !== "failed" && state.phase !== "failed" && nextIndex < currentIndex
  ) {
    throw new Error(`升级 checkpoint 不允许回退：${state.phase} -> ${phase}`);
  }
  if (phase === "completed" && state.phase === "failed") {
    throw new Error("失败的升级 checkpoint 不可标记为完成");
  }
  if (phase === "completed" && state.phase !== "started") {
    throw new Error(
      `升级 checkpoint 只能从 started 标记为完成，当前为 ${state.phase}`,
    );
  }
  return {
    ...state,
    phase,
    backup_path: patch.backup_path === undefined
      ? state.backup_path
      : patch.backup_path,
    release_set_release: patch.release_set_release === undefined
      ? state.release_set_release
      : patch.release_set_release,
    error: patch.error === undefined
      ? (phase === "failed" ? state.error : null)
      : patch.error,
    files: patch.files === undefined ? state.files : patch.files,
    files_staged_dir: patch.files_staged_dir === undefined
      ? state.files_staged_dir
      : patch.files_staged_dir,
    migration_started: patch.migration_started === undefined
      ? state.migration_started
      : patch.migration_started,
    updated_at: now.toISOString(),
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`升级 checkpoint ${label} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`升级 checkpoint ${label} 必须是字符串`);
  }
  return value;
}

export function validateUpgradeState(value: unknown): UpgradeState {
  const root = record(value, "根");
  if (root.schema_version !== UPGRADE_STATE_SCHEMA_VERSION) {
    throw new Error("升级 checkpoint schema_version 非法");
  }
  const phase = stringValue(root.phase, "phase") as UpgradePhase;
  if (!PHASE_INDEX.has(phase)) {
    throw new Error(`升级 checkpoint phase 非法：${phase}`);
  }
  const runId = stringValue(root.run_id, "run_id");
  const from = stringValue(root.from, "from");
  const to = stringValue(root.to, "to");
  if (runId.trim() === "") throw new Error("升级 checkpoint run_id 不能为空");
  if (from !== "") validateReleaseTag(from);
  validateReleaseTag(to);
  const backupPath = root.backup_path;
  if (backupPath !== null && typeof backupPath !== "string") {
    throw new Error("升级 checkpoint backup_path 非法");
  }
  const releaseSetRelease = root.release_set_release;
  if (releaseSetRelease !== null && typeof releaseSetRelease !== "string") {
    throw new Error("升级 checkpoint release_set_release 非法");
  }
  if (releaseSetRelease !== null) validateReleaseTag(releaseSetRelease);
  const error = root.error;
  if (error !== null && typeof error !== "string") {
    throw new Error("升级 checkpoint error 非法");
  }
  const updatedAt = stringValue(root.updated_at, "updated_at");
  if (Number.isNaN(Date.parse(updatedAt))) {
    throw new Error("升级 checkpoint updated_at 非法");
  }
  // 旧 checkpoint 没有下列字段：缺省视为“无候选文件、未开始迁移”，
  // 恢复逻辑据此要求显式说明而不是猜测阶段。
  const files: UpgradeCandidateFile[] = [];
  const filesValue = root.files;
  if (filesValue !== undefined && filesValue !== null) {
    if (!Array.isArray(filesValue)) {
      throw new Error("升级 checkpoint files 必须是数组");
    }
    for (const entry of filesValue) {
      const item = record(entry, "files 条目");
      const name = stringValue(item.name, "files.name");
      const sha256 = stringValue(item.sha256, "files.sha256");
      if (
        name === "" || name.includes("/") || name.includes("\\") ||
        name.startsWith(".")
      ) {
        throw new Error(`升级 checkpoint 文件名非法：${name}`);
      }
      if (!/^[0-9a-f]{64}$/.test(sha256)) {
        throw new Error(`升级 checkpoint 文件摘要非法：${name}`);
      }
      files.push({ name, sha256 });
    }
  }
  const stagedDirValue = root.files_staged_dir;
  if (
    stagedDirValue !== undefined && stagedDirValue !== null &&
    typeof stagedDirValue !== "string"
  ) {
    throw new Error("升级 checkpoint files_staged_dir 非法");
  }
  const migrationStartedValue = root.migration_started;
  if (
    migrationStartedValue !== undefined &&
    typeof migrationStartedValue !== "boolean"
  ) {
    throw new Error("升级 checkpoint migration_started 非法");
  }
  return {
    schema_version: UPGRADE_STATE_SCHEMA_VERSION,
    run_id: runId,
    from,
    to,
    phase,
    backup_path: backupPath as string | null,
    release_set_release: releaseSetRelease as string | null,
    error: error as string | null,
    updated_at: updatedAt,
    files,
    files_staged_dir: (stagedDirValue as string | null | undefined) ?? null,
    migration_started: migrationStartedValue === true,
  };
}

export async function writeUpgradeState(
  path: string,
  state: UpgradeState,
): Promise<void> {
  const validated = validateUpgradeState(state);
  await Deno.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${Deno.pid}.${crypto.randomUUID()}`;
  try {
    await Deno.writeTextFile(tmp, JSON.stringify(validated, null, 2) + "\n");
    await Deno.chmod(tmp, 0o600);
    await Deno.rename(tmp, path);
    await Deno.chmod(path, 0o600);
  } catch (error) {
    await Deno.remove(tmp).catch(() => {});
    throw new Error(
      `无法写入升级 checkpoint：${path}（${(error as Error).message}）`,
      { cause: error },
    );
  }
}

export async function readUpgradeState(
  path: string,
): Promise<UpgradeState | null> {
  try {
    return validateUpgradeState(JSON.parse(await Deno.readTextFile(path)));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw new Error(
      `无法读取升级 checkpoint：${path}（${(error as Error).message}）`,
      { cause: error },
    );
  }
}
