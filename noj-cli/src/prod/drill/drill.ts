/**
 * 隔离恢复演练的编排（T19）。
 *
 * 迁移 `scripts/deploy/restore-drill.sh` 的 `main()`（:576-605）与
 * `restore_data_services()`（:340-376）、`verify_data()`（:377-424）、
 * `seed_drill_admin()`（:425-447）、`start_business_services()`（:448-466）、
 * `ensure_judge_images()`（:467-480）、`run_business_verification()`（:481-501）、
 * `on_exit()`（:165-186）。
 *
 * ## R1：本模块**零** bash / 脚本调用
 *
 * 原实现是 `restore-drill.sh` 的薄包装（`maintain/drill.ts` 的
 * `new Deno.Command("bash", …)`），且业务验收要在额外容器里跑
 * `deno run restore-drill-verify.ts`。移植后：
 * - 恢复序列全部经注入的 `CommandRunner` 发 `docker compose …`；
 * - 业务验收由 CLI 直接发 HTTP（见 `verify.ts`），经容器 IP 访问隔离网络。
 *
 * ## 退出码语义（#516 验收，三条都不变）
 *
 * | 码 | 含义 | 判定时机 |
 * | --- | --- | --- |
 * | 0 | 演练通过且 RPO/RTO 达标 | 全部步骤成功 |
 * | 1 | 演练失败（含 RPO/RTO 超限、业务验收失败、数据核对不符） | 恢复/核对/验收 |
 * | 2 | 参数或资源错误 | **起任何容器之前** |
 *
 * ## 失败也清理（#516 验收）
 *
 * 无论从哪个阶段退出，只要已经起了资源，就必须 `compose down -v --remove-orphans`
 * 并删演练目录（`--keep` 才保留）。**清理自身失败不掩盖原始错误**：原始失败原因
 * 是诊断的核心，清理失败只作为附加信息追加。
 *
 * ## 二进制与转储的搬运
 *
 * `postgres.dump` / `redis.rdb` 一律经**文件重定向**（T17 `driver.ts` 的
 * `feedFromFile`/`captureToFile` 语义），不经 stdout 字符串——理由见该模块头。
 *
 * 本模块不持有模块级可变状态（AGENTS.md §8.2）：状态全在一次运行对象里。
 */

import { join } from "@std/path";
import type { CommandRunner } from "../../runtime/command.ts";
import {
  type ContainerPayloadOps,
  unpackContainer,
} from "../backup/container.ts";
import { UsageError } from "../../util/args.ts";
import {
  allocateDrillDir,
  assertDrillProjectName,
  assertSubnetCidr,
  checkDrillPreflight,
  checkPassphraseFile,
  DEFAULT_DRILL_PROJECT_NAME,
  DEFAULT_DRILL_SUBNET,
  DEFAULT_EVALUATOR_IMAGE,
  DEFAULT_RPO_MAX_HOURS,
  DEFAULT_RTO_MAX_MINUTES,
  DEFAULT_SOLUTION_IMAGE,
  DEFAULT_WAIT_TIMEOUT,
  DRILL_ADMIN_EMAIL_DOMAIN,
  DRILL_ADMIN_USER,
  DRILL_BCRYPT_HASH,
  drillCleanupArgs,
  drillComposeArgs,
  isFile,
  probeDocker,
  probeFreeBytes,
  readEnvValues,
  renderDrillOverride,
  resolveReportPath,
  valueOr,
} from "./plan.ts";
import {
  type ChecksInput,
  DRILL_METRICS_FILE,
  formatHours,
  hoursSinceSnapshot,
  METRIC_LAST_SUCCESS,
  metricsDirOf,
  renderChecks,
  renderDrillMetrics,
  renderFailureReport,
  renderReport,
  REPORT_FILE_NAME,
  snapshotCreatedAt,
} from "./report.ts";
import { runBusinessVerification } from "./verify.ts";

/** {@link runDrill} 的注入点：一切外部访问都可替换。 */
export interface DrillRunOptions {
  /** 快照路径（`.nojbackup` 单文件）。 */
  snapshotPath: string;
  /** 生产安装目录。 */
  dir: string;
  /** 命令注入点（docker）。 */
  runner: CommandRunner;
  /** 解包与加密操作（缺省由 runner 构造真实 driver）。 */
  ops?: Pick<ContainerPayloadOps, "gpgDecrypt" | "untarZst">;
  /** 口令文件。 */
  passphraseFile?: string;
  /** 演练项目名（缺省 `noj-drill`）。 */
  projectName?: string;
  /** 演练子网（缺省 `172.29.0.0/16`）。 */
  subnet?: string;
  /** 演练目录（缺省快照同级的 `drill-<ts>`）。 */
  drillDir?: string;
  /** 报告路径（缺省快照同级的 `restore-drill-report.txt`）。 */
  report?: string;
  /** RPO 上限（小时，缺省 24）。 */
  rpoMaxHours?: number;
  /** RTO 上限（分钟，缺省 60）。 */
  rtoMaxMinutes?: number;
  /** Compose 等待超时（秒，缺省 300）。 */
  waitTimeout?: number;
  /** 跳过 judge 相关验收。 */
  skipJudge?: boolean;
  /** 保留演练资源与目录（供人工检查）。 */
  keep?: boolean;
  /** 人类日志汇聚点。 */
  log?: (line: string) => void;
  /** HTTP 客户端（业务验收用；缺省全局 fetch）。 */
  fetch?: typeof fetch;
  /** 时间源（测试注入）。 */
  now?: () => Date;
  /** 睡眠（测试注入以避免真实等待）。 */
  sleep?: (ms: number) => Promise<void>;
  /** 指标目录（缺省快照同级 `metrics/`）。 */
  metricsDir?: string;
  /** judge 镜像白名单的注入点（缺省用 runner 查隔离库）。 */
  resolveJudgeImages?: (ctx: JudgeImageContext) => Promise<{
    evaluator: string;
    solution: string;
  }>;
  /** docker 可执行名（`NOJ_BACKUP_DOCKER_BIN`）。 */
  dockerBin?: string;
}

/** 查评测镜像白名单的上下文。 */
export interface JudgeImageContext {
  projectName: string;
  composeEnvFile: string;
  composeFile: string;
  overrideFile: string;
}

/** 演练结果。 */
export interface DrillRunResult {
  /** 是否通过（含 RPO/RTO 达标）。 */
  pass: boolean;
  /** 0 通过 / 1 演练失败 / 2 参数或资源错误。 */
  exitCode: number;
  /** 报告路径；前置阶段失败时为 null（此时未写报告）。 */
  reportPath: string | null;
  /** 面向用户的一句话结论。 */
  message: string;
  /** 失败的阶段名（成功时 null）。 */
  failedStage: string | null;
  /** 数据核对明细（成功时非 null）。 */
  checks: ChecksInput | null;
}

/** 演练的隔离运行期上下文（compose 参数与路径都从这里派生）。 */
interface DrillContext {
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

/**
 * 执行隔离恢复演练。
 *
 * 流程（阶段名与 bash `STAGE` 逐条对应，用于失败报告定位）：
 * `preflight`（参数/资源/快照校验，**零 compose 调用**）→ `prepare`（目录、解密 env、
 * 覆盖文件）→ `restore-data` → `verify-data` → `seed-admin` → `start-business`
 * → `business-verify` → `report`。
 *
 * **前置失败返回 2 且不写报告**（bash 同样在 preflight 不写）；其余失败写失败
 * 报告、清理资源、返回 1。
 */
export async function runDrill(
  opts: DrillRunOptions,
): Promise<DrillRunResult> {
  const runner = opts.runner;
  const log = opts.log ?? (() => {});
  const now = opts.now ?? (() => new Date());
  const dockerBin = opts.dockerBin ?? "docker";
  const projectName = opts.projectName ?? DEFAULT_DRILL_PROJECT_NAME;
  const subnet = opts.subnet ?? DEFAULT_DRILL_SUBNET;
  const rpoMaxHours = opts.rpoMaxHours ?? DEFAULT_RPO_MAX_HOURS;
  const rtoMaxMinutes = opts.rtoMaxMinutes ?? DEFAULT_RTO_MAX_MINUTES;
  const waitTimeout = opts.waitTimeout ?? DEFAULT_WAIT_TIMEOUT;
  const judge = opts.skipJudge !== true;
  const keep = opts.keep === true;

  // ---- 参数校验：**最先**（纯参数错误不应被资源错误掩盖）----
  try {
    assertDrillProjectName(projectName);
    if (opts.subnet !== undefined) assertSubnetCidr(subnet);
    assertNonNegativeInt("RPO", rpoMaxHours);
    assertNonNegativeInt("RTO", rtoMaxMinutes);
    if (opts.passphraseFile === undefined || opts.passphraseFile === "") {
      throw new UsageError(
        "必须提供 --passphrase-file 或 NOJ_BACKUP_PASSPHRASE_FILE",
      );
    }
  } catch (err) {
    return preflightFailure(err);
  }

  // ---- 解包快照（在资源检查之前：损坏的快照不该先起容器）----
  let staged: { staging: string; tempRoot: string };
  try {
    staged = await unpackForDrill(opts, projectName, now);
  } catch (err) {
    return preflightFailure(err);
  }

  const ctx: DrillContext = {
    projectName,
    subnet,
    dir: opts.dir,
    snapshot: opts.snapshotPath,
    staging: staged.staging,
    drillDir: staged.tempRoot,
    tempDir: join(staged.tempRoot, ".work"),
    composeFile: join(opts.dir, "docker-compose.prod.yml"),
    composeEnvFile: join(staged.tempRoot, ".work/env.drill"),
    overrideFile: join(staged.tempRoot, ".work/compose.drill-override.yml"),
    reportPath: resolveReportPath(opts.snapshotPath, opts.report),
    env: {},
    judge,
  };
  const reportPath = ctx.reportPath;

  try {
    // ---- preflight（资源 + 口令 + 环境文件；全部在起容器之前）----
    await checkPassphraseFile(opts.passphraseFile!);
    ctx.env = await readEnvValues(join(opts.dir, ".env.prod"));
    await checkDrillPreflight({
      staging: ctx.staging,
      dir: opts.dir,
      envFile: join(opts.dir, ".env.prod"),
      composeFile: ctx.composeFile,
      projectName,
      dockerAvailable: probeDocker(runner, dockerBin),
      freeBytes: probeFreeBytes(runner, staged.tempRoot),
    });
  } catch (err) {
    await cleanupStaging(staged.tempRoot, keep);
    return preflightFailure(err);
  }

  // ---- prepare：写入覆盖文件与解密后的 env ----
  const startedAt = now().toISOString();
  try {
    await prepareDrillEnvironment(opts, ctx, runner);
  } catch (err) {
    const message = (err as Error).message;
    return await failAndCleanup(
      opts,
      ctx,
      runner,
      keep,
      "prepare",
      message,
      startedAt,
      log,
    );
  }

  const totalStart = now().getTime();
  let restoreSeconds = 0;
  let checks: ChecksInput | null = null;
  const verifyLines: string[] = [];

  try {
    // ---- restore-data ----
    const restoreStart = now().getTime();
    await restoreDataServices(opts, ctx, runner, dockerBin, waitTimeout, log);
    // ---- verify-data ----
    checks = await verifyData(ctx, runner, dockerBin, log);
    restoreSeconds = Math.round((now().getTime() - restoreStart) / 1000);

    // ---- seed-admin + start-business ----
    await seedDrillAdmin(ctx, runner, dockerBin, now);
    const judgeImages = await startBusinessServices(
      ctx,
      runner,
      dockerBin,
      waitTimeout,
      opts,
      log,
    );

    // ---- business-verify（原生 HTTP，经容器 IP）----
    const coreUrl = await resolveCoreBaseUrl(ctx, runner, dockerBin);
    const verify = await runBusinessVerification({
      baseUrl: coreUrl,
      fetch: opts.fetch ?? fetch,
      evaluatorImage: judgeImages.evaluator,
      solutionImage: judgeImages.solution,
      skipEvaluation: !judge,
      sleep: opts.sleep,
      now: opts.now === undefined ? undefined : () => opts.now!().getTime(),
      log: (line) => {
        verifyLines.push(line);
        log(line);
      },
    });
    if (!verify.passed) {
      throw new Error(
        `业务验收未通过：${verify.firstFailure ?? "未知原因"}`,
      );
    }
  } catch (err) {
    const message = (err as Error).message;
    return await failAndCleanup(
      opts,
      ctx,
      runner,
      keep,
      "business-verify",
      message,
      startedAt,
      log,
      verifyLines.join("\n"),
    );
  }

  // ---- report：RPO/RTO 硬阈值 ----
  const totalSeconds = Math.round((now().getTime() - totalStart) / 1000);
  const rtoMinutes = Math.floor(totalSeconds / 60);
  const createdAt = snapshotCreatedAt(
    await readTextOr(join(ctx.staging, "manifest.json"), ""),
  );
  const rpoHours = hoursSinceSnapshot(createdAt, now());
  const rpoMet = rpoHours <= rpoMaxHours;
  const rtoMet = rtoMinutes <= rtoMaxMinutes;
  const result: "passed" | "passed_with_warnings" = rpoMet && rtoMet
    ? "passed"
    : "passed_with_warnings";

  await writeReport(ctx, {
    result,
    snapshotCreatedAt: createdAt,
    drillStartedAt: startedAt,
    drillFinishedAt: now().toISOString(),
    restoreDurationSeconds: restoreSeconds,
    totalDurationSeconds: totalSeconds,
    rpoHours: formatHours(rpoHours),
    rpoTargetHours: rpoMaxHours,
    rpoMet,
    rtoMinutes,
    rtoTargetMinutes: rtoMaxMinutes,
    rtoMet,
    verifyLog: verifyLines.join("\n"),
    cleanup: keep ? "kept-for-review" : "done",
  }, checks!);

  // ---- 清理（成功路径；失败路径由 failAndCleanup 负责）----
  if (!keep) {
    await downDrillStack(ctx, runner, dockerBin);
    await removeQuietly(ctx.drillDir);
  }

  // 指标**只在成功且 RPO/RTO 达标时**写：告警语义是"最近一次成功距今多久"，
  // 让"跑完但超标"也刷新时间戳会掩盖演练失效这件事。
  if (rpoMet && rtoMet) {
    await writeMetrics(opts, ctx, now());
  } else {
    log(
      `! RPO/RTO 未达标（RPO ${
        formatHours(rpoHours)
      }h / 目标 ${rpoMaxHours}h；` +
        `RTO ${rtoMinutes}min / 目标 ${rtoMaxMinutes}min），已按演练失败处理且不刷新指标`,
    );
  }

  const pass = rpoMet && rtoMet;
  return {
    pass,
    exitCode: pass ? 0 : 1,
    reportPath,
    failedStage: pass ? null : "rpo-rto",
    checks,
    message: pass
      ? "恢复演练通过：隔离环境成功恢复并通过业务验收"
      : "恢复演练失败：RPO/RTO 未达标（详见报告）——演练要求硬阈值达标",
  };
}

/** 前置失败（退出码 2，**零 compose 调用**、不写报告——bash preflight 同样不写）。 */
function preflightFailure(err: unknown): DrillRunResult {
  return {
    pass: false,
    exitCode: 2,
    reportPath: null,
    failedStage: "preflight",
    checks: null,
    message: (err as Error).message,
  };
}

/** 非负整数校验（bash :277 的 `[[ =~ ^[0-9]+$ ]]`）。 */
function assertNonNegativeInt(label: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new UsageError(`${label} 目标必须是非负整数，收到 "${value}"`);
  }
}

/** 解包快照到演练目录（接受 `.nojbackup` 单文件——T19 的形态反转）。 */
async function unpackForDrill(
  opts: DrillRunOptions,
  projectName: string,
  now: () => Date,
): Promise<{ staging: string; tempRoot: string }> {
  if (!opts.snapshotPath.endsWith(".nojbackup")) {
    throw new UsageError(
      `drill 只接受 .nojbackup 单文件快照：${opts.snapshotPath}\n` +
        "  原因：T17 起单文件容器是唯一形态（payload_layout=prod-raw），" +
        "目录形态的旧快照已不受支持。",
    );
  }
  const drillDir = await allocateDrillDir(
    opts.snapshotPath,
    now(),
    opts.drillDir,
  );
  await Deno.mkdir(join(drillDir, ".work"), { recursive: true, mode: 0o700 });
  await Deno.chmod(drillDir, 0o700);

  // gpg 从**文件参数**读输入（不是 stdin），故走 run；tar 同理。
  // 只有二进制 payload 的采集/回灌才需要文件重定向（见 backup/driver.ts）。
  const ops = opts.ops ?? {
    async gpgDecrypt(src, dest, passphraseFile) {
      const res = await opts.runner.run("gpg", [
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
      if (res.code !== 0) throw new Error("gpg 解密失败");
    },
    async untarZst(src, destDir) {
      await Deno.mkdir(destDir, { recursive: true });
      const res = await opts.runner.run("tar", [
        "-I",
        "zstd",
        "-xf",
        src,
        "-C",
        destDir,
      ]);
      if (res.code !== 0) throw new Error(`tar 解包失败：${res.stderr.trim()}`);
    },
  };

  const unpacked = await unpackContainer({
    path: opts.snapshotPath,
    destDir: join(drillDir, ".work/unpack"),
    passphraseFile: opts.passphraseFile,
    ops,
  });

  // payload_layout 是唯一形态契约：非 prod-raw 一律拒绝（无分派）。
  if (unpacked.manifest?.payload_layout !== "prod-raw") {
    throw new UsageError(
      `快照 payload_layout 不受支持：${
        unpacked.manifest?.payload_layout ?? "(缺失)"
      }（只支持 prod-raw）`,
    );
  }
  void projectName;
  return { staging: unpacked.staging, tempRoot: drillDir };
}

/** 写覆盖文件与解密后的 env（bash `prepare_env`/`prepare_compose_override`）。 */
async function prepareDrillEnvironment(
  opts: DrillRunOptions,
  ctx: DrillContext,
  runner: CommandRunner,
): Promise<void> {
  // 解密 env.prod.gpg 到演练 env，并叠加隔离配置（评测器网络名指向演练网络）
  const code = await runner.run("gpg", [
    "--batch",
    "--yes",
    "--pinentry-mode",
    "loopback",
    "--passphrase-file",
    opts.passphraseFile!,
    "--decrypt",
    "--output",
    ctx.composeEnvFile,
    join(ctx.staging, "env.prod.gpg"),
  ]);
  if (code.code !== 0) throw new Error("解密快照内的环境文件失败");
  const size = (await Deno.stat(ctx.composeEnvFile)).size;
  if (size === 0) throw new Error("解密后的环境文件为空");
  await Deno.chmod(ctx.composeEnvFile, 0o600);
  await Deno.writeTextFile(
    ctx.composeEnvFile,
    `\n# ---- restore-drill 隔离覆盖（自动生成，勿提交） ----\n` +
      `JUDGE_EVALUATOR_NETWORK=${ctx.projectName}_noj-net\n`,
    { append: true },
  );

  await Deno.writeTextFile(ctx.overrideFile, renderDrillOverride(ctx.subnet));
  // 只读解析校验（`compose config --quiet`）
  const check = await runner.run(
    dockerBinOf(opts),
    drillComposeArgs({
      projectName: ctx.projectName,
      composeEnvFile: ctx.composeEnvFile,
      composeFile: ctx.composeFile,
      overrideFile: ctx.overrideFile,
      judge: ctx.judge,
      command: ["config", "--quiet"],
    }),
  );
  if (check.code !== 0) {
    throw new Error("演练 Compose 配置无效：" + check.stderr.trim());
  }
}

/** docker 可执行名。 */
function dockerBinOf(opts: DrillRunOptions): string {
  return opts.dockerBin ?? "docker";
}

/** 执行一条演练 compose 子命令并返回退出码。 */
async function compose(
  ctx: DrillContext,
  runner: CommandRunner,
  dockerBin: string,
  command: string[],
): Promise<number> {
  const res = await runner.run(
    dockerBin,
    drillComposeArgs({
      projectName: ctx.projectName,
      composeEnvFile: ctx.composeEnvFile,
      composeFile: ctx.composeFile,
      overrideFile: ctx.overrideFile,
      judge: ctx.judge,
      command,
    }),
  );
  return res.code;
}

/** `restore_data_services()`（bash :340-376）：启动隔离数据服务并恢复三类数据。 */
async function restoreDataServices(
  opts: DrillRunOptions,
  ctx: DrillContext,
  runner: CommandRunner,
  dockerBin: string,
  waitTimeout: number,
  log: (line: string) => void,
): Promise<void> {
  log("✓ 启动隔离数据服务（postgres/redis/minio）");
  if (
    await compose(ctx, runner, dockerBin, [
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      String(waitTimeout),
      "postgres",
      "redis",
      "minio",
    ]) !== 0
  ) {
    throw new Error("隔离数据服务启动失败");
  }
  // **必须检查退出码**（评审发现）：bash 对每一步都是 `|| die`，
  // 而这里此前丢弃了返回值——`minio-init` 失败会变成后面某个更难懂的错误
  // （例如"数据核对失败"），把根因埋掉。
  if (
    await compose(ctx, runner, dockerBin, ["run", "--rm", "minio-init"]) !== 0
  ) {
    throw new Error("MinIO 初始化失败（minio-init）");
  }

  const pgUser = valueOr(ctx.env, "POSTGRES_USER", "noj");
  const pgDb = valueOr(ctx.env, "POSTGRES_DB", "noj");

  // PostgreSQL：全局对象（幂等化后）→ 数据（**pg_restore 的输入来自文件**）
  log("✓ 恢复 PostgreSQL");
  const globals = await makeIdempotentGlobals(
    join(ctx.staging, "postgres-globals.sql"),
    join(ctx.tempDir, "postgres-globals.sql"),
  );
  if (globals !== 0) {
    throw new Error("生成幂等 PostgreSQL 全局对象脚本失败");
  }
  const globalsCode = await feedFileToCompose(
    ctx,
    runner,
    dockerBin,
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
    join(ctx.tempDir, "postgres-globals.sql"),
  );
  if (globalsCode !== 0) throw new Error("PostgreSQL 全局对象恢复失败");

  const restoreCode = await feedFileToCompose(
    ctx,
    runner,
    dockerBin,
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
    join(ctx.staging, "postgres.dump"),
  );
  if (restoreCode !== 0) throw new Error("PostgreSQL 数据恢复失败");

  // Redis：停 → 写 RDB（**从文件喂 stdin**）→ 起
  log("✓ 恢复 Redis");
  if (await compose(ctx, runner, dockerBin, ["stop", "redis"]) !== 0) {
    throw new Error("停止 Redis 失败");
  }
  const rdbCode = await feedFileToCompose(
    ctx,
    runner,
    dockerBin,
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
    join(ctx.staging, "redis.rdb"),
  );
  if (rdbCode !== 0) throw new Error("写入 Redis RDB 失败");
  if (
    await compose(ctx, runner, dockerBin, [
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      String(waitTimeout),
      "redis",
    ]) !== 0
  ) {
    throw new Error("恢复后 Redis 启动失败");
  }

  // MinIO：把 staging 的 minio/ 目录挂进容器后 mc mirror
  log("✓ 恢复 MinIO/S3 对象");
  const bucket = valueOr(ctx.env, "S3_BUCKET", "noj-support-packages");
  const mirrorCode = await compose(ctx, runner, dockerBin, [
    "run",
    "--rm",
    "--no-deps",
    "--entrypoint",
    "/bin/sh",
    "-v",
    `${join(ctx.staging, "minio")}:/restore:ro`,
    "minio-init",
    "-c",
    `set -eu; for i in $(seq 1 30); do mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1 && break; sleep 2; done; mc mirror --overwrite --remove /restore "local/${bucket}"`,
  ]);
  if (mirrorCode !== 0) throw new Error("MinIO/S3 对象恢复失败");
  void opts;
}

/**
 * 把文件喂给一条 compose 子命令的 stdin（**文件重定向，不经字符串**）。
 *
 * 用 `sh -c '<cmd> "$@" < "$src"'` 的形式：路径经位置参数传递，不拼进脚本正文；
 * `docker` 由位置参数给出。这是 T17 `driver.ts:feedFromFile` 的同一语义，
 * 但那里只接受裸命令，这里需要带上完整的 compose 参数数组。
 */
async function feedFileToCompose(
  ctx: DrillContext,
  runner: CommandRunner,
  dockerBin: string,
  command: string[],
  srcFile: string,
): Promise<number> {
  const composeArgs = drillComposeArgs({
    projectName: ctx.projectName,
    composeEnvFile: ctx.composeEnvFile,
    composeFile: ctx.composeFile,
    overrideFile: ctx.overrideFile,
    judge: ctx.judge,
    command,
  });
  // 安全：dockerBin 走 $1，compose 参数走 "$@"，均不经脚本正文插值。
  const res = await runner.run("sh", [
    "-c",
    `bin="$1"; src="$2"; shift 2; exec "$bin" "$@" < "$src"`,
    "noj-drill-feed",
    dockerBin,
    srcFile,
    ...composeArgs,
  ]);
  return res.code;
}

/**
 * 把 `pg_dumpall --globals-only` 的 `CREATE ROLE` 改为幂等形式
 * （bash `prepare_idempotent_globals` :150-170 的等价）。
 *
 * 为什么需要：目标 PostgreSQL 已由 `POSTGRES_USER` 创建了默认角色，
 * 直接重放 `CREATE ROLE` 会以 "role already exists" 失败。改写为
 * `DO $$ BEGIN IF NOT EXISTS (...) THEN CREATE ROLE …; END IF; END $$;`。
 */
export async function makeIdempotentGlobals(
  source: string,
  target: string,
): Promise<number> {
  let text: string;
  try {
    text = await Deno.readTextFile(source);
  } catch {
    await Deno.writeTextFile(target, "");
    return 1;
  }
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("CREATE ROLE ")) {
      const identifier = line.slice("CREATE ROLE ".length).replace(/;\s*$/, "");
      let name = identifier;
      if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) {
        name = name.slice(1, -1).replace(/""/g, '"');
      }
      const escaped = name.replace(/'/g, "''");
      out.push(
        `DO $role$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${escaped}') THEN CREATE ROLE ${identifier}; END IF; END $role$;`,
      );
      continue;
    }
    out.push(line);
  }
  await Deno.writeTextFile(target, out.join("\n"));
  return 0;
}

/** `verify_data()`（bash :377-424）：迁移版本、用户数、Redis 键数、对象数。 */
async function verifyData(
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
  const res = await runner.run(
    dockerBin,
    drillComposeArgs({
      projectName: ctx.projectName,
      composeEnvFile: ctx.composeEnvFile,
      composeFile: ctx.composeFile,
      overrideFile: ctx.overrideFile,
      judge: ctx.judge,
      command,
    }),
  );
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

/** `seed_drill_admin()`（bash :425-447）：向隔离库写入演练管理员。 */
async function seedDrillAdmin(
  ctx: DrillContext,
  runner: CommandRunner,
  dockerBin: string,
  now: () => Date,
): Promise<void> {
  const pgUser = valueOr(ctx.env, "POSTGRES_USER", "noj");
  const pgDb = valueOr(ctx.env, "POSTGRES_DB", "noj");
  const stamp = now().toISOString().replace(/\.\d{3}Z$/, ".000Z");
  // email_verified 刻意不写：它是后续迁移新增的字段，新 schema 默认 true；
  // 不显式写入才能同时恢复并验收迁移前的历史快照（bash 注释的同一理由）。
  const sql = [
    "INSERT INTO users (id, username, email, password_hash, created_at, updated_at)",
    `VALUES ('drill-admin-user', '${DRILL_ADMIN_USER}', 'drill-admin@${DRILL_ADMIN_EMAIL_DOMAIN}',`,
    `        '${DRILL_BCRYPT_HASH}', '${stamp}', '${stamp}')`,
    "ON CONFLICT (id) DO NOTHING;",
    "INSERT INTO user_roles (user_id, role_id)",
    "SELECT 'drill-admin-user', id FROM roles WHERE name = 'admin'",
    "ON CONFLICT DO NOTHING;",
  ].join("\n");
  const code = await feedTextToCompose(
    ctx,
    runner,
    dockerBin,
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
    sql,
  );
  if (code !== 0) throw new Error("写入演练管理员失败");
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
    return await feedFileToCompose(ctx, runner, dockerBin, command, tmp);
  } finally {
    await removeQuietly(tmp);
  }
}

/** `start_business_services()` + `ensure_judge_images()`（bash :448-480）。 */
async function startBusinessServices(
  ctx: DrillContext,
  runner: CommandRunner,
  dockerBin: string,
  waitTimeout: number,
  opts: DrillRunOptions,
  log: (line: string) => void,
): Promise<{ evaluator: string; solution: string }> {
  log("✓ 执行迁移并启动 core");
  // 同上：迁移失败必须立刻显式报错，否则会表现为 core 起不来
  // （"隔离 core 启动失败"），掩盖"其实是迁移失败"这一根因。
  if (await compose(ctx, runner, dockerBin, ["run", "--rm", "migrate"]) !== 0) {
    throw new Error("数据库迁移失败（migrate）");
  }
  if (
    await compose(ctx, runner, dockerBin, [
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      String(waitTimeout),
      "core",
    ]) !== 0
  ) {
    throw new Error("隔离 core 启动失败");
  }

  if (!ctx.judge) {
    log("! 跳过 judge（--skip-judge）：演练不包含真实评测");
    return {
      evaluator: DEFAULT_EVALUATOR_IMAGE,
      solution: DEFAULT_SOLUTION_IMAGE,
    };
  }

  log("✓ 启动 judge（使用与生产相同的独立沙箱 daemon）");
  if (
    await compose(ctx, runner, dockerBin, [
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

/**
 * 解析 core 的 API 基址（**经容器 IP**，不依赖端口映射）。
 *
 * 隔离演练**不映射宿主机端口**（#516 要求），因此不能走 `localhost:8080`。
 * 取法：`compose ps -q core` 得到容器 ID → `docker inspect` 读它在演练网络里的
 * IP → `http://<ip>:8000/api/v1`。
 */
async function resolveCoreBaseUrl(
  ctx: DrillContext,
  runner: CommandRunner,
  dockerBin: string,
): Promise<string> {
  const idRes = await runner.run(
    dockerBin,
    drillComposeArgs({
      projectName: ctx.projectName,
      composeEnvFile: ctx.composeEnvFile,
      composeFile: ctx.composeFile,
      overrideFile: ctx.overrideFile,
      judge: ctx.judge,
      command: ["ps", "-q", "core"],
    }),
  );
  const containerId = idRes.stdout.trim().split("\n")[0]?.trim() ?? "";
  if (containerId === "") throw new Error("无法定位隔离 core 容器");

  const inspect = await runner.run(dockerBin, [
    "inspect",
    "--format",
    "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
    containerId,
  ]);
  const ip = inspect.stdout.trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    throw new Error(`无法解析隔离 core 的容器 IP：${JSON.stringify(ip)}`);
  }
  return `http://${ip}:8000/api/v1`;
}

/** 写报告（权限 600）与指标目录准备。 */
async function writeReport(
  ctx: DrillContext,
  input:
    & Omit<
      Parameters<typeof renderReport>[0],
      "snapshot" | "composeProject" | "networkSubnet" | "checks" | "cleanup"
    >
    & { cleanup: "kept-for-review" | "done" },
  checks: ChecksInput,
): Promise<void> {
  const text = renderReport({
    ...input,
    snapshot: ctx.snapshot,
    composeProject: ctx.projectName,
    networkSubnet: ctx.subnet,
    checks: renderChecks(checks),
  });
  await writePrivate(ctx.reportPath, text);
}

/** 写演练指标（仅成功路径调用）。 */
async function writeMetrics(
  opts: DrillRunOptions,
  ctx: DrillContext,
  at: Date,
): Promise<void> {
  const dir = metricsDirOf(ctx.snapshot, opts.metricsDir);
  await Deno.mkdir(dir, { recursive: true, mode: 0o755 });
  const file = join(dir, DRILL_METRICS_FILE);
  await Deno.writeTextFile(
    file,
    renderDrillMetrics(Math.floor(at.getTime() / 1000)),
  );
  await Deno.chmod(file, 0o644);
}

/** 原子写一个 600 文件（报告含内部 URL 与题目 ID，不应全局可读）。 */
async function writePrivate(path: string, text: string): Promise<void> {
  const tmp = `${path}.${Deno.pid}.${crypto.randomUUID()}.tmp`;
  await Deno.mkdir(path.substring(0, path.lastIndexOf("/")), {
    recursive: true,
  }).catch(() => {});
  const file = await Deno.open(tmp, {
    create: true,
    write: true,
    truncate: true,
    mode: 0o600,
  });
  try {
    await file.write(new TextEncoder().encode(text));
  } finally {
    file.close();
  }
  await Deno.chmod(tmp, 0o600);
  await Deno.rename(tmp, path);
}

/**
 * 失败路径：写失败报告 → 清理资源 → 返回退出码 1。
 *
 * **清理失败不掩盖原始错误**：原始失败原因（`message`）是诊断核心，清理问题
 * 只作为附加信息追加到 message 尾部，且不影响退出码（仍是 1）。
 */
async function failAndCleanup(
  opts: DrillRunOptions,
  ctx: DrillContext,
  runner: CommandRunner,
  keep: boolean,
  stage: string,
  message: string,
  startedAt: string,
  log: (line: string) => void,
  verifyLog = "",
): Promise<DrillRunResult> {
  const cleanup: "kept-for-review" | "done" = keep ? "kept-for-review" : "done";
  let reportError: string | null = null;

  // 1) 先写失败报告（需要读验收日志，故在清理之前）
  if (stage !== "preflight") {
    try {
      await writePrivate(
        ctx.reportPath,
        renderFailureReport({
          snapshot: ctx.snapshot,
          failedStage: stage,
          drillStartedAt: startedAt,
          composeProject: ctx.projectName,
          verifyLogTail: tailLines(verifyLog, 50),
          cleanup,
        }),
      );
      log(`! 演练在 ${stage} 阶段失败，报告：${ctx.reportPath}`);
    } catch (err) {
      reportError = (err as Error).message;
    }
  }

  // 2) 清理资源（--keep 时保留）
  const cleanupErrors: string[] = [];
  if (reportError !== null) cleanupErrors.push(`写报告失败：${reportError}`);
  if (!keep) {
    const code = await downDrillStack(ctx, runner, dockerBinOf(opts));
    if (code !== 0) {
      cleanupErrors.push(`清理演练 Compose 资源失败（退出码 ${code}）`);
    }
    try {
      await removeQuietly(ctx.drillDir);
    } catch (err) {
      cleanupErrors.push(`删除演练目录失败：${(err as Error).message}`);
    }
  }

  return {
    pass: false,
    exitCode: 1,
    reportPath: ctx.reportPath,
    failedStage: stage,
    checks: null,
    message: cleanupErrors.length === 0
      ? message
      : `${message}（另有：${cleanupErrors.join("；")}）`,
  };
}

/** 清理演练 Compose 资源（`down -v --remove-orphans`）。 */
async function downDrillStack(
  ctx: DrillContext,
  runner: CommandRunner,
  dockerBin: string,
): Promise<number> {
  const overrideExists = await isFile(ctx.overrideFile);
  const res = await runner.run(
    dockerBin,
    drillCleanupArgs({
      projectName: ctx.projectName,
      composeEnvFile: ctx.composeEnvFile,
      composeFile: ctx.composeFile,
      overrideFile: overrideExists ? ctx.overrideFile : undefined,
    }),
  );
  return res.code;
}

/** 删演练目录（失败静默——调用方按需记入诊断）。 */
async function removeQuietly(path: string): Promise<void> {
  await Deno.remove(path, { recursive: true });
}

/** 清理解包暂存（前置失败路径用；演练目录由 cleanup 逻辑统一处理）。 */
async function cleanupStaging(dir: string, keep: boolean): Promise<void> {
  if (keep) return;
  await Deno.remove(dir, { recursive: true }).catch(() => {});
}

/** 读文本，失败返回兜底值。 */
async function readTextOr(path: string, fallback: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return fallback;
  }
}

/** 取文本末尾 N 行（bash `tail -n 50` 的等价）。 */
export function tailLines(text: string, n: number): string {
  const lines = text.replace(/\n+$/, "").split("\n");
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

/** 供测试断言指标名契约（避免测试重复字面量）。 */
export { METRIC_LAST_SUCCESS, REPORT_FILE_NAME };
