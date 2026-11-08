/**
 * `.nojbackup` 单文件容器格式（T17）。
 *
 * ## 形态（spec `2026-09-19-noj-cli-production-unification-design.md` §3.1）
 *
 * ```text
 * snapshot-<ts>.nojbackup
 * └─ gpg(AES256, <passphrase>)         ← **整包**加密（不是只加密 env）
 *    └─ tar.zst
 *       ├─ manifest.json               schema_version / payload_layout / created_at / files
 *       ├─ postgres.dump               pg_dump -Fc **原始二进制**
 *       ├─ postgres-globals.sql
 *       ├─ redis.rdb                   redis-cli --rdb **原始二进制**
 *       ├─ minio/…
 *       ├─ env.prod.gpg
 *       ├─ migration-status.txt
 *       ├─ sha256sums.txt
 *       └─ SUCCESS
 * ```
 *
 * `payload_layout` 恒为 {@link PAYLOAD_LAYOUT}（`"prod-raw"`）：**唯一形态**，
 * 没有历史兼容负担，因此不存在"按布局分派"的分支。
 *
 * ## 为什么单文件 + 整包加密（#515 P2）
 *
 * 旧形态是 `snapshot-<ts>/` **目录**，其中只有 `env.prod.gpg` 是加密的，其余
 * （含 `postgres.dump`）都是明文。目录形态有两个后果：搬迁会漏文件；
 * "加密备份"名不副实——任何能读目录的人都拿得到全库转储。单文件 + 整包加密
 * 同时解决这两点，且 sha256 有唯一锚点（整个文件）。
 *
 * ## 与 `maintain/backup.ts`（JSON 模式）的关系
 *
 * 那套是 `noj-deploy.json` 双模态时代的产物：payload 走 **stdout 字符串**
 * （`backup_driver.ts:114` 注释说明二进制因此要 base64）。本模块是 prod 侧的
 * 重写，**payload 走文件重定向**（见 `driver.ts`），二进制不经字符串。
 * 两者在 T23 收敛前并存，互不 import。
 *
 * ## 边界（不得越界）
 *
 * 1. **一切外部命令经注入的 {@link BackupContainerDriver}**：本模块不 spawn、
 *    不拼 shell 字符串；
 * 2. **不读大文件进内存**：摘要用流式（{@link fileSha256HexStreaming}），
 *    打包/加密/解包全部委托给 driver；
 * 3. **原子落盘**：产物先写临时名再 `rename`；失败路径清理 staging 与临时产物；
 * 4. 本模块不持有模块级可变状态（AGENTS.md §8.2 多副本约束）。
 *
 * ## 文件划分（门面）
 *
 * 本文件是门面：容器格式的常量与类型（本文件）、校验和（`container-checksums.ts`）、
 * 路径辅助（`container-paths.ts`）、创建（`container-create.ts`）、解包
 * （`container-unpack.ts`）与校验（`container-verify.ts`）分列；对外导出集合不变。
 */

/** payload 布局标记（唯一形态）。 */
export const PAYLOAD_LAYOUT = "prod-raw";

/** 容器 format/schema 版本。 */
export const SCHEMA_VERSION = 1;

/** 容器内固定文件名（与 spec §3.1 的树逐字对应）。 */
export const CONTAINER_FILES = {
  manifest: "manifest.json",
  checksums: "sha256sums.txt",
  success: "SUCCESS",
  postgresDump: "postgres.dump",
  postgresGlobals: "postgres-globals.sql",
  postgresRestoreList: "postgres.restore-list",
  redisRdb: "redis.rdb",
  redisPersistence: "redis-persistence.txt",
  envProdGpg: "env.prod.gpg",
  migrationStatus: "migration-status.txt",
  minioDir: "minio",
} as const;

/** `SUCCESS` 哨兵的内容（bash `backup.sh:290` 写 `'success\\n'`）。 */
export const SUCCESS_MARKER = "success";

/** `.nojbackup` 文件后缀。 */
export const BACKUP_SUFFIX = ".nojbackup";

/**
 * 容器文件的校验文件后缀（sidecar）。
 *
 * **为什么摘要不能在 manifest 里**（重要，见本模块 {@link createContainer} 的
 * "自指不可能"注释）：manifest 位于容器**内部**，因此它无法记录自己所在文件的
 * 摘要——"写入摘要 → 摘要改变 → 再写入"是无限回归。
 * 因此最终产物的 SHA-256 落在与容器**同级**的 `<容器名>.sha256` 里，
 * 格式沿用仓库既有约定（与 Release 资产的 `noj-cli-linux-amd64.sha256` 一致：
 * `<64 位十六进制>  <文件名>`），便于 `sha256sum -c` 直接校验。
 */
export const CHECKSUM_SUFFIX = ".sha256";

/**
 * manifest.json 的形状（字段名与 `backup.sh:271-283` 的 JSON **逐字对应**，
 * 只多了单文件容器必需的 `schema_version` / `payload_layout` / `encrypted` /
 * `zstd_level` / `sha256` / `files`）。
 */
export interface BackupManifest {
  /** 容器格式版本。 */
  schema_version: number;
  /** payload 布局（恒为 `"prod-raw"`）。 */
  payload_layout: string;
  /** 创建时间（UTC，`%Y-%m-%dT%H:%M:%SZ`）。 */
  created_at: string;
  /** 是否整包加密（`--no-encrypt` 时为 false）。 */
  encrypted: boolean;
  /** zstd 压缩级别（复现打包参数）。 */
  zstd_level: number;
  /** staging 内的文件清单（容器内相对路径，已排序）。 */
  files: string[];
  /** PostgreSQL 数据库名（bash 字段）。 */
  postgres_database: string;
  /** Redis 策略说明（bash 字段）。 */
  redis_policy: string;
  /** 对象存储说明（bash 字段）。 */
  object_storage: string;
  /** PostgreSQL 备份模式（bash 字段）。 */
  postgres_backup_mode: string;
  /** 增量策略说明（bash 字段）。 */
  incremental_policy: string;
  /** RPO 说明（bash 字段）。 */
  rpo: string;
  /** RTO 说明（bash 字段）。 */
  rto: string;
  /** 保留天数（bash 字段）。 */
  retention_days: number;
}

/**
 * bash `backup.sh:271-283` 的说明性字段默认值（逐字）。
 *
 * 抽成常量而不是散在调用点：T19 的 drill 与文档都会引用同一套措辞。
 */
export const MANIFEST_DEFAULTS = {
  redis_policy: "RDB snapshot; judge queue is recoverable transient data",
  object_storage: "MinIO/S3 mirror",
  postgres_backup_mode: "logical-full",
  incremental_policy:
    "MinIO mirror is incremental; PostgreSQL WAL/PITR requires external infrastructure",
  rpo: "snapshot interval configured by scheduler",
  rto: "restore duration depends on database and object volume",
} as const;

/** 默认保留天数（bash `NOJ_BACKUP_RETENTION_DAYS` 缺省 30）。 */
export const DEFAULT_RETENTION_DAYS = 30;

/** 默认 zstd 级别（与 `maintain/backup.ts` 的缺省一致）。 */
export const DEFAULT_ZSTD_LEVEL = 15;

/** 容器创建/解包的阶段名（用于错误定位与测试断言）。 */
export type ContainerStage =
  | "staging"
  | "postgres"
  | "redis"
  | "minio"
  | "env"
  | "checksums"
  | "archive"
  | "encrypt"
  | "commit";

/** 容器操作失败时抛出的错误（带阶段，便于可操作诊断）。 */
export class ContainerError extends Error {
  constructor(readonly stage: ContainerStage, message: string) {
    super(`备份容器${stageLabel(stage)}失败：${message}`);
    this.name = "ContainerError";
  }
}

/** 阶段的中文标签（用于错误文案）。 */
function stageLabel(stage: ContainerStage): string {
  switch (stage) {
    case "staging":
      return "暂存";
    case "postgres":
      return "PostgreSQL";
    case "redis":
      return "Redis";
    case "minio":
      return "MinIO/S3";
    case "env":
      return "环境文件加密";
    case "checksums":
      return "校验和";
    case "archive":
      return "打包";
    case "encrypt":
      return "加密";
    case "commit":
      return "提交";
  }
}

// ---------------- 分文件实现（本门面原样重导，对外导出集合不变） ----------------

export { fileSha256HexStreaming } from "./sha256.ts";

export {
  type ChecksumEntry,
  parseChecksums,
  renderChecksums,
} from "./container-checksums.ts";

export {
  allocateContainerPath,
  containerFileName,
  listFiles,
  tempContainerPath,
  utcTimestamp,
} from "./container-paths.ts";

export {
  type ContainerPayloadOps,
  createContainer,
  type CreateContainerOptions,
  type CreateContainerResult,
} from "./container-create.ts";

export {
  readManifest,
  unpackContainer,
  type UnpackContainerOptions,
  type UnpackContainerResult,
} from "./container-unpack.ts";

export {
  verifyContainer,
  type VerifyContainerOptions,
  type VerifyContainerResult,
  type VerifyIssue,
} from "./container-verify.ts";
