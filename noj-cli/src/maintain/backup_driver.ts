import type { DeployConfig, SecretsConfig } from "../config/types.ts";
import { resolveComponentEnv } from "../config/merge.ts";
import type { CommandRunner } from "../runtime/command.ts";
import { realRunner } from "../runtime/command.ts";

/** staging 内单个文本转储文件。 */
export interface DumpEntry {
  relPath: string;
  content: string;
}

/**
 * 备份/恢复/重置所需的外部工具抽象。
 * 测试注入 fakeDriver()；生产用 realDriver()（内部经 CommandRunner 调用 tar/zstd/gpg/docker）。
 */
export interface BackupDriver {
  /** tar -I "zstd -<level>" -cf 打包 staging 目录为单个 .tar.zst。 */
  archive(stagingDir: string, dest: string, zstdLevel: number): Promise<void>;
  /** tar -I zstd -xf 解包到目标目录。 */
  extract(archive: string, destDir: string): Promise<void>;
  /** gpg --batch --yes --symmetric AES256 加密。 */
  gpgEncrypt(src: string, dest: string, passphraseFile: string): Promise<void>;
  /** gpg --batch --yes --decrypt AES256 解密。 */
  gpgDecrypt(src: string, dest: string, passphraseFile: string): Promise<void>;
  /** 用 docker 服务把数据转储到 dumpDir，返回新增文件相对路径（不含目录创建）。 */
  produceDataDumps(
    config: DeployConfig,
    secrets: SecretsConfig,
    dumpDir: string,
  ): Promise<DumpEntry[]>;
  /** 把 dumpDir 内的转储恢复到 docker 服务。 */
  restoreDataDumps(
    config: DeployConfig,
    secrets: SecretsConfig,
    dumpDir: string,
  ): Promise<void>;
  /** 清空 DB/Redis/MinIO/缓存（供 reset 使用）。 */
  clearData(config: DeployConfig, secrets: SecretsConfig): Promise<void>;
}

/** SHA-256 十六进制摘要（Deno 原生，不 spawn 外部命令）。 */
export async function sha256Hex(input: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", input as BufferSource);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** 计算文件 SHA-256 十六进制摘要。 */
export async function fileSha256Hex(path: string): Promise<string> {
  const data = await Deno.readFile(path);
  return sha256Hex(data);
}

/** 真实 driver：经 CommandRunner 调用 tar/zstd/gpg/docker。 */
export function realDriver(runner?: CommandRunner): BackupDriver {
  const r = runner ?? realRunner();
  return {
    async archive(stagingDir, dest, zstdLevel) {
      const res = await r.run("tar", [
        "-I",
        `zstd -${zstdLevel}`,
        "-cf",
        dest,
        "-C",
        stagingDir,
        ".",
      ]);
      if (res.code !== 0) {
        throw new Error(`tar 打包失败: ${res.stderr || res.stdout}`);
      }
    },
    async extract(archive, destDir) {
      await Deno.mkdir(destDir, { recursive: true });
      const res = await r.run("tar", [
        "-I",
        "zstd",
        "-xf",
        archive,
        "-C",
        destDir,
      ]);
      if (res.code !== 0) {
        throw new Error(`tar 解包失败: ${res.stderr || res.stdout}`);
      }
    },
    async gpgEncrypt(src, dest, passphraseFile) {
      const res = await r.run("gpg", [
        "--batch",
        "--yes",
        "--symmetric",
        "--cipher-algo",
        "AES256",
        "--passphrase-file",
        passphraseFile,
        "--output",
        dest,
        src,
      ]);
      if (res.code !== 0) {
        throw new Error(`gpg 加密失败: ${res.stderr || res.stdout}`);
      }
    },
    async gpgDecrypt(src, dest, passphraseFile) {
      const res = await r.run("gpg", [
        "--batch",
        "--yes",
        "--decrypt",
        "--cipher-algo",
        "AES256",
        "--passphrase-file",
        passphraseFile,
        "--output",
        dest,
        src,
      ]);
      if (res.code !== 0) {
        throw new Error(`gpg 解密失败: ${res.stderr || res.stdout}`);
      }
    },
    async produceDataDumps(config, _secrets, dumpDir) {
      const pgEnv = resolveComponentEnv(config, _secrets, "postgres");
      const redisEnv = resolveComponentEnv(config, _secrets, "redis");
      const minioEnv = resolveComponentEnv(config, _secrets, "minio");
      const entries: DumpEntry[] = [];
      // postgres：容器内 pg_dump 输出到 stdout，重定向到本机文件
      if (config.components["postgres"]?.enabled) {
        const dumpRes = await r.run("docker", [
          "exec",
          "noj-postgres",
          "bash",
          "-c",
          `PGPASSWORD='${pgEnv["POSTGRES_PASSWORD"] ?? ""}' pg_dump -U '${
            pgEnv["POSTGRES_USER"] ?? "noj"
          }' -d '${pgEnv["POSTGRES_DB"] ?? "noj"}' -Fc`,
        ]);
        const globalsRes = await r.run("docker", [
          "exec",
          "noj-postgres",
          "bash",
          "-c",
          `PGPASSWORD='${
            pgEnv["POSTGRES_PASSWORD"] ?? ""
          }' pg_dumpall --globals-only -U '${pgEnv["POSTGRES_USER"] ?? "noj"}'`,
        ]);
        const listRes = await r.run("docker", [
          "exec",
          "noj-postgres",
          "bash",
          "-c",
          `PGPASSWORD='${pgEnv["POSTGRES_PASSWORD"] ?? ""}' pg_restore -l -d '${
            pgEnv["POSTGRES_DB"] ?? "noj"
          }'`,
        ]);
        entries.push({ relPath: "postgres.dump", content: dumpRes.stdout });
        entries.push({
          relPath: "postgres-globals.sql",
          content: globalsRes.stdout,
        });
        entries.push({
          relPath: "postgres.restore-list",
          content: listRes.stdout,
        });
      }
      // redis：SAVE 后拷 rdb；SAVEPERSISTENCE 输出
      if (config.components["redis"]?.enabled) {
        const rdbRes = await r.run("docker", [
          "exec",
          "noj-redis",
          "sh",
          "-c",
          `redis-cli -a '${
            redisEnv["REDIS_PASSWORD"] ?? ""
          }' SAVE && cat /data/dump.rdb`,
        ]);
        const persistRes = await r.run("docker", [
          "exec",
          "noj-redis",
          "sh",
          "-c",
          `redis-cli -a '${redisEnv["REDIS_PASSWORD"] ?? ""}' CONFIG GET save`,
        ]);
        entries.push({ relPath: "redis.rdb", content: rdbRes.stdout });
        entries.push({
          relPath: "redis-persistence.txt",
          content: persistRes.stdout,
        });
      }
      // minio：遍历桶列表，逐个 mc mirror --remote-host 到本地（占位实现：记录桶列表）
      if (config.components["minio"]?.enabled) {
        const { MC_MIRROR_OUTPUT } = minioEnv;
        await Deno.mkdir(`${dumpDir}/minio`, { recursive: true });
        await Deno.writeTextFile(
          `${dumpDir}/minio/BUCKETS`,
          MC_MIRROR_OUTPUT ?? "[]",
        );
        entries.push({
          relPath: "minio/BUCKETS",
          content: MC_MIRROR_OUTPUT ?? "[]",
        });
      }
      return entries;
    },
    async restoreDataDumps(config, _secrets, dumpDir) {
      if (config.components["postgres"]?.enabled) {
        const dump = await Deno.readTextFile(`${dumpDir}/postgres.dump`);
        const res = await r.run("docker", [
          "exec",
          "-i",
          "noj-postgres",
          "bash",
          "-c",
          `pg_restore -U ${"${POSTGRES_USER}"} -d ${"${POSTGRES_DB}"} --clean --if-exists`,
        ]);
        // dump 经 stdin 传入（此处用 CommandRunner 无法直通 stdin，记录为失败需人工干预）
        void dump;
        void res;
        throw new Error(
          "restoreDataDumps: postgres 恢复需真实 stdin 通道，见 docker exec -i 说明",
        );
      }
      await r.run("docker", [
        "exec",
        "noj-redis",
        "sh",
        "-c",
        "redis-cli FLUSHALL",
      ]);
    },
    async clearData(config, _secrets) {
      if (config.components["postgres"]?.enabled) {
        await r.run("docker", [
          "exec",
          "noj-postgres",
          "bash",
          "-c",
          "psql -U ${POSTGRES_USER} -d postgres -c 'DROP DATABASE IF EXISTS \"${POSTGRES_DB}\" WITH (FORCE)' && " +
          "psql -U ${POSTGRES_USER} -d postgres -c 'CREATE DATABASE \"${POSTGRES_DB}\"'",
        ]);
      }
      if (config.components["redis"]?.enabled) {
        await r.run("docker", [
          "exec",
          "noj-redis",
          "sh",
          "-c",
          "redis-cli FLUSHALL",
        ]);
      }
      if (config.components["minio"]?.enabled) {
        await r.run("docker", [
          "exec",
          "noj-minio",
          "sh",
          "-c",
          "rm -rf /data/*",
        ]);
      }
    },
  };
}
