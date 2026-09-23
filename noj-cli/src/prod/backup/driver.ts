/**
 * prod-raw payload driver（T17）：用**文件重定向**采集二进制。
 *
 * ## 本模块存在的唯一理由（最高风险项）
 *
 * `maintain/backup_driver.ts:114` 的既有注释写明了那条教训：
 *
 * > postgres：容器内 pg_dump 输出经 base64 转文本，避免二进制经 stdout 字符串损坏
 *
 * 即：此前实现用 `CommandRunner.run(...)` 把 `pg_dump -Fc` 的输出**当字符串**
 * 接住（`stdout: string`），再用 base64 补救。base64 能把损失"变得可检测"，
 * 但那是在为错误的采集方式擦屁股——真正的解法是让**内核**把子进程的 stdout
 * 直接写进文件，全程不经过任何字符串/编码转换。
 *
 * 因此 spec §3.1 明确：
 *
 * > `prod-raw` 必须走**文件重定向**（`docker compose exec -T … > file`，
 * > 与 `backup.sh:246` 相同），不得沿用 stdout 字符串捕获。否则引入静默损坏。
 *
 * 本模块把这条约束落成一个**类型**：{@link RawDriver.captureToFile} 与
 * {@link RawDriver.feedFromFile} 是采集/回灌二进制的**唯一**入口，二者的签名里
 * 根本没有"内容字符串"这个位置——想误用字符串路径就必须先改类型。
 *
 * ## 落点：`SpawnOpts.stdoutFile` / `stderrFile`
 *
 * `runtime/command.ts` 的 `realRunner().spawn()` 已支持 `stdoutFile`：
 * 它把 `child.stdout` 用 `pipeTo` 写进以 `append` 打开的文件句柄——这是
 * **字节流**搬运，不经 `TextDecoder`。本模块据此实现：
 *
 * ```ts
 * const handle = runner.spawn({ cmd, args, cwd, env, stdoutFile: dest });
 * const code = await handle.wait();
 * ```
 *
 * 回灌（恢复时的 `pg_restore ... < dump`）同理：用 shell 的 `< file` 重定向，
 * 而不是把文件读成字符串再塞 `stdin`（`run` 的 `stdin` 参数是 `string` 类型，
 * 二进制经它必然损坏）。因此 {@link RawDriver.feedFromFile} 经
 * `sh -c '... < "$1"'` 形式执行，路径作为**位置参数**传入，绝不拼接进脚本正文。
 *
 * ## 边界
 *
 * - 一切命令经注入的 {@link CommandRunner}；本模块不直接 `new Deno.Command`；
 * - **不读** payload 进内存：本模块只搬字节与判定退出码；
 * - 路径一律作为**独立 argv 元素**传递，不拼 shell 字符串（R1）。
 */

import type { CommandRunner, SpawnOpts } from "../../runtime/command.ts";

/** 采集/回灌的目标或来源文件路径。 */
export interface RawIO {
  /** 子进程 stdout 的落点文件（内核级重定向，**追加**语义由调用方保证为空文件）。 */
  destFile?: string;
  /** 子进程 stderr 的落点文件（诊断；缺省丢弃到进程 stderr）。 */
  stderrFile?: string;
  /** 工作目录。 */
  cwd?: string;
  /** 附加环境变量。 */
  env?: Record<string, string>;
}

/** prod-raw driver：容器内数据的采集与回灌。 */
export interface RawDriver {
  /**
   * 执行命令并把 **stdout 以字节流**写入 `destFile`。
   *
   * 这是采集二进制的唯一入口：内部经 `CommandRunner.spawn({ stdoutFile })`，
   * 子进程的 stdout 由内核直接落盘，**不经过** `TextDecoder` / 字符串。
   * 返回退出码；`destFile` 已存在时**追加**，故调用方须保证目标为空文件。
   */
  captureToFile(
    cmd: string,
    args: string[],
    io: RawIO & { destFile: string },
  ): Promise<number>;

  /**
   * 执行命令并把 `srcFile` 以字节流喂给它的 stdin。
   *
   * 经 `sh -c '<cmd> "$@" < "$src"'` 实现——路径作为位置参数传入（`$1`），
   * **不拼接**进脚本文本，因此含空格/引号的路径也安全。返回退出码。
   */
  feedFromFile(
    cmd: string,
    args: string[],
    io: { srcFile: string; cwd?: string; env?: Record<string, string> },
  ): Promise<number>;

  /**
   * `srcFile` 喂 stdin、**同时**把 stdout 以字节流写进 `destFile`。
   *
   * 两端都不经字符串。用于 `pg_restore --list`（stdin 是 dump、stdout 是清单）
   * 这类双向重定向的操作：输入侧由 `sh -c` 的 `< "$src"` 完成，输出侧复用
   * {@link captureToFile} 的 `stdoutFile`。两个路径都作为位置参数传入。
   */
  feedToFile(
    cmd: string,
    args: string[],
    io: {
      srcFile: string;
      destFile: string;
      cwd?: string;
      env?: Record<string, string>;
    },
  ): Promise<number>;
}

/** 采集失败（含命令名与退出码，便于定位是 pg_dump 还是 redis-cli）。 */
export class CaptureError extends Error {
  constructor(
    readonly cmd: string,
    readonly code: number,
    readonly detail: string,
  ) {
    super(
      `${cmd} 失败（退出码 ${code}）${detail === "" ? "" : "：" + detail}`,
    );
    this.name = "CaptureError";
  }
}

/**
 * 真实 prod-raw driver：把字节搬运交给注入的 {@link CommandRunner}。
 *
 * `runner.spawn` 是**必需**能力（P2 的某些 fake 未实现）——缺失时明确抛错，
 * 绝不退化为 `run()` 的字符串路径（那正是本模块要根除的缺陷）。
 */
export function realRawDriver(runner: CommandRunner): RawDriver {
  return {
    async captureToFile(cmd, args, io) {
      if (typeof runner.spawn !== "function") {
        throw new Error(
          "当前 CommandRunner 不支持 spawn，无法以文件重定向采集二进制" +
            "（绝不可退化为 stdout 字符串捕获）",
        );
      }
      const opts: SpawnOpts = {
        cmd,
        args,
        cwd: io.cwd ?? Deno.cwd(),
        env: io.env ?? {},
        stdoutFile: io.destFile,
      };
      if (io.stderrFile !== undefined) opts.stderrFile = io.stderrFile;
      const handle = runner.spawn(opts);
      return await handle.wait();
    },

    async feedFromFile(cmd, args, io) {
      // POSIX `sh -c <script> <$0> <$1> <$2>…` 的位置参数布局：
      // 把**来源路径放 $1**，脚本内先存进变量再 `shift`，于是 `"$@"` 恰好是
      // 调用方给的 args——路径既不进脚本正文，也不混进目标命令的参数里。
      // `exec` 让目标命令替换 shell，退出码即目标命令的退出码（不含 shell 包装）。
      const script = `src="$1"; shift; exec ${
        quoteForShell(cmd)
      } "$@" < "$src"`;
      const res = await runner.run(
        "sh",
        ["-c", script, "noj-feed", io.srcFile, ...args],
        { cwd: io.cwd, env: io.env },
      );
      return res.code;
    },

    async feedToFile(cmd, args, io) {
      // 输入侧用 `sh -c ... < "$src"`，输出侧仍走 spawn 的 stdoutFile——
      // 因此这里 spawn 的是 `sh`（而非目标命令），shell 内 `exec` 替换自身，
      // 子进程的 stdout 于是就是目标命令的 stdout，由内核写入 destFile。
      if (typeof runner.spawn !== "function") {
        throw new Error(
          "当前 CommandRunner 不支持 spawn，无法以文件重定向采集二进制" +
            "（绝不可退化为 stdout 字符串捕获）",
        );
      }
      const script = `src="$1"; shift; exec ${
        quoteForShell(cmd)
      } "$@" < "$src"`;
      const handle = runner.spawn({
        cmd: "sh",
        args: ["-c", script, "noj-feed", io.srcFile, ...args],
        cwd: io.cwd ?? Deno.cwd(),
        env: io.env ?? {},
        stdoutFile: io.destFile,
      });
      return await handle.wait();
    },
  };
}

/**
 * 把单个词安全地放进 shell 脚本正文（仅用于**命令名**，路径一律走位置参数）。
 *
 * 命令名来自代码常量（`docker`/`gpg`/`tar`），但配置可覆盖（`NOJ_DEPLOY_DOCKER_BIN`），
 * 故仍做最小防护：仅允许安全字符集，否则拒绝——避免把一个用户可控的字符串
 * 拼进 shell 正文。
 */
function quoteForShell(word: string): string {
  if (!/^[A-Za-z0-9_./-]+$/.test(word)) {
    throw new Error(`命令名含不安全字符，拒绝拼接：${word}`);
  }
  return word;
}

// ---------------- prod-raw 的具体采集/回灌操作 ----------------
//
// 全部建立在 {@link RawDriver} 的两个原语之上。**没有任何一个**函数把 payload
// 内容放进字符串：采集只写文件，回灌只从文件喂 stdin。

/** prod compose 执行所需的定位信息。 */
export interface ProdComposeContext {
  /** `-f` 指向的 compose 文件绝对路径。 */
  composeFile: string;
  /** `--env-file` 指向的环境文件绝对路径。 */
  envFile: string;
  /** docker 可执行名（`NOJ_DEPLOY_DOCKER_BIN`）。 */
  dockerBin: string;
  /** 附加 `--profile judge`（judge 启用时）。 */
  judge?: boolean;
  /** 附加 `--profile monitoring`。 */
  monitoring?: boolean;
  /** 附加 `--project-name`。 */
  projectName?: string;
  /** 是否禁用 ANSI（采集时恒 true：避免把转义码写进 payload）。 */
  noAnsi?: boolean;
}

/** 构造 `docker compose ...` 的**纯参数数组**（绝不拼 shell 字符串）。 */
export function prodComposeArgs(
  ctx: ProdComposeContext,
  command: string[],
): string[] {
  const args = [
    "compose",
    "--env-file",
    ctx.envFile,
    "--file",
    ctx.composeFile,
  ];
  if (ctx.projectName !== undefined && ctx.projectName !== "") {
    args.push("--project-name", ctx.projectName);
  }
  if (ctx.judge === true) args.push("--profile", "judge");
  if (ctx.monitoring === true) args.push("--profile", "monitoring");
  // **`--ansi` 是 `docker compose` 的旗标，不是 `docker` 的**（评审发现）：
  // `unshift` 会把它放到数组最前（`compose` 之前）→
  // `docker --ansi never compose …` → 实测 `unknown flag: --ansi`。
  // 必须插在 `compose` **之后**；`lifecycle/steps.ts` 的日志路径一直是对的，
  // 只有这里写错（且 driver_test 断言了这个错误形状，把 bug 固化了下来）。
  if (ctx.noAnsi === true) args.splice(1, 0, "--ansi", "never");
  args.push(...command);
  return args;
}

/** {@link createProdPayloadOps} 的参数。 */
export interface ProdPayloadOptions {
  runner: CommandRunner;
  driver: RawDriver;
  compose: ProdComposeContext;
  /** `.env.prod` 的键值（取 `POSTGRES_USER`/`POSTGRES_DB`/`S3_BUCKET` 等）。 */
  env: Record<string, string | undefined>;
  /** gpg 可执行名。 */
  gpgBin?: string;
  /** tar 可执行名。 */
  tarBin?: string;
}

/** prod-raw payload 的采集/回灌操作集。 */
export interface ProdPayloadOps {
  /** `pg_dump -Fc` → `destFile`（**原始二进制**，经内核重定向）。 */
  postgresDump(destFile: string): Promise<void>;
  /** `pg_dumpall --globals-only --no-role-passwords` → `destFile`（文本）。 */
  postgresGlobals(destFile: string): Promise<void>;
  /** `pg_restore --list < destFile` 的结构校验（失败即抛，**输入来自文件**）。 */
  postgresRestoreList(dumpFile: string, destFile: string): Promise<void>;
  /** `redis-cli --rdb -` → `destFile`（**原始二进制**，经内核重定向）。 */
  redisRdb(destFile: string): Promise<void>;
  /** `redis-cli INFO persistence` → `destFile`（文本）。 */
  redisPersistence(destFile: string): Promise<void>;
  /** `mc mirror` 把桶镜像进 `destDir`（目录，非单文件）。 */
  minioMirror(destDir: string): Promise<void>;
  /** `pg_restore --clean --if-exists --no-owner --exit-on-error` 从 `srcFile` 回灌。 */
  restorePostgres(srcFile: string): Promise<void>;
  /** 把 `srcFile` 写进 redis 容器的 `/data/dump.rdb`（从文件喂 stdin）。 */
  restoreRedisRdb(srcFile: string): Promise<void>;
  /** gpg 对称加密 `src` → `dest`。 */
  gpgEncrypt(src: string, dest: string, passphraseFile: string): Promise<void>;
  /** gpg 解密 `src` → `dest`。 */
  gpgDecrypt(src: string, dest: string, passphraseFile: string): Promise<void>;
  /** `tar -I 'zstd -<level>' -cf dest -C staging .` 打包。 */
  tarZst(stagingDir: string, dest: string, zstdLevel: number): Promise<void>;
  /** `tar -I zstd -xf src -C destDir` 解包。 */
  untarZst(src: string, destDir: string): Promise<void>;
}

/** MinIO 客户端镜像（固定 digest，与 `maintain/backup_driver.ts` 同源）。 */
export const MINIO_CLIENT_IMAGE =
  "minio/mc:latest@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727";

/** pg 采集的空口令告警：缺口令时 pg_dump 会失败，故提前给出可操作报错。 */
export function postgresEnvOf(
  env: Record<string, string | undefined>,
): { user: string; db: string } {
  return {
    user: env["POSTGRES_USER"] || "noj",
    db: env["POSTGRES_DB"] || "noj",
  };
}

/**
 * 构造 prod-raw 操作集。
 *
 * 采集路径要点（对照 `backup.sh:246-258`）：
 * - `postgres.dump`：`compose exec -T postgres pg_dump -U <user> -d <db> -Fc`
 *   的 stdout **重定向到文件**；
 * - `redis.rdb`：`compose exec -T redis sh -c 'REDISCLI_AUTH=… redis-cli
 *   --no-auth-warning --rdb -'` 的 stdout **重定向到文件**；
 * - `pg_restore --list` 的**输入**是文件（`< dump`），输出是文本文件。
 *
 * 三处都不经字符串——这是本模块的核心约束，见模块头。
 */
export function createProdPayloadOps(opts: ProdPayloadOptions): ProdPayloadOps {
  const { runner, driver, compose, env } = opts;
  const gpgBin = opts.gpgBin ?? "gpg";
  const tarBin = opts.tarBin ?? "tar";
  const pg = postgresEnvOf(env);

  /** 执行一条 compose 子命令并把 stdout 落到文件。 */
  const captureCompose = async (
    command: string[],
    destFile: string,
    what: string,
  ): Promise<void> => {
    const args = prodComposeArgs(compose, command);
    const code = await driver.captureToFile(compose.dockerBin, args, {
      destFile,
    });
    if (code !== 0) {
      throw new CaptureError(what, code, await readHead(destFile));
    }
  };

  return {
    async postgresDump(destFile) {
      await captureCompose(
        [
          "exec",
          "-T",
          "postgres",
          "pg_dump",
          "-U",
          pg.user,
          "-d",
          pg.db,
          "-Fc",
        ],
        destFile,
        "pg_dump",
      );
      const size = await fileSize(destFile);
      if (size === 0) throw new CaptureError("pg_dump", 0, "输出为空");
    },

    async postgresGlobals(destFile) {
      await captureCompose(
        [
          "exec",
          "-T",
          "postgres",
          "pg_dumpall",
          "-U",
          pg.user,
          "--globals-only",
          "--no-role-passwords",
        ],
        destFile,
        "pg_dumpall",
      );
    },

    async postgresRestoreList(dumpFile, destFile) {
      // 双向重定向：stdin 是 dump（二进制），stdout 是清单（文本）。
      // 输入侧 `< "$src"`、输出侧 `stdoutFile`，两端都不经字符串。
      const args = prodComposeArgs(compose, [
        "exec",
        "-T",
        "postgres",
        "pg_restore",
        "--list",
      ]);
      const code = await driver.feedToFile(compose.dockerBin, args, {
        srcFile: dumpFile,
        destFile,
      });
      if (code !== 0) throw new CaptureError("pg_restore --list", code, "");
    },

    async redisRdb(destFile) {
      await captureCompose(
        [
          "exec",
          "-T",
          "redis",
          "sh",
          "-c",
          'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --no-auth-warning --rdb -',
        ],
        destFile,
        "redis-cli --rdb",
      );
      const size = await fileSize(destFile);
      if (size === 0) throw new CaptureError("redis-cli --rdb", 0, "输出为空");
    },

    async redisPersistence(destFile) {
      await captureCompose(
        [
          "exec",
          "-T",
          "redis",
          "sh",
          "-c",
          'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --no-auth-warning INFO persistence',
        ],
        destFile,
        "redis-cli INFO persistence",
      );
    },

    async minioMirror(destDir) {
      await Deno.mkdir(destDir, { recursive: true });
      const bucket = env["S3_BUCKET"] || "noj-support-packages";
      const res = await runner.run("docker", [
        "compose",
        "--env-file",
        compose.envFile,
        "--file",
        compose.composeFile,
        "run",
        "--rm",
        "--no-deps",
        "--entrypoint",
        "/bin/sh",
        "-v",
        `${destDir}:/backup:rw`,
        "minio-init",
        "-c",
        `set -eu; for i in $(seq 1 30); do mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1 && break; sleep 2; done; mc mirror --preserve "local/${bucket}" /backup`,
      ]);
      if (res.code !== 0) {
        throw new CaptureError("mc mirror", res.code, res.stderr.trim());
      }
    },

    async restorePostgres(srcFile) {
      const args = prodComposeArgs(compose, [
        "exec",
        "-T",
        "postgres",
        "pg_restore",
        "--clean",
        "--if-exists",
        "--no-owner",
        "--exit-on-error",
        "-U",
        pg.user,
        "-d",
        pg.db,
      ]);
      const code = await driver.feedFromFile(compose.dockerBin, args, {
        srcFile,
      });
      if (code !== 0) throw new CaptureError("pg_restore", code, "");
    },

    async restoreRedisRdb(srcFile) {
      const code = await driver.feedFromFile(
        compose.dockerBin,
        prodComposeArgs(compose, [
          "run",
          "--rm",
          "--no-deps",
          "--entrypoint",
          "/bin/sh",
          "redis",
          "-c",
          "set -eu; rm -rf /data/appendonlydir /data/dump.rdb; cat > /data/dump.rdb",
        ]),
        { srcFile },
      );
      if (code !== 0) throw new CaptureError("redis RDB 回灌", code, "");
    },

    async gpgEncrypt(src, dest, passphraseFile) {
      const res = await runner.run(gpgBin, [
        "--batch",
        "--yes",
        "--pinentry-mode",
        "loopback",
        "--passphrase-file",
        passphraseFile,
        "--symmetric",
        "--cipher-algo",
        "AES256",
        "--output",
        dest,
        src,
      ]);
      if (res.code !== 0) {
        throw new CaptureError("gpg 加密", res.code, res.stderr.trim());
      }
    },

    async gpgDecrypt(src, dest, passphraseFile) {
      const res = await runner.run(gpgBin, [
        "--batch",
        "--yes",
        "--pinentry-mode",
        "loopback",
        "--passphrase-file",
        passphraseFile,
        "--decrypt",
        "--output",
        dest,
        src,
      ]);
      if (res.code !== 0) {
        throw new CaptureError("gpg 解密", res.code, res.stderr.trim());
      }
    },

    async tarZst(stagingDir, dest, zstdLevel) {
      const res = await runner.run(tarBin, [
        "-I",
        `zstd -${zstdLevel}`,
        "-cf",
        dest,
        "-C",
        stagingDir,
        ".",
      ]);
      if (res.code !== 0) {
        throw new CaptureError("tar 打包", res.code, res.stderr.trim());
      }
    },

    async untarZst(src, destDir) {
      await Deno.mkdir(destDir, { recursive: true });
      const res = await runner.run(tarBin, [
        "-I",
        "zstd",
        "-xf",
        src,
        "-C",
        destDir,
      ]);
      if (res.code !== 0) {
        throw new CaptureError("tar 解包", res.code, res.stderr.trim());
      }
    },
  };
}

/** 文件字节数（不存在返回 0）。 */
async function fileSize(path: string): Promise<number> {
  try {
    return (await Deno.stat(path)).size;
  } catch {
    return 0;
  }
}

/** 读文件开头若干字节作为错误附注（诊断用；不用于 payload）。 */
async function readHead(path: string, limit = 512): Promise<string> {
  try {
    const file = await Deno.open(path, { read: true });
    try {
      const buf = new Uint8Array(limit);
      const n = await file.read(buf);
      return n === null
        ? ""
        : new TextDecoder().decode(buf.subarray(0, n)).trim();
    } finally {
      file.close();
    }
  } catch {
    return "";
  }
}
