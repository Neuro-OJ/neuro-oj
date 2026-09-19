/**
 * `.nojbackup` 单文件容器格式（T17）。
 *
 * ## 形态（spec `2026-09-19-noj-cli-production-unification-design.md` §3.1）
 *
 * ```text
 * snapshot-<ts>.nojbackup
 * └─ gpg(AES256, <passphrase>)         ← **整包**加密（不是只加密 env）
 *    └─ tar.zst
 *       ├─ manifest.json               schema_version / payload_layout / created_at / sha256
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
  /**
   * **tar.zst**（未加密的 payload 归档）的 SHA-256。
   *
   * 刻意不是最终 `.nojbackup` 的摘要：整包加密后每次运行的密文都不同
   * （GPG 的随机 IV / salt），故密文摘要无法用于"同一快照"的比较或复现；
   * 而 tar.zst 的摘要只要有相同的输入文件与压缩级别就稳定。
   * 最终产物的摘要由调用方（`backup create`）另行计算并回报。
   */
  sha256: string;
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
 * 可在 `maintain/backup_index.ts:parseBackupName` 的既有解析下工作，从而让
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
  /** 最终产物的 SHA-256（密文；每次运行都不同）。 */
  sha256: string;
  /** tar.zst 的 SHA-256（manifest 内记录的那个）。 */
  payloadSha256: string;
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

    // ---- 8. checksums 与 manifest（先算除 manifest 外的全部文件）----
    const beforeManifest = (await listFiles(staging)).filter((rel) =>
      rel !== CONTAINER_FILES.manifest
    );
    const checksumEntries: ChecksumEntry[] = [];
    for (const rel of beforeManifest) {
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

    // ---- 9. 两轮打包：manifest 需要 tar.zst 的摘要，而 manifest 自身要进包 ----
    await opts.ops.tarZst(staging, tarZst, zstdLevel);
    const payloadSha256 = await fileSha256HexStreaming(tarZst);

    const manifest: BackupManifest = {
      schema_version: SCHEMA_VERSION,
      payload_layout: PAYLOAD_LAYOUT,
      created_at: utcTimestamp(now),
      encrypted: !noEncrypt,
      zstd_level: zstdLevel,
      sha256: payloadSha256,
      files: [...(await listFiles(staging)), CONTAINER_FILES.manifest].sort(),
      postgres_database: opts.postgresDatabase,
      retention_days: opts.retentionDays ?? DEFAULT_RETENTION_DAYS,
      ...MANIFEST_DEFAULTS,
    };
    await Deno.writeTextFile(
      join(staging, CONTAINER_FILES.manifest),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    // 第二轮：manifest 进包（摘要字段留的是**未含 manifest** 时的 tar 摘要，
    // 因为那正是校验方解包后能复算的对象——见 manifest.sha256 的 JSDoc）。
    await Deno.remove(tarZst).catch(() => {});
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
      committed = true;
    } catch (err) {
      if (err instanceof ContainerError) throw err;
      throw new ContainerError("commit", (err as Error).message);
    }

    const sha256 = await fileSha256HexStreaming(finalPath);
    return { path: finalPath, sha256, payloadSha256, manifest };
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
