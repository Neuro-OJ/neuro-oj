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
      // postgres：容器内 pg_dump 输出经 base64 转文本，避免二进制经 stdout 字符串损坏
      if (config.components["postgres"]?.enabled) {
        const pgUser = pgEnv["POSTGRES_USER"] ?? "noj";
        const pgDb = pgEnv["POSTGRES_DB"] ?? "noj";
        const pgPass = pgEnv["POSTGRES_PASSWORD"] ?? "";
        const dumpRes = await r.run("docker", [
          "exec",
          "-e",
          `PGPASSWORD=${pgPass}`,
          "-e",
          `POSTGRES_USER=${pgUser}`,
          "-e",
          `POSTGRES_DB=${pgDb}`,
          "noj-postgres",
          "sh",
          "-c",
          'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc | base64',
        ]);
        if (dumpRes.code !== 0) {
          throw new Error(`pg_dump 失败: ${dumpRes.stderr || dumpRes.stdout}`);
        }
        const globalsRes = await r.run("docker", [
          "exec",
          "-e",
          `PGPASSWORD=${pgPass}`,
          "-e",
          `POSTGRES_USER=${pgUser}`,
          "noj-postgres",
          "sh",
          "-c",
          'pg_dumpall --globals-only -U "$POSTGRES_USER"',
        ]);
        if (globalsRes.code !== 0) {
          throw new Error(
            `pg_dumpall 失败: ${globalsRes.stderr || globalsRes.stdout}`,
          );
        }
        entries.push({ relPath: "postgres.dump", content: dumpRes.stdout });
        entries.push({
          relPath: "postgres-globals.sql",
          content: globalsRes.stdout,
        });
      }
      // redis：SAVE 后把 rdb 经 base64 转文本；SAVE 的 OK 输出重定向到 /dev/null
      if (config.components["redis"]?.enabled) {
        const redisPass = redisEnv["REDIS_PASSWORD"] ?? "";
        const rdbRes = await r.run("docker", [
          "exec",
          "-e",
          `REDISCLI_AUTH=${redisPass}`,
          "noj-redis",
          "sh",
          "-c",
          "redis-cli SAVE >/dev/null && cat /data/dump.rdb | base64",
        ]);
        if (rdbRes.code !== 0) {
          throw new Error(`redis SAVE 失败: ${rdbRes.stderr || rdbRes.stdout}`);
        }
        const persistRes = await r.run("docker", [
          "exec",
          "-e",
          `REDISCLI_AUTH=${redisPass}`,
          "noj-redis",
          "sh",
          "-c",
          "redis-cli CONFIG GET save",
        ]);
        entries.push({ relPath: "redis.rdb", content: rdbRes.stdout });
        entries.push({
          relPath: "redis-persistence.txt",
          content: persistRes.stdout,
        });
      }
      // minio：用 minio/mc 容器把桶数据镜像到 staging/minio
      if (config.components["minio"]?.enabled) {
        const access = minioEnv["S3_ACCESS_KEY"] ?? "minioadmin";
        const secret = minioEnv["S3_SECRET_KEY"] ?? "minioadmin";
        const outDir = `${dumpDir}/minio`;
        await Deno.mkdir(outDir, { recursive: true });
        const res = await r.run("docker", [
          "run",
          "--rm",
          "--network",
          "container:noj-minio",
          "-v",
          `${outDir}:/out`,
          "-e",
          `MC_HOST_minio=http://${access}:${secret}@localhost:9000`,
          "minio/mc:latest@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727",
          "mirror",
          "--overwrite",
          "minio/",
          "/out",
        ]);
        if (res.code !== 0) {
          throw new Error(`MinIO 备份失败: ${res.stderr || res.stdout}`);
        }
      }
      return entries;
    },
    async restoreDataDumps(config, _secrets, dumpDir) {
      const pgEnv = resolveComponentEnv(config, _secrets, "postgres");
      const redisEnv = resolveComponentEnv(config, _secrets, "redis");
      if (config.components["postgres"]?.enabled) {
        const pgUser = pgEnv["POSTGRES_USER"] ?? "noj";
        const pgDb = pgEnv["POSTGRES_DB"] ?? "noj";
        const pgPass = pgEnv["POSTGRES_PASSWORD"] ?? "";
        const globals = await Deno.readTextFile(
          `${dumpDir}/postgres-globals.sql`,
        ).catch(() => "");
        if (globals.trim() !== "") {
          const gRes = await r.run(
            "docker",
            [
              "exec",
              "-i",
              "-e",
              `PGPASSWORD=${pgPass}`,
              "-e",
              `POSTGRES_USER=${pgUser}`,
              "noj-postgres",
              "sh",
              "-c",
              'psql -U "$POSTGRES_USER" -d postgres',
            ],
            { stdin: globals },
          );
          if (gRes.code !== 0) {
            throw new Error(
              `postgres globals 恢复失败: ${gRes.stderr || gRes.stdout}`,
            );
          }
        }
        const dumpB64 = await Deno.readTextFile(`${dumpDir}/postgres.dump`);
        const dRes = await r.run(
          "docker",
          [
            "exec",
            "-i",
            "-e",
            `PGPASSWORD=${pgPass}`,
            "-e",
            `POSTGRES_USER=${pgUser}`,
            "-e",
            `POSTGRES_DB=${pgDb}`,
            "noj-postgres",
            "sh",
            "-c",
            'base64 -d | pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists',
          ],
          { stdin: dumpB64 },
        );
        if (dRes.code !== 0) {
          throw new Error(
            `postgres 数据恢复失败: ${dRes.stderr || dRes.stdout}`,
          );
        }
      }
      if (config.components["redis"]?.enabled) {
        const redisPass = redisEnv["REDIS_PASSWORD"] ?? "";
        const rdbB64 = await Deno.readTextFile(`${dumpDir}/redis.rdb`).catch(
          () => "",
        );
        if (rdbB64.trim() !== "") {
          const rRes = await r.run(
            "docker",
            [
              "exec",
              "-i",
              "-e",
              `REDISCLI_AUTH=${redisPass}`,
              "noj-redis",
              "sh",
              "-c",
              "base64 -d > /data/dump.rdb",
            ],
            { stdin: rdbB64 },
          );
          if (rRes.code !== 0) {
            throw new Error(
              `redis RDB 恢复失败: ${rRes.stderr || rRes.stdout}`,
            );
          }
        }
        await r.run("docker", [
          "exec",
          "-e",
          `REDISCLI_AUTH=${redisPass}`,
          "noj-redis",
          "sh",
          "-c",
          "redis-cli FLUSHALL",
        ]);
      }
    },
    async clearData(config, _secrets) {
      const pgEnv = resolveComponentEnv(config, _secrets, "postgres");
      const redisEnv = resolveComponentEnv(config, _secrets, "redis");
      if (config.components["postgres"]?.enabled) {
        const pgUser = pgEnv["POSTGRES_USER"] ?? "noj";
        const pgDb = pgEnv["POSTGRES_DB"] ?? "noj";
        const pgPass = pgEnv["POSTGRES_PASSWORD"] ?? "";
        const res = await r.run("docker", [
          "exec",
          "-e",
          `PGPASSWORD=${pgPass}`,
          "-e",
          `POSTGRES_USER=${pgUser}`,
          "-e",
          `POSTGRES_DB=${pgDb}`,
          "noj-postgres",
          "bash",
          "-c",
          'psql -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE IF EXISTS \\"$POSTGRES_DB\\" WITH (FORCE)" && ' +
          'psql -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE \\"$POSTGRES_DB\\""',
        ]);
        if (res.code !== 0) {
          throw new Error(`postgres 清空失败: ${res.stderr || res.stdout}`);
        }
      }
      if (config.components["redis"]?.enabled) {
        const redisPass = redisEnv["REDIS_PASSWORD"] ?? "";
        await r.run("docker", [
          "exec",
          "-e",
          `REDISCLI_AUTH=${redisPass}`,
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
