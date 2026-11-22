/** 演练隔离栈的 compose 步骤：起服务、恢复数据、数据校验与业务服务启动。 */

import { join } from "@std/path";
import { type CommandRunner } from "../../runtime/command.ts";
import {
  compose,
  type ComposeTarget,
  feedFileToCompose,
  restoreDataServices as sharedRestoreDataServices,
  startOneShotService,
} from "../backup/data_restore.ts";
import {
  DEFAULT_EVALUATOR_IMAGE,
  DEFAULT_SOLUTION_IMAGE,
  drillComposeArgs,
  renderDisableOutboundIntegrationsSql,
} from "./plan.ts";
import { valueOr } from "../env-values.ts";
import { type ChecksInput } from "./report.ts";
import { START_SERVICE_ERRORS } from "./runtime.ts";
import { type DrillRunOptions } from "./drill.ts";
import { readTextOr } from "./finish.ts";

/** 演练的隔离运行期上下文（compose 参数与路径都从这里派生）。 */
export interface DrillContext {
  projectName: string;
  subnet: string;
  dir: string;
  snapshot: string;
  staging: string;
  drillDir: string;
  tempDir: string;
  composeFile: string;
  composeEnvFile: string;
  overrideFile: string;
  reportPath: string;
  env: Record<string, string>;
  judge: boolean;
}

/** docker 可执行名。 */
export function dockerBinOf(opts: DrillRunOptions): string {
  return opts.dockerBin ?? "docker";
}

/** 演练隔离项目的 Compose 调用目标（项目名 / env / override 固定）。 */
export function drillTarget(
  ctx: DrillContext,
  runner: CommandRunner,
  dockerBin: string,
): ComposeTarget {
  return {
    runner,
    dockerBin,
    composeArgs: (command) =>
      drillComposeArgs({
        projectName: ctx.projectName,
        composeEnvFile: ctx.composeEnvFile,
        composeFile: ctx.composeFile,
        overrideFile: ctx.overrideFile,
        judge: ctx.judge,
        command,
      }),
  };
}

async function startComposeService(
  ctx: DrillContext,
  runner: CommandRunner,
  dockerBin: string,
  service: string,
  waitTimeout: number,
): Promise<void> {
  const code = service === "core"
    ? await compose(drillTarget(ctx, runner, dockerBin), [
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      String(waitTimeout),
      service,
    ])
    : await startOneShotService(drillTarget(ctx, runner, dockerBin), service);
  if (code !== 0) {
    throw new Error(
      START_SERVICE_ERRORS[service as keyof typeof START_SERVICE_ERRORS] ??
        `隔离服务启动失败：${service}`,
    );
  }
}

/** `restore_data_services()`：启动隔离数据服务并恢复三类数据。 */
/**
 * 恢复三类数据服务（**委托给 `backup/data_restore.ts` 的共享序列**）。
 *
 * 抽取理由见该模块头部：这段序列的顺序与错误处理是反复修正出来的，
 * 分成 drill 与生产 restore 两份必然漂移——而"演练通过但真实恢复没做对"
 * 是最坏的一类不一致（drill 的全部意义就是证明 restore 可行）。
 *
 * 本函数只负责**把 drill 的上下文适配成共享接口**（隔离项目参数 + 不停服务，
 * 因为 drill 后续还要起业务服务做验收）。
 */
export async function restoreDataServices(
  ctx: DrillContext,
  runner: CommandRunner,
  dockerBin: string,
  waitTimeout: number,
  log: (line: string) => void,
): Promise<void> {
  await sharedRestoreDataServices({
    ...drillTarget(ctx, runner, dockerBin),
    staging: ctx.staging,
    tempDir: ctx.tempDir,
    env: ctx.env,
    waitTimeout,
    log,
    // drill 之后还要起业务服务做验收，故 **不** 在恢复后停服务。
    stopAfterRestore: false,
  });
}

/** `verify_data()`：迁移版本、用户数、Redis 键数、对象数。 */
export async function verifyData(
  ctx: DrillContext,
  runner: CommandRunner,
  dockerBin: string,
  log: (line: string) => void,
): Promise<ChecksInput> {
  const pgUser = valueOr(ctx.env, "POSTGRES_USER", "noj");
  const pgDb = valueOr(ctx.env, "POSTGRES_DB", "noj");

  const expected = (await readTextOr(
    join(ctx.staging, "migration-status.txt"),
    "",
  )).trim();
  if (expected === "" || expected === "not-initialized") {
    throw new Error("数据核对失败：快照缺少迁移状态记录");
  }
  const actual = (await psql(
    ctx,
    runner,
    dockerBin,
    pgUser,
    pgDb,
    "SELECT hash || ':' || created_at::text FROM drizzle.__drizzle_migrations ORDER BY created_at",
  )).trim();
  if (actual !== expected) {
    throw new Error("数据核对失败：迁移版本与快照不一致");
  }
  log("✓ 数据核对：迁移版本与快照一致");

  const userCountRaw = (await psql(
    ctx,
    runner,
    dockerBin,
    pgUser,
    pgDb,
    "SELECT count(*) FROM users",
  )).trim();
  if (!/^[0-9]+$/.test(userCountRaw)) {
    throw new Error("数据核对失败：无法读取用户数");
  }
  const restoredUserCount = Number(userCountRaw);
  log(`✓ 数据核对：恢复后用户数 ${restoredUserCount}`);

  const redisRaw = await composeCapture(ctx, runner, dockerBin, [
    "exec",
    "-T",
    "redis",
    "sh",
    "-c",
    'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --no-auth-warning DBSIZE',
  ]);
  const redisKeys = /^[0-9]+$/.test(redisRaw.trim())
    ? Number(redisRaw.trim())
    : 0;
  log(`✓ 数据核对：Redis 键数 ${redisKeys}`);

  const bucket = valueOr(ctx.env, "S3_BUCKET", "noj-support-packages");
  const snapshotObjectCount = await listFilesCount(
    join(ctx.staging, "minio"),
  );
  const restoredRaw = await composeCapture(ctx, runner, dockerBin, [
    "run",
    "--rm",
    "--no-deps",
    "--entrypoint",
    "/bin/sh",
    "minio-init",
    "-c",
    `set -eu; for i in $(seq 1 30); do mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1 && break; sleep 2; done; mc ls --recursive --json "local/${bucket}" | wc -l`,
  ]);
  const last = restoredRaw.trim().split("\n").pop()?.trim() ?? "";
  if (!/^[0-9]+$/.test(last)) {
    throw new Error("数据核对失败：无法读取恢复后的对象数");
  }
  const restoredObjectCount = Number(last);
  if (restoredObjectCount < snapshotObjectCount) {
    throw new Error(
      `数据核对失败：MinIO 对象数少于快照（快照 ${snapshotObjectCount} / 恢复 ${restoredObjectCount}）`,
    );
  }
  log(
    `✓ 数据核对：MinIO 对象数 快照 ${snapshotObjectCount} / 恢复 ${restoredObjectCount}`,
  );

  return {
    restoredUserCount,
    restoredRedisKeys: redisKeys,
    snapshotObjectCount,
    restoredObjectCount,
  };
}

/** 跑一条 psql 并返回 stdout（`-Atqc` 的紧凑输出）。 */
async function psql(
  ctx: DrillContext,
  runner: CommandRunner,
  dockerBin: string,
  user: string,
  db: string,
  sql: string,
): Promise<string> {
  return await composeCapture(ctx, runner, dockerBin, [
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    user,
    "-d",
    db,
    "-Atqc",
    sql,
  ]);
}

/** 跑一条 compose 子命令并**捕获 stdout**（仅用于文本查询结果，不用于二进制）。 */
async function composeCapture(
  ctx: DrillContext,
  runner: CommandRunner,
  dockerBin: string,
  command: string[],
): Promise<string> {
  const target = drillTarget(ctx, runner, dockerBin);
  const res = await runner.run(dockerBin, target.composeArgs(command));
  return res.stdout;
}

/** 统计目录内文件数（用于 MinIO 对象数核对）。 */
async function listFilesCount(dir: string): Promise<number> {
  let count = 0;
  const walk = async (d: string): Promise<void> => {
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(d));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory) await walk(join(d, entry.name));
      else if (entry.name !== "sha256sums.txt") count++;
    }
  };
  await walk(dir);
  return count;
}

/** 在隔离库经 `psql -v ON_ERROR_STOP=1` 执行一段 SQL；非零退出即抛错。 */
export async function runDrillSql(
  ctx: DrillContext,
  runner: CommandRunner,
  dockerBin: string,
  sql: string,
  failureMessage: string,
): Promise<void> {
  const pgUser = valueOr(ctx.env, "POSTGRES_USER", "noj");
  const pgDb = valueOr(ctx.env, "POSTGRES_DB", "noj");
  const code = await feedTextToCompose(ctx, runner, dockerBin, [
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
  ], sql);
  if (code !== 0) throw new Error(failureMessage);
}

/** 把一段 SQL 文本作为 stdin 喂给 compose 子命令（经临时文件，不经命令行参数）。 */
async function feedTextToCompose(
  ctx: DrillContext,
  runner: CommandRunner,
  dockerBin: string,
  command: string[],
  text: string,
): Promise<number> {
  const tmp = join(ctx.tempDir, `stdin-${crypto.randomUUID()}.sql`);
  await Deno.writeTextFile(tmp, text);
  try {
    return await feedFileToCompose(
      drillTarget(ctx, runner, dockerBin),
      command,
      tmp,
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

/** `start_business_services()` + `ensure_judge_images()`。 */
export async function startBusinessServices(
  ctx: DrillContext,
  runner: CommandRunner,
  dockerBin: string,
  waitTimeout: number,
  opts: DrillRunOptions,
  log: (line: string) => void,
): Promise<{ evaluator: string; solution: string }> {
  const start = (service: keyof typeof START_SERVICE_ERRORS) =>
    startComposeService(ctx, runner, dockerBin, service, waitTimeout);
  log("✓ 执行 Core 迁移/初始化（一次性服务）");
  // 这里必须使用 Compose 的 service 容器，而不是 `run --rm`：Core 迁移完成
  // 状态是后续 gateway-migrate/core 的 `service_completed_successfully` 依赖
  // 的依据。删除 one-shot 容器后再 `up core` 会让 Compose 重跑迁移，恢复演练
  // 就无法证明生产启动路径只执行一次显式 DDL。
  await start("migrate");

  log("✓ 执行 Gateway 迁移/默认配额初始化（一次性服务）");
  await start("gateway-migrate");

  // 出站集成禁用必须在 core 之前：core 启动时从 DB 加载系统设置缓存，
  // 之后再改 DB 不会生效（缓存未命中不回查）。
  log("✓ 禁用出站集成（邮件 / webhook / OAuth / LLM 上游）");
  await runDrillSql(
    ctx,
    runner,
    dockerBin,
    renderDisableOutboundIntegrationsSql(),
    "禁用演练出站集成失败",
  );

  log("✓ 启动隔离 Core HTTP 服务");
  await start("core");

  if (!ctx.judge) {
    log("! 跳过 judge（--skip-judge）：演练不包含真实评测");
    return {
      evaluator: DEFAULT_EVALUATOR_IMAGE,
      solution: DEFAULT_SOLUTION_IMAGE,
    };
  }

  log("✓ 启动 judge（使用与生产相同的独立沙箱 daemon）");
  if (
    await compose(drillTarget(ctx, runner, dockerBin), [
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      String(waitTimeout),
      "judge",
    ]) !== 0
  ) {
    throw new Error("隔离 judge 启动失败");
  }

  if (opts.resolveJudgeImages !== undefined) {
    return await opts.resolveJudgeImages({
      projectName: ctx.projectName,
      composeEnvFile: ctx.composeEnvFile,
      composeFile: ctx.composeFile,
      overrideFile: ctx.overrideFile,
    });
  }

  // 从隔离库的 judge_images 白名单取镜像（只读查询，不写入）。
  const pgUser = valueOr(ctx.env, "POSTGRES_USER", "noj");
  const pgDb = valueOr(ctx.env, "POSTGRES_DB", "noj");
  const evaluator = (await psql(
    ctx,
    runner,
    dockerBin,
    pgUser,
    pgDb,
    "SELECT image FROM judge_images WHERE kind = 'evaluator' ORDER BY CASE WHEN image LIKE '%noj-evaluator-python%' THEN 0 ELSE 1 END, created_at DESC LIMIT 1",
  )).trim().split("\n")[0]?.trim() ?? "";
  const solution = (await psql(
    ctx,
    runner,
    dockerBin,
    pgUser,
    pgDb,
    "SELECT image FROM judge_images WHERE kind = 'solution' ORDER BY CASE WHEN image LIKE '%noj-solution-python%' THEN 0 ELSE 1 END, created_at DESC LIMIT 1",
  )).trim().split("\n")[0]?.trim() ?? "";
  if (evaluator === "") {
    throw new Error("judge_images 白名单缺少 evaluator 镜像");
  }
  if (solution === "") {
    throw new Error("judge_images 白名单缺少 solution 镜像");
  }
  log(`✓ 评测镜像：evaluator=${evaluator} solution=${solution}`);
  return { evaluator, solution };
}
