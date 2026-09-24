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
 */

import { dirname, join } from "@std/path";
import { fileSha256HexStreaming } from "./sha256.ts";

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

/**
 * 有界内存地计算文件 SHA-256（委托 `./sha256.ts` 的纯 TS 增量实现）。
 *
 * **不用** `util/hash.ts:fileSha256Hex`——那个 `Deno.readFile` 整读，对数百 MB
 * 的 `postgres.dump` 会吃满内存。方案取舍见 `./sha256.ts` 的模块 JSDoc。
 */
export { fileSha256HexStreaming };

/** staging 内一个文件的相对路径与摘要。 */
export interface ChecksumEntry {
  relPath: string;
  sha256: string;
}

/**
 * 生成 `sha256sums.txt` 正文（`backup.sh:187-195` 的等价）。
 *
 * 逐字对齐三点：
 * - 每行 `<摘要>  <相对路径>`（**两个空格**，sha256sum 的 GNU 格式）；
 * - `sha256sums.txt` **自身不入选**；
 * - 顺序按 `LC_ALL=C sort`（即 UTF-8 字节序；JS 的默认字符串比较对 BMP
 *   内的 ASCII 与 UTF-8 字节序一致，故直接用 `sort()` 即可，但为避免非 ASCII
 *   路径的差异，这里显式按码点比较并注明）。
 */
export function renderChecksums(entries: readonly ChecksumEntry[]): string {
  const sorted = [...entries].sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0
  );
  return sorted.map((e) => `${e.sha256}  ${e.relPath}`).join("\n") +
    (sorted.length > 0 ? "\n" : "");
}

/**
 * 解析 `sha256sums.txt`（verify 用）。
 *
 * 宽容解析：跳过空行；每行按**首个两空格**切分（路径自身可能含空格，
 * 故不能用 `split(" ")`）。格式非法即抛错——静默跳过会让校验形同虚设。
 */
export function parseChecksums(text: string): ChecksumEntry[] {
  const out: ChecksumEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const sep = line.indexOf("  ");
    if (sep <= 0) throw new Error(`sha256sums.txt 行格式非法：${line}`);
    const sha256 = line.slice(0, sep);
    const relPath = line.slice(sep + 2);
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`sha256sums.txt 摘要非法：${line}`);
    }
    out.push({ relPath, sha256 });
  }
  return out;
}

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

/**
 * 备份产物的文件名（`snapshot-<ts>` + {@link BACKUP_SUFFIX}）。
 *
 * 时间戳格式 `%Y%m%d-%H%M%S`（bash `backup.sh:238` 的 `date '+%Y%m%d-%H%M%S'`），
 * 可在 `prod/backup/index.ts:parseBackupName` 的既有解析下工作，从而让
 * `list`/`prune` 无需感知容器细节。
 */
export function containerFileName(ts: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  const stamp =
    `${ts.getUTCFullYear()}${p(ts.getUTCMonth() + 1)}${p(ts.getUTCDate())}` +
    `-${p(ts.getUTCHours())}${p(ts.getUTCMinutes())}${p(ts.getUTCSeconds())}`;
  return `snapshot-${stamp}${BACKUP_SUFFIX}`;
}

/**
 * 在 `backupDir` 中挑一个**未被占用**的容器路径（bash `:239-243` 的等价）。
 *
 * bash 用 `-e` 判存在并在冲突时追加 `-<index>`；本实现同样追加序号，
 * 保证既不覆盖既有快照，也不因并发创建而互相踩踏。
 */
export async function allocateContainerPath(
  backupDir: string,
  ts: Date,
): Promise<string> {
  const base = containerFileName(ts).slice(0, -BACKUP_SUFFIX.length);
  let candidate = join(backupDir, base + BACKUP_SUFFIX);
  let index = 1;
  while (await pathExists(candidate)) {
    candidate = join(backupDir, `${base}-${index}${BACKUP_SUFFIX}`);
    index++;
  }
  return candidate;
}

/** `-e` 语义的存在性判定（含悬空软链）。 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** 格式化为 bash `date -u '+%Y-%m-%dT%H:%M:%SZ'` 的 UTC 时间戳。 */
export function utcTimestamp(ts: Date): string {
  return ts.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * 递归列出 staging 内的文件（相对路径，不排序；排序由 {@link renderChecksums}
 * 与 manifest 各自的调用点决定）。
 */
export async function listFiles(
  dir: string,
  base = "",
): Promise<string[]> {
  const out: string[] = [];
  const entries = await Array.fromAsync(Deno.readDir(dir));
  for (const entry of entries) {
    const rel = `${base}${entry.name}`;
    if (entry.isDirectory) {
      out.push(...await listFiles(join(dir, entry.name), `${rel}/`));
    } else {
      out.push(rel);
    }
  }
  return out;
}

/**
 * 临时产物名（同目录，保证 `rename` 是原子提交而非跨设备拷贝）。
 *
 * 前缀是 `.` 开头，`list`/`prune` 不会把它当成快照（`snapshot-*` 匹配），
 * 且失败清理时有明确的识别标志。
 */
export function tempContainerPath(finalPath: string): string {
  return join(
    dirname(finalPath),
    `.nojbackup-${Deno.pid}-${crypto.randomUUID()}.tmp`,
  );
}

// ---------------- 容器创建（create） ----------------

/** {@link createContainer} 的注入点。 */
export interface CreateContainerOptions {
  /** 备份根目录（产物落点）。 */
  backupDir: string;
  /** staging 目录的父目录；缺省用 `backupDir`（保证 rename 同设备）。 */
  stagingParent?: string;
  /** 口令文件路径；`--no-encrypt` 时可为空。 */
  passphraseFile?: string;
  /** 不加密（仍产出单文件容器）。 */
  noEncrypt?: boolean;
  /** zstd 级别；缺省 {@link DEFAULT_ZSTD_LEVEL}。 */
  zstdLevel?: number;
  /** 保留天数（写入 manifest）。 */
  retentionDays?: number;
  /** `.env.prod` 路径（加密进容器）。 */
  envFile: string;
  /** PostgreSQL 数据库名（写入 manifest）。 */
  postgresDatabase: string;
  /** 迁移状态文本（bash `record_migration_status` 的结果，T18 接真实查询）。 */
  migrationStatus: string;
  /** 采集与打包操作集（注入；生产为 `createProdPayloadOps`）。 */
  ops: ContainerPayloadOps;
  /** 时间戳（测试注入固定值）。 */
  now?: Date;
}

/** 容器创建/解包所需的操作（`ProdPayloadOps` 的子集，便于测试注入 fake）。 */
export interface ContainerPayloadOps {
  postgresDump(destFile: string): Promise<void>;
  postgresGlobals(destFile: string): Promise<void>;
  postgresRestoreList(dumpFile: string, destFile: string): Promise<void>;
  redisRdb(destFile: string): Promise<void>;
  redisPersistence(destFile: string): Promise<void>;
  minioMirror(destDir: string): Promise<void>;
  /** 把 `.env.prod` 加密到 dest（**只加密 env**，因为整包还会再加密一次）。 */
  gpgEncrypt(src: string, dest: string, passphraseFile: string): Promise<void>;
  gpgDecrypt(src: string, dest: string, passphraseFile: string): Promise<void>;
  tarZst(stagingDir: string, dest: string, zstdLevel: number): Promise<void>;
  untarZst(src: string, destDir: string): Promise<void>;
}

/** 容器创建结果。 */
export interface CreateContainerResult {
  /** 最终 `.nojbackup` 路径。 */
  path: string;
  /**
   * 最终产物的 SHA-256（整包密文；因 GPG 的随机 IV/salt，每次运行都不同）。
   *
   * 同时被写进同级 sidecar `<路径>.sha256`，供 `sha256sum -c` 直接校验。
   */
  sha256: string;
  /** sidecar 校验文件路径（`<容器>.sha256`）。 */
  sidecar: string;
  /** 完整的 manifest（便于调用方回报与测试断言）。 */
  manifest: BackupManifest;
}

/**
 * 创建 `.nojbackup` 单文件容器（`backup.sh create_snapshot` :224-294 的等价）。
 *
 * 编排（顺序即断言）：
 * 1. staging 目录（`0700`）；
 * 2. PostgreSQL：`pg_dump -Fc` → `postgres.dump`（**二进制，文件重定向**）；
 *    `pg_dumpall --globals-only` → `postgres-globals.sql`；
 *    `pg_restore --list < dump` → `postgres.restore-list`（**结构校验**，
 *    这是二进制静默损坏的唯一可检测信号，必须进成功路径）；
 * 3. Redis：`redis-cli --rdb -` → `redis.rdb`（**二进制**）+ `INFO persistence`；
 * 4. MinIO：`mc mirror` → `minio/`；
 * 5. `.env.prod` → `env.prod.gpg`（单文件加密；整包还会再加密）；
 * 6. `migration-status.txt`（内容由 `migrationStatus` 回调给出，T18 接真实查询）；
 * 7. `sha256sums.txt`（覆盖除自身外全部文件）+ `SUCCESS` + `manifest.json`；
 * 8. 权限 `go-rwx`；
 * 9. `tar -I zstd` 打包 → `tar.zst`（**第一轮**）；取其摘要写入 manifest；
 *    写入 manifest 后**重新打包**（**第二轮**）——manifest 自身要进包；
 * 10. 加密（整包）到**临时名**；`rename` 原子提交到最终名。
 *
 * **失败零残留**：staging 与临时产物在 `finally` 中清理；任何阶段失败都不会
 * 在备份目录留下半成品 `.nojbackup`（`list`/`prune` 因此不会误认）。
 */
export async function createContainer(
  opts: CreateContainerOptions,
): Promise<CreateContainerResult> {
  const now = opts.now ?? new Date();
  const zstdLevel = opts.zstdLevel ?? DEFAULT_ZSTD_LEVEL;
  const noEncrypt = opts.noEncrypt === true;
  const passphraseFile = opts.passphraseFile ?? "";

  if (!noEncrypt && passphraseFile === "") {
    // bash :227 的等价：缺口令且未显式关闭加密 → 拒绝（不产出未加密的"备份"）
    throw new ContainerError(
      "encrypt",
      "缺少 GPG 口令文件（或用 --no-encrypt 显式关闭加密）",
    );
  }

  await Deno.mkdir(opts.backupDir, { recursive: true, mode: 0o700 });
  const stagingParent = opts.stagingParent ?? opts.backupDir;
  const staging = await Deno.makeTempDir({
    dir: stagingParent,
    prefix: ".nojbackup-staging-",
  });
  const tarZst = `${staging}.tar.zst`;
  let encrypted: string | null = null;
  let committed = false;

  try {
    // ---- 1. staging 权限 0700（bash mkdir -m 700）----
    await Deno.chmod(staging, 0o700);

    // ---- 2. PostgreSQL（二进制经文件重定向）----
    const dumpFile = join(staging, CONTAINER_FILES.postgresDump);
    try {
      await opts.ops.postgresDump(dumpFile);
      await opts.ops.postgresGlobals(
        join(staging, CONTAINER_FILES.postgresGlobals),
      );
      // 结构校验：dump 必须能被 pg_restore 解析（二进制损坏的唯一检出点）
      await opts.ops.postgresRestoreList(
        dumpFile,
        join(staging, CONTAINER_FILES.postgresRestoreList),
      );
    } catch (err) {
      if (err instanceof ContainerError) throw err;
      throw new ContainerError("postgres", (err as Error).message);
    }

    // ---- 3. Redis（二进制经文件重定向）----
    try {
      await opts.ops.redisRdb(join(staging, CONTAINER_FILES.redisRdb));
      await opts.ops.redisPersistence(
        join(staging, CONTAINER_FILES.redisPersistence),
      );
    } catch (err) {
      if (err instanceof ContainerError) throw err;
      throw new ContainerError("redis", (err as Error).message);
    }

    // ---- 4. MinIO/S3 对象镜像 ----
    try {
      await opts.ops.minioMirror(join(staging, CONTAINER_FILES.minioDir));
    } catch (err) {
      if (err instanceof ContainerError) throw err;
      throw new ContainerError("minio", (err as Error).message);
    }

    // ---- 5. 环境文件加密（单文件；整包还会再加密）----
    try {
      await opts.ops.gpgEncrypt(
        opts.envFile,
        join(staging, CONTAINER_FILES.envProdGpg),
        passphraseFile,
      );
    } catch (err) {
      if (err instanceof ContainerError) throw err;
      throw new ContainerError("env", (err as Error).message);
    }

    // ---- 6. 迁移状态 ----
    await Deno.writeTextFile(
      join(staging, CONTAINER_FILES.migrationStatus),
      opts.migrationStatus.endsWith("\n")
        ? opts.migrationStatus
        : opts.migrationStatus + "\n",
    );

    // ---- 7. 哨兵 ----
    await Deno.writeTextFile(
      join(staging, CONTAINER_FILES.success),
      SUCCESS_MARKER + "\n",
    );

    // ---- 8. manifest 先落盘（顺序重要：checksums 必须覆盖 manifest）----
    // bash `write_checksums`（:187-195）覆盖 staging 内**除自身以外的全部文件**，
    // 包含它之前写入的 manifest。因此这里必须"先写 manifest、再算 checksums"——
    // 反过来会让 manifest 游离在校验之外（实测中被 T17 的覆盖用例抓出）。
    //
    // `files` 清单是**预测**：此刻 checksums 尚未写出，故显式把它自己也算进去。
    const manifest: BackupManifest = {
      schema_version: SCHEMA_VERSION,
      payload_layout: PAYLOAD_LAYOUT,
      created_at: utcTimestamp(now),
      encrypted: !noEncrypt,
      zstd_level: zstdLevel,
      files: [
        ...(await listFiles(staging)),
        CONTAINER_FILES.manifest,
        CONTAINER_FILES.checksums,
      ].sort(),
      postgres_database: opts.postgresDatabase,
      retention_days: opts.retentionDays ?? DEFAULT_RETENTION_DAYS,
      ...MANIFEST_DEFAULTS,
    };
    await Deno.writeTextFile(
      join(staging, CONTAINER_FILES.manifest),
      JSON.stringify(manifest, null, 2) + "\n",
    );

    // ---- 9. checksums：覆盖除自身外的全部文件（含 manifest）----
    const checksumEntries: ChecksumEntry[] = [];
    for (const rel of await listFiles(staging)) {
      if (rel === CONTAINER_FILES.checksums) continue;
      checksumEntries.push({
        relPath: rel,
        sha256: await fileSha256HexStreaming(join(staging, rel)),
      });
    }
    await Deno.writeTextFile(
      join(staging, CONTAINER_FILES.checksums),
      renderChecksums(checksumEntries),
    );

    // ---- 9b. 单轮打包（manifest 不引用自身归档的摘要，见下方"自指不可能"）----
    // **自指不可能**：manifest 位于容器内部，无法记录自己所在文件的摘要
    // （"写摘要 → 摘要变 → 再写"是无限回归）。因此容器内容的整体摘要落在
    // **同级 sidecar** `<容器名>.sha256`（见 CHECKSUM_SUFFIX），格式与仓库既有
    // Release 资产校验文件一致，可直接 `sha256sum -c`。
    // 单轮打包也因此足够：manifest 不需要引用它所属归档的摘要。
    await opts.ops.tarZst(staging, tarZst, zstdLevel);

    // ---- 10. 收紧权限（bash chmod -R go-rwx）----
    await chmodPrivate(staging);

    // ---- 11. 整包加密 + 原子提交 ----
    const finalPath = await allocateContainerPath(opts.backupDir, now);
    const tempPath = tempContainerPath(finalPath);
    try {
      if (noEncrypt) {
        await Deno.copyFile(tarZst, tempPath);
      } else {
        encrypted = tempPath;
        await opts.ops.gpgEncrypt(tarZst, tempPath, passphraseFile);
      }
      await Deno.rename(tempPath, finalPath);
      // **最终产物也必须收紧权限**（评审发现）：`chmodPrivate` 只作用于
      // staging 目录，而这里 rename 出来的容器文件权限由进程 umask 决定——
      // 实测 umask 022 下是 **644**，即 `--no-encrypt` 时**含明文 pg dump**
      // 的备份全世界可读（bash 侧是 `chmod -R go-rwx`）。
      // 加密时风险较小，但"同一个命令的产物权限取决于调用者 umask"本身
      // 就不可接受：备份不该比 `.env.prod`（600）更宽松。
      await Deno.chmod(finalPath, 0o600);
      committed = true;
    } catch (err) {
      if (err instanceof ContainerError) throw err;
      throw new ContainerError("commit", (err as Error).message);
    }

    // ---- 12. sidecar 校验文件（容器整体摘要的**唯一**落点）----
    // 与容器同目录、同临时名策略：先写 `.tmp` 再 rename，保证 sidecar 与容器
    // 不会出现"容器已提交但 sidecar 缺失"之外的中间态（该情形下 verify 会
    // 明确报"缺少 sidecar"，而不是静默通过）。
    const sha256 = await fileSha256HexStreaming(finalPath);
    const sidecar = finalPath + CHECKSUM_SUFFIX;
    const sidecarTemp = `${sidecar}.${Deno.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await Deno.writeTextFile(
        sidecarTemp,
        `${sha256}  ${finalPath.split("/").pop()}\n`,
      );
      await Deno.rename(sidecarTemp, sidecar);
      await Deno.chmod(sidecar, 0o600);
    } catch (err) {
      await Deno.remove(sidecarTemp).catch(() => {});
      // 容器已提交（不可回退地占了名字），故如实报告"缺 sidecar"的后果
      throw new ContainerError(
        "commit",
        `容器已写入但无法写出校验文件 ${sidecar}：${(err as Error).message}`,
      );
    }

    return { path: finalPath, sha256, sidecar, manifest };
  } finally {
    // 失败零残留：staging 与临时产物一律清理。
    // 注意 staged 的 `tar.zst` 是 `${staging}.tar.zst`（staging **同级**），
    // 故必须单独删——只删 staging 目录会漏掉它。
    if (!committed && encrypted !== null) {
      await Deno.remove(encrypted).catch(() => {});
    }
    await Deno.remove(staging, { recursive: true }).catch(() => {});
    await Deno.remove(tarZst).catch(() => {});
  }
}

/** 递归去掉 group/other 权限（`chmod -R go-rwx` 的等价）。 */
async function chmodPrivate(dir: string): Promise<void> {
  const entries = await Array.fromAsync(Deno.readDir(dir));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory) {
      await chmodPrivate(full);
      await Deno.chmod(full, 0o700);
    } else {
      await Deno.chmod(full, 0o600);
    }
  }
}

// ---------------- 容器解包（verify / restore / drill 共用） ----------------

/** {@link unpackContainer} 的注入点。 */
export interface UnpackContainerOptions {
  /** 容器文件路径。 */
  path: string;
  /** 口令文件路径；容器 `encrypted: false` 时可为空。 */
  passphraseFile?: string;
  /** 解包目标目录（临时目录；**调用方负责清理**）。 */
  destDir: string;
  /** 解包操作集（注入；生产为 `createProdPayloadOps`）。 */
  ops: Pick<ContainerPayloadOps, "gpgDecrypt" | "untarZst">;
  /**
   * 容器是否加密。缺省按"有口令即加密"推断——但更稳妥的是由调用方
   * 先读 manifest 再决定；此处提供显式开关以便测试与 `--no-encrypt` 产物。
   */
  encrypted?: boolean;
}

/** {@link unpackContainer} 的结果。 */
export interface UnpackContainerResult {
  /** 解包出的 staging 目录（= `destDir`）。 */
  staging: string;
  /** 解析后的 manifest；缺失或非法时为 null（由调用方判定是否致命）。 */
  manifest: BackupManifest | null;
}

/**
 * 解包 `.nojbackup` 容器到 `destDir`。
 *
 * 编排：加密时 `gpg --decrypt` → `tar -I zstd -xf` → 读 manifest。
 *
 * **不校验**内容（那是 {@link verifyContainer} 的职责）：本函数只负责把包打开，
 * 让上层按档位自行判定。这样三档 verify 与 restore/drill 共用同一份解包实现。
 *
 * **不清理** `destDir`：调用方在 `finally` 里删（verify 需要在解包后继续读文件）。
 */
export async function unpackContainer(
  opts: UnpackContainerOptions,
): Promise<UnpackContainerResult> {
  const encrypted = opts.encrypted ?? true;
  const tarball = join(opts.destDir, "payload.tar.zst");
  if (encrypted) {
    if (opts.passphraseFile === undefined || opts.passphraseFile === "") {
      throw new ContainerError("encrypt", "容器已加密，需要口令文件才能解包");
    }
    await Deno.mkdir(opts.destDir, { recursive: true });
    await opts.ops.gpgDecrypt(opts.path, tarball, opts.passphraseFile);
  }

  // 解包到一个子目录：容器根的条目直接落在这里，便于与 destDir 自身的
  // `payload.tar.zst` 共存（未加密时它就是容器本身）。
  const staging = join(opts.destDir, "payload");
  if (encrypted) {
    await opts.ops.untarZst(tarball, staging);
  } else {
    await opts.ops.untarZst(opts.path, staging);
  }

  return { staging, manifest: await readManifest(staging) };
}

/** 读并解析 staging 内的 manifest；缺失或非法返回 null（不抛错）。 */
export async function readManifest(
  staging: string,
): Promise<BackupManifest | null> {
  let text: string;
  try {
    text = await Deno.readTextFile(join(staging, CONTAINER_FILES.manifest));
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as BackupManifest;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------- 容器校验（verify 的三档共用底座） ----------------

/** 单条校验失败。 */
export interface VerifyIssue {
  /** 失败所属档位。 */
  level: "files" | "deep" | "payload";
  /** 面向用户的说明。 */
  message: string;
}

/** {@link verifyContainer} 的结果。 */
export interface VerifyContainerResult {
  /** 解包出的 staging（调用方负责清理）。 */
  staging: string;
  manifest: BackupManifest | null;
  /** 逐档结论。 */
  checks: {
    /** 默认档：manifest + SUCCESS + sha256sums 逐文件。 */
    files: boolean;
    /** `--deep`：结构可解析 + env 可解密。 */
    deep: boolean;
    /** `--payload-sha`：容器文件摘要与同级 sidecar `.sha256` 一致。 */
    payload: boolean;
  };
  issues: VerifyIssue[];
  /** 是否已询问的档位全部通过。 */
  pass: boolean;
  /** `--deep` 是否因缺口令而跳过了需要口令的检查（如实报告，不静默通过）。 */
  skippedDecrypt: boolean;
}

/** {@link verifyContainer} 的注入点。 */
export interface VerifyContainerOptions extends UnpackContainerOptions {
  /** 是否跑 `--deep` 档。 */
  deep?: boolean;
  /** 是否跑 `--payload-sha` 档。 */
  payloadSha?: boolean;
}

/**
 * 校验 `.nojbackup` 容器（`backup.sh verify_snapshot` :302-334 的等价 + 两档增强）。
 *
 * 三档**累加**（高档包含低档的全部检查）：
 *
 * | 档位 | 内容 | 成本 |
 * | --- | --- | --- |
 * | 默认 | `payload_layout == "prod-raw"`、`SUCCESS` 哨兵、`sha256sums.txt` 逐文件 | 秒级 |
 * | `--deep` | 上一档 + `postgres.restore-list` 非空 + `redis.rdb` 首字节 `REDIS` + `minio/` 存在 + `env.prod.gpg` 可解密且非空 | 十秒级 |
 * | `--payload-sha` | 上一档 + 复算**容器文件**摘要并与同级 sidecar `.sha256` 比对 | 十秒级 |
 *
 * 设计要点：
 * - **不清理** staging（调用方 `finally` 删）——verify 之后 restore/drill 可能还要读；
 * - `sha256sums` 的路径做**穿越防护**（`../`、绝对路径一律拒绝），与 bash
 *   `verify_snapshot` 的 `[[ "$file" != /* && "$file" != *".."* ]]` 同义；
 * - `--deep` 在缺口令时**跳过**解密并置 {@link VerifyContainerResult.skippedDecrypt}，
 *   由调用方如实报告——静默通过会让"加密档"名不副实。
 */
export async function verifyContainer(
  opts: VerifyContainerOptions,
): Promise<VerifyContainerResult> {
  const issues: VerifyIssue[] = [];
  const unpacked = await unpackContainer(opts);
  const { staging } = unpacked;
  const manifest = unpacked.manifest;

  // ---- 默认档：manifest / payload_layout ----
  let filesOk = true;
  if (manifest === null) {
    filesOk = false;
    issues.push({ level: "files", message: "缺少或无法解析 manifest.json" });
  } else if (manifest.payload_layout !== PAYLOAD_LAYOUT) {
    // 唯一形态：不做分派，直接拒绝（历史/未知布局不在支持范围）
    filesOk = false;
    issues.push({
      level: "files",
      message:
        `payload_layout 不受支持：${manifest.payload_layout}（只支持 ${PAYLOAD_LAYOUT}）`,
    });
  }

  // ---- 默认档：SUCCESS 哨兵 ----
  let successOk = false;
  try {
    successOk =
      (await Deno.readTextFile(join(staging, CONTAINER_FILES.success)))
        .trim() ===
        SUCCESS_MARKER;
  } catch {
    successOk = false;
  }
  if (!successOk) {
    filesOk = false;
    issues.push({
      level: "files",
      message: `缺少有效的 ${CONTAINER_FILES.success} 哨兵`,
    });
  }

  // ---- 默认档：sha256sums 逐文件 ----
  let sumsOk = false;
  try {
    const text = await Deno.readTextFile(
      join(staging, CONTAINER_FILES.checksums),
    );
    const entries = parseChecksums(text);
    let ok = true;
    for (const entry of entries) {
      // 穿越防护：绝对路径或含 .. 的清单项一律拒绝。
      if (entry.relPath.startsWith("/") || entry.relPath.includes("..")) {
        ok = false;
        issues.push({
          level: "files",
          message: `校验清单包含非法路径：${entry.relPath}`,
        });
        continue;
      }
      let actual = "";
      try {
        actual = await fileSha256HexStreaming(join(staging, entry.relPath));
      } catch {
        ok = false;
        issues.push({
          level: "files",
          message: `校验清单引用了缺失文件：${entry.relPath}`,
        });
        continue;
      }
      if (actual !== entry.sha256) {
        ok = false;
        issues.push({
          level: "files",
          message: `SHA-256 校验失败：${entry.relPath}`,
        });
      }
    }
    sumsOk = ok && entries.length > 0;
    if (entries.length === 0) {
      issues.push({ level: "files", message: "校验清单为空" });
    }
  } catch (err) {
    issues.push({
      level: "files",
      message: `无法解析 ${CONTAINER_FILES.checksums}：${
        (err as Error).message
      }`,
    });
  }
  filesOk = filesOk && successOk && sumsOk;

  // ---- --deep 档：结构可解析 ----
  let deepOk = filesOk;
  let skippedDecrypt = false;
  if (opts.deep === true) {
    if (filesOk) {
      // restore-list 非空（create 时 pg_restore --list 的产物）
      let listOk = false;
      try {
        listOk = (await Deno.stat(
          join(staging, CONTAINER_FILES.postgresRestoreList),
        )).size > 0;
      } catch {
        listOk = false;
      }
      if (!listOk) {
        deepOk = false;
        issues.push({
          level: "deep",
          message:
            `${CONTAINER_FILES.postgresRestoreList} 为空或缺失（PostgreSQL 结构未验证）`,
        });
      }

      // redis.rdb 非空且首字节是 "REDIS"（RDB 魔术串）
      let rdbOk = false;
      let rdbDetail = "缺失或为空";
      try {
        const rdbPath = join(staging, CONTAINER_FILES.redisRdb);
        const size = (await Deno.stat(rdbPath)).size;
        if (size >= 5) {
          const file = await Deno.open(rdbPath, { read: true });
          try {
            const head = new Uint8Array(5);
            await file.read(head);
            rdbOk = new TextDecoder().decode(head) === "REDIS";
            if (!rdbOk) {
              rdbDetail = `首字节不是 REDIS 魔术串：${
                JSON.stringify(new TextDecoder().decode(head))
              }`;
            }
          } finally {
            file.close();
          }
        }
      } catch {
        rdbOk = false;
      }
      if (!rdbOk) {
        deepOk = false;
        issues.push({
          level: "deep",
          message: `redis.rdb 不可解析：${rdbDetail}`,
        });
      }

      // minio/ 目录存在
      let minioOk = false;
      try {
        minioOk = (await Deno.stat(join(staging, CONTAINER_FILES.minioDir)))
          .isDirectory;
      } catch {
        minioOk = false;
      }
      if (!minioOk) {
        deepOk = false;
        issues.push({
          level: "deep",
          message: `${CONTAINER_FILES.minioDir}/ 目录缺失`,
        });
      }
    } else {
      deepOk = false;
    }

    // env.prod.gpg 可解密（需要口令；缺口令则如实跳过）
    const hasPassphrase = (opts.passphraseFile ?? "") !== "";
    if (deepOk && hasPassphrase) {
      const out = join(opts.destDir, "env.prod.verify");
      try {
        await opts.ops.gpgDecrypt(
          join(staging, CONTAINER_FILES.envProdGpg),
          out,
          opts.passphraseFile!,
        );
        const size = (await Deno.stat(out)).size;
        if (size === 0) {
          deepOk = false;
          issues.push({
            level: "deep",
            message: "环境文件解密结果为空",
          });
        }
      } catch (err) {
        deepOk = false;
        issues.push({
          level: "deep",
          message: `环境文件解密失败：${(err as Error).message}`,
        });
      } finally {
        await Deno.remove(out).catch(() => {});
      }
    } else if (deepOk && !hasPassphrase) {
      skippedDecrypt = true;
    }
  }

  // ---- --payload-sha 档：容器整体摘要 vs 同级 sidecar ----
  //
  // 语义与**安全边界**（必须诚实）：sidecar 检测的是**意外损坏**——介质位翻转、
  // 拷贝被截断、下载不完整、误改。它**不**防蓄意篡改：能改 `.nojbackup` 的人
  // 同样能改同级 `.sha256`。要防蓄意篡改需要非对称签名（cosign 一类），
  // 而对称口令体系下"持有口令者可重写一切"，签名不在本任务的范围内。
  let payloadOk = deepOk;
  if (opts.payloadSha === true) {
    if (!filesOk) {
      payloadOk = false;
    } else {
      const sidecar = opts.path + CHECKSUM_SUFFIX;
      try {
        const text = await Deno.readTextFile(sidecar);
        const expected = text.trim().split(/\s+/)[0] ?? "";
        if (!/^[0-9a-f]{64}$/.test(expected)) {
          payloadOk = false;
          issues.push({
            level: "payload",
            message: `sidecar 校验文件格式非法：${sidecar}`,
          });
        } else {
          const actual = await fileSha256HexStreaming(opts.path);
          payloadOk = actual === expected;
          if (!payloadOk) {
            issues.push({
              level: "payload",
              message:
                `容器摘要与 sidecar 不一致（期望 ${expected}，实际 ${actual}）——文件可能已损坏`,
            });
          }
        }
      } catch {
        payloadOk = false;
        issues.push({
          level: "payload",
          message: `缺少 sidecar 校验文件：${sidecar}`,
        });
      }
    }
  }

  const pass = filesOk &&
    (opts.deep !== true || deepOk) &&
    (opts.payloadSha !== true || payloadOk);

  return {
    staging,
    manifest,
    checks: {
      files: filesOk,
      deep: opts.deep === true ? deepOk : filesOk,
      payload: opts.payloadSha === true ? payloadOk : deepOk,
    },
    issues,
    pass,
    skippedDecrypt,
  };
}
