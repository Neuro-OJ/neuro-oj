/** `.nojbackup` 容器的创建（从 container.ts 拆出）。
 */

import { join } from "@std/path";
import { fileSha256HexStreaming } from "./sha256.ts";
import {
  type BackupManifest,
  CHECKSUM_SUFFIX,
  type ChecksumEntry,
  CONTAINER_FILES,
  ContainerError,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_ZSTD_LEVEL,
  MANIFEST_DEFAULTS,
  PAYLOAD_LAYOUT,
  SCHEMA_VERSION,
  SUCCESS_MARKER,
} from "./container.ts";
import {
  allocateContainerPath,
  listFiles,
  tempContainerPath,
  utcTimestamp,
} from "./container-paths.ts";
import { renderChecksums } from "./container-checksums.ts";

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
