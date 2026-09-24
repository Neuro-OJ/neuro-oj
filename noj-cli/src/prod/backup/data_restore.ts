/**
 * 数据服务恢复序列（**生产 restore 与隔离 drill 共用**）。
 *
 * ## 为什么抽出来（而不是两处各写一份）
 *
 * 这段序列的顺序与错误处理是**评审迭代出来的**，不是随手写的：
 *
 * 1. **必须先 `--wait` 起数据服务**，否则后续 `psql`/`pg_restore` 会以
 *    "connection refused" 之类的下游错误掩盖"服务没起来"这一根因；
 * 2. **`minio-init` 必须显式检查退出码**——曾因丢弃返回值，让 MinIO 初始化失败
 *    表现为"数据核对失败：迁移版本与快照不一致"，把根因完全埋掉；
 * 3. **PostgreSQL 全局对象要先幂等化再重放**，否则目标库已由 `POSTGRES_USER`
 *    建有默认角色而 "role already exists" 失败；
 * 4. **`pg_restore` 与 `psql` 的输入都来自文件**（内核重定向），不经字符串；
 * 5. **Redis 是"停 → 写 RDB → 起"**，中途不能省 `stop`，否则 RDB 会被覆盖；
 * 6. **MinIO 用 `mc mirror --overwrite --remove`**，`--remove` 让目标桶与快照
 *    **一致**（否则快照里已删的对象会残留在目标）。
 *
 * 这些性质分成两份实现就必然漂移——而漂移的后果是"演练通过但真实恢复没做对"，
 * 属于最坏的一类不一致（drill 的全部意义就是证明 restore 可行）。
 *
 * ## 与调用方的边界
 *
 * 本模块**不知道** compose 项目名、override 文件、是否用隔离网络——那些由
 * {@link DataRestoreContext.composeArgs} 决定。于是：
 * - drill 传入它的隔离项目参数；
 * - 生产 `restore --confirm` 传入真实生产 compose 参数。
 *
 * 本模块不持有模块级可变状态（AGENTS.md §8.2 多副本约束）。
 */

import type { CommandRunner } from "../../runtime/command.ts";
import { valueOr } from "../env-values.ts";
import { makeIdempotentGlobals } from "./globals.ts";

/** 恢复序列所需的全部注入点与上下文。 */
export interface DataRestoreContext {
  /** 解包后的快照目录（`postgres.dump` / `redis.rdb` / `minio/` 所在处）。 */
  staging: string;
  /** 临时目录（幂等化后的 globals 脚本落在这里）。 */
  tempDir: string;
  /** `.env.prod` 解析出的键值（取 `POSTGRES_USER`/`POSTGRES_DB`/`S3_BUCKET`）。 */
  env: Record<string, string>;
  /** 命令注入点。 */
  runner: CommandRunner;
  /** docker 可执行名。 */
  dockerBin: string;
  /**
   * 构造一条 `docker compose …` 的**纯参数数组**（不含 `docker` 本身）。
   *
   * 由调用方决定项目名/override/是否隔离——本模块只负责"恢复什么、按什么顺序"。
   */
  composeArgs: (command: string[]) => string[];
  /** `--wait` 超时（秒）。 */
  waitTimeout: number;
  /** 人类日志汇聚点。 */
  log: (line: string) => void;
  /**
   * 是否在恢复结束后**停掉数据服务**。
   *
   * - 生产 restore：`true`（与 bash 一致——恢复后停服务，等人工检查再起业务，
   *   避免应用在半恢复的数据上对外服务）；
   * - drill：`false`（它后续还要起业务服务做验收）。
   */
  stopAfterRestore: boolean;
}

/** 跑一条 compose 子命令并返回退出码。 */
async function compose(
  ctx: DataRestoreContext,
  command: string[],
): Promise<number> {
  const res = await ctx.runner.run(ctx.dockerBin, ctx.composeArgs(command));
  return res.code;
}

/**
 * 把文件喂给一条 compose 子命令的 stdin（**文件重定向，不经字符串**）。
 *
 * 用 `sh -c 'bin="$1"; src="$2"; shift 2; exec "$bin" "$@" < "$src"'`：
 * 可执行名走 `$1`、快照路径走 `$2`、compose 参数走 `"$@"`，
 * **都不拼进脚本正文**。这是 T17 `driver.ts:feedFromFile` 的同一语义，
 * 但那里只接受裸命令，这里需要带上完整的 compose 参数数组。
 */
async function feedFileToCompose(
  ctx: DataRestoreContext,
  command: string[],
  srcFile: string,
): Promise<number> {
  const res = await ctx.runner.run("sh", [
    "-c",
    `bin="$1"; src="$2"; shift 2; exec "$bin" "$@" < "$src"`,
    "noj-restore-feed",
    ctx.dockerBin,
    srcFile,
    ...ctx.composeArgs(command),
  ]);
  return res.code;
}

/**
 * 执行完整的数据恢复序列（PostgreSQL → Redis → MinIO）。
 *
 * 任一步失败即抛出具名错误——**不吞掉退出码**（见文件头第 2 条）。
 */
export async function restoreDataServices(
  ctx: DataRestoreContext,
): Promise<void> {
  const { runner, dockerBin, staging, tempDir, log } = ctx;
  const pgUser = valueOr(ctx.env, "POSTGRES_USER", "noj");
  const pgDb = valueOr(ctx.env, "POSTGRES_DB", "noj");

  // ---- 1. 起数据服务（必须 --wait，否则后续连接失败会掩盖根因）----
  log("✓ 启动数据服务（postgres/redis/minio）");
  if (
    await compose(ctx, [
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      String(ctx.waitTimeout),
      "postgres",
      "redis",
      "minio",
    ]) !== 0
  ) {
    throw new Error("数据服务启动失败");
  }
  // MinIO 桶初始化：**必须检查退出码**（曾因丢弃它把根因埋成"数据核对失败"）
  if (await compose(ctx, ["run", "--rm", "minio-init"]) !== 0) {
    throw new Error("MinIO 初始化失败（minio-init）");
  }

  // ---- 2. PostgreSQL：全局对象（幂等化后）→ 数据（输入来自文件）----
  log("✓ 恢复 PostgreSQL");
  const globals = await makeIdempotentGlobals(
    `${staging}/postgres-globals.sql`,
    `${tempDir}/postgres-globals.sql`,
  );
  if (globals !== 0) {
    throw new Error("生成幂等 PostgreSQL 全局对象脚本失败");
  }
  if (
    await feedFileToCompose(
      ctx,
      [
        "exec",
        "-T",
        "postgres",
        "psql",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        pgUser,
        "-d",
        pgDb,
      ],
      `${tempDir}/postgres-globals.sql`,
    ) !== 0
  ) {
    throw new Error("PostgreSQL 全局对象恢复失败");
  }
  if (
    await feedFileToCompose(
      ctx,
      [
        "exec",
        "-T",
        "postgres",
        "pg_restore",
        "--clean",
        "--if-exists",
        "--no-owner",
        "--exit-on-error",
        "-U",
        pgUser,
        "-d",
        pgDb,
      ],
      `${staging}/postgres.dump`,
    ) !== 0
  ) {
    throw new Error("PostgreSQL 数据恢复失败");
  }

  // ---- 3. Redis：停 → 写 RDB（从文件喂 stdin）→ 起 ----
  log("✓ 恢复 Redis");
  if (await compose(ctx, ["stop", "redis"]) !== 0) {
    throw new Error("停止 Redis 失败");
  }
  if (
    await feedFileToCompose(
      ctx,
      [
        "run",
        "--rm",
        "--no-deps",
        "--entrypoint",
        "/bin/sh",
        "redis",
        "-c",
        "set -eu; rm -rf /data/appendonlydir /data/dump.rdb; cat > /data/dump.rdb",
      ],
      `${staging}/redis.rdb`,
    ) !== 0
  ) {
    throw new Error("写入 Redis RDB 失败");
  }
  if (
    await compose(ctx, [
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      String(ctx.waitTimeout),
      "redis",
    ]) !== 0
  ) {
    throw new Error("恢复后 Redis 启动失败");
  }

  // ---- 4. MinIO：挂 staging 的 minio/ 进容器后 mirror ----
  log("✓ 恢复 MinIO/S3 对象");
  const bucket = valueOr(ctx.env, "S3_BUCKET", "noj-support-packages");
  if (
    await compose(ctx, [
      "run",
      "--rm",
      "--no-deps",
      "--entrypoint",
      "/bin/sh",
      "-v",
      `${staging}/minio:/restore:ro`,
      "minio-init",
      "-c",
      `set -eu; for i in $(seq 1 30); do mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1 && break; sleep 2; done; mc mirror --overwrite --remove /restore "local/${bucket}"`,
    ]) !== 0
  ) {
    throw new Error("MinIO/S3 对象恢复失败");
  }

  // ---- 5. 收尾（生产语义：停服务等人工检查；drill：保留给后续验收）----
  if (ctx.stopAfterRestore) {
    log("✓ 停止数据服务（请人工检查后再启动业务服务）");
    // 与 bash 一致：`|| true` —— 收尾失败不该把"数据已恢复成功"报成失败。
    await compose(ctx, ["stop", "postgres", "redis", "minio"]);
  }
  void runner;
  void dockerBin;
}
