/**
 * noj-core 真实 PostgreSQL 测试启动器。
 *
 * 所有正式测试入口（全量、domain、shared、parallel、pg、smoke、perf、watch）
 * 都从这里取得隔离资源。启动器不读取 `.env`，也不会把现有
 * `DATABASE_URL` / `REDIS_URL` 当作测试依赖：调用方必须显式提供
 * `TEST_PG_ADMIN_URL`、`TEST_REDIS_URL`、`TEST_STORAGE_ROOT` 和足够强的
 * `JWT_SECRET`。
 * `TEST_REDIS_URL` 是模板迁移/显式 seed 使用的 bootstrap endpoint；child 测试
 * 流量使用启动器创建的独立 Redis 容器。
 *
 * 每次运行创建：
 * 1. 唯一前缀的空 PostgreSQL 模板库；
 * 2. 在模板库上执行正式迁移与显式测试种子；
 * 3. 每个分片从模板克隆的独立数据库；
 * 4. 每个 run/shard 一个带 owner label 的临时 Redis 容器；
 * 5. 位于 TEST_STORAGE_ROOT 下、只由本 run 创建的存储目录。
 *
 * 并行运行（P5）：
 * - `--shards N` 把**全部**发现的测试文件划分成 N 片（默认 4）；
 * - `--jobs M` 同时运行最多 M 片（默认 2）；
 * - 同一分片内串行，不向 child 传 `--parallel`；
 * - 分片计划在执行前写入报告目录，便于复核"哪些文件跑了、为什么这样分"。
 *
 * finally 只清理带有本 run 前缀的数据库、并且由本 run 创建且标签匹配的 Redis 容器，
 * 以及本 run 自己创建的存储目录。数据库迁移和 seed 的实现由测试 helper
 * 显式提供，生产连接模块不再包含测试后端。
 */
import postgres from "postgres";
import { sql } from "drizzle-orm";
import {
  applyShardEnvironment,
  existingTestPaths,
  type LauncherOptions,
  type LaunchMode,
  parseLauncherArgs,
  pathsFor,
  profileEnvironment,
  resolveReportDirectory,
} from "./test-launcher-args.ts";
import {
  assertBootstrapObservation,
  assertDatabaseIdentifier,
  createRunPlan,
  createRunStorageRoot,
  databaseUrlFor,
  isOwnedDatabaseName,
  isOwnedStorageRoot,
  makeChildEnvironment,
  readTestEnvironment,
  type RunPlan,
  shardDatabaseName,
  type TestEnvironment,
} from "./test-launcher-resources.ts";
import {
  acquireRedisLease,
  checkTestRedis,
  redisDisplay,
  type RedisLease,
} from "./test-launcher-redis.ts";
import {
  auditShardPlan,
  buildShardPlan,
  discoverTestFiles,
  type FileDurationBaseline,
  loadFileDurationBaseline,
  type Shard,
  type ShardPlan,
} from "./test-parallel-shards.ts";
import { measurePhase } from "../../scripts/lib/test-timing.ts";
import type { TestRunManifest } from "../../scripts/test-performance-report.ts";
import { unwrapRows } from "../src/shared/base/sql-rows.ts";

export {
  applyShardEnvironment,
  parseLauncherArgs,
  pathsFor,
  profileEnvironment,
  reportDirectory,
  resolveReportDirectory,
} from "./test-launcher-args.ts";
export type { LauncherOptions, LaunchMode } from "./test-launcher-args.ts";
export {
  assertBootstrapObservation,
  assertDatabaseIdentifier,
  createRunPlan,
  createRunStorageRoot,
  databaseUrlFor,
  isOwnedDatabaseName,
  isOwnedStorageRoot,
  makeChildEnvironment,
  ownsRedisContainer,
  readTestEnvironment,
  redisContainerLabels,
  redisContainerRunArgs,
  shardDatabaseName,
} from "./test-launcher-resources.ts";
export type {
  BootstrapObservation,
  RedisContainerLabels,
  RunPlan,
  TestEnvironment,
} from "./test-launcher-resources.ts";

/** noj-core 模块根目录（报告与基线路径都以它为基准）。 */
const MODULE_ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

/** 文件级耗时基线路径：仓库内唯一事实源。 */
const DURATION_BASELINE_PATH =
  `${MODULE_ROOT}/../dev-docs/engineering/test-duration-baseline.json`;

/** dry-run 未提供 TEST_STORAGE_ROOT 时使用的展示路径（不创建）。 */
const DRY_RUN_STORAGE_ROOT = "/tmp/noj-core-test-runs";

/** dry-run 使用的固定 runId，保证同一提交多次输出一致。 */
const DRY_RUN_ID = "dry_run_plan";

interface TestRunResources {
  environment: TestEnvironment;
  plan: RunPlan;
  admin: ReturnType<typeof postgres>;
  createdDatabases: string[];
  leases: RedisLease[];
  runRootCreated: boolean;
}

/** 单个分片在本次 run 中的实际资源。 */
interface ShardRuntime {
  shard: Shard;
  databaseName: string;
  databaseUrl: string;
  redis: RedisLease;
  storageDir: string;
}

/** dry-run 输出的资源计划（不含真实创建动作）。 */
export interface DryRunResourcePlan {
  runId: string;
  prefix: string;
  templateDatabase: string;
  storageRoot: string;
  timingDirectory?: string;
  shards: {
    name: string;
    databaseName: string;
    storageDir: string;
    redisLabels: Record<string, string>;
  }[];
}

async function createDatabase(
  admin: ReturnType<typeof postgres>,
  name: string,
  template?: string,
): Promise<void> {
  assertDatabaseIdentifier(name);
  if (template) {
    assertDatabaseIdentifier(template);
    await admin.unsafe(`CREATE DATABASE "${name}" WITH TEMPLATE "${template}"`);
  } else {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  }
}

async function dropOwnedDatabases(
  admin: ReturnType<typeof postgres>,
  names: string[],
  prefix: string,
): Promise<void> {
  const failures: unknown[] = [];
  for (const name of [...names].reverse()) {
    if (!isOwnedDatabaseName(name, prefix)) continue;
    assertDatabaseIdentifier(name);
    // PostgreSQL 16 支持 WITH (FORCE)，可清理异常退出留下的连接；目标名
    // 已经通过本 run 前缀校验，不可能指向开发/生产数据库。
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } catch (error) {
      failures.push(
        new Error(`清理测试数据库 ${name} 失败：${String(error)}`, {
          cause: error,
        }),
      );
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "测试数据库清理失败");
  }
}

async function withLauncherEnvironment<T>(
  values: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Deno.env.get(key));
    Deno.env.set(key, value);
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

function childEnvironment(
  resources: TestRunResources,
  databaseName: string,
  databaseUrl: string,
  redisUrl: string,
  storageDir: string,
  mode: LaunchMode,
  runPerf = mode === "perf",
  shardName = "single",
): Record<string, string> {
  const env = makeChildEnvironment(
    Deno.env.toObject(),
    resources.environment,
    resources.plan,
    databaseName,
    databaseUrl,
    redisUrl,
    storageDir,
    mode,
    runPerf,
  );
  return applyShardEnvironment(env, shardName);
}

async function bootstrapTemplate(
  resources: TestRunResources,
  databaseName: string,
  databaseUrl: string,
  redisUrl: string,
  storageDir: string,
): Promise<void> {
  const env = childEnvironment(
    resources,
    databaseName,
    databaseUrl,
    redisUrl,
    storageDir,
    "test",
  );
  await withLauncherEnvironment(env, async () => {
    // 迁移与 seed 的唯一显式入口。该 helper 内部调用正式 Drizzle migrator，
    // 再调用 root/RBAC/workspace/image seed；它不使用手写测试 DDL。
    const helper = await import("../tests/helpers/db.ts");
    const connection = await import("../src/shared/db/connection.ts");
    const migrations = await import("../src/shared/db/migrate.ts");
    let operationError: unknown;
    try {
      // `setupSchemaForTest()` 的实现就是 assertOwnedTestDatabase + 正式迁移 +
      // 显式 seed。这里拆成两个阶段只为可归因计时（P0/P5），语义完全一致；
      // helper 若调整 bootstrap 组成，必须同步这里。
      await measurePhase("core.launcher.template-migration", async () => {
        await helper.assertOwnedTestDatabase();
        await migrations.runMigrations();
      });
      await measurePhase(
        "core.launcher.template-seed",
        () => helper.seedTestDatabase(),
      );
      const result = await connection.getDb().execute(
        sql`SELECT current_database() AS current_database,
          to_regclass('users') AS users_table`,
      );
      const rows = unwrapRows<{
        current_database: string;
        users_table: string | null;
      }>(result as never);
      const row = rows[0];
      assertBootstrapObservation({
        currentDatabase: String(row?.current_database ?? ""),
        usersTable: row?.users_table ?? null,
      }, databaseName);
    } catch (error) {
      operationError = error;
    }
    let closeError: unknown;
    try {
      await connection.closeDbForShutdown();
    } catch (error) {
      closeError = error;
    }
    if (operationError !== undefined && closeError !== undefined) {
      throw new AggregateError(
        [operationError, closeError],
        "模板库迁移/seed 失败且数据库连接清理失败",
      );
    }
    if (operationError !== undefined) throw operationError;
    if (closeError !== undefined) {
      throw new Error(`模板库数据库连接关闭失败：${String(closeError)}`, {
        cause: closeError,
      });
    }
  });
}

async function prepareResources(
  environment: TestEnvironment,
  plan: RunPlan,
): Promise<TestRunResources> {
  const resources: TestRunResources = {
    environment,
    plan,
    admin: postgres(environment.pgAdminUrl, { max: 1 }),
    createdDatabases: [],
    leases: [],
    runRootCreated: false,
  };
  try {
    await createRunStorageRoot(plan);
    resources.runRootCreated = true;
    await createDatabase(resources.admin, plan.templateDatabase);
    resources.createdDatabases.push(plan.templateDatabase);

    // TEST_REDIS_URL 是模板迁移和显式 seed 实际使用的 bootstrap endpoint；
    // child 分片随后各自取得专用 Redis 容器，不会对这个 endpoint 做 FLUSHDB。
    await measurePhase(
      "core.launcher.bootstrap-redis-check",
      () => checkTestRedis(environment.redisUrl),
    );
    await Deno.mkdir(`${plan.storageRoot}/bootstrap-storage`, {
      recursive: true,
    });
    await bootstrapTemplate(
      resources,
      plan.templateDatabase,
      databaseUrlFor(environment.pgAdminUrl, plan.templateDatabase),
      environment.redisUrl,
      `${plan.storageRoot}/bootstrap-storage`,
    );
    return resources;
  } catch (error) {
    try {
      await measurePhase(
        "core.launcher.cleanup",
        () => cleanupResources(resources),
      );
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "测试资源初始化失败且清理未完全成功",
      );
    }
    throw error;
  }
}

async function cloneShard(
  resources: TestRunResources,
  shard: Shard,
): Promise<ShardRuntime> {
  const databaseName = shardDatabaseName(resources.plan, shard.name);
  await measurePhase(
    "core.launcher.db-clone",
    () =>
      createDatabase(
        resources.admin,
        databaseName,
        resources.plan.templateDatabase,
      ),
    { caseName: `shard:${shard.name}` },
  );
  resources.createdDatabases.push(databaseName);
  const redis = await measurePhase(
    "core.launcher.redis-acquire",
    () => acquireRedisLease(resources.plan, shard.name),
    { caseName: `shard:${shard.name}` },
  );
  resources.leases.push(redis);
  const storageDir = `${resources.plan.storageRoot}/${shard.name}`;
  await Deno.mkdir(storageDir, { recursive: true });
  return {
    shard,
    databaseName,
    databaseUrl: databaseUrlFor(resources.environment.pgAdminUrl, databaseName),
    redis,
    storageDir,
  };
}

async function runDenoTests(
  resources: TestRunResources,
  databaseName: string,
  databaseUrl: string,
  redisUrl: string,
  storageDir: string,
  mode: LaunchMode,
  paths: string[],
  testArgs: string[],
  runPerf = mode === "perf",
  shardName = "single",
  reportDir?: string,
): Promise<number> {
  const env = childEnvironment(
    resources,
    databaseName,
    databaseUrl,
    redisUrl,
    storageDir,
    mode,
    runPerf,
    shardName,
  );
  const args = [
    "test",
    "-A",
    "--no-check",
    "--preload=tests/preload.ts",
    // 每个 child 写自己的 JUnit：P0 报告按 shard 汇总通过/失败/跳过数量。
    ...(reportDir
      ? [`--junit-path=${junitPathFor(reportDir, shardName)}`]
      : []),
    ...(mode === "watch" ? ["--watch"] : []),
    ...paths,
    ...testArgs,
  ];
  console.log(
    `[test-launcher] ${mode} shard=${shardName} database=${databaseName} redis=${
      redisDisplay(redisUrl)
    } storage=${storageDir} files=${paths.length}`,
  );
  const child = new Deno.Command("deno", {
    args,
    env,
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const status = await child.status;
  return status.success ? 0 : status.code || 1;
}

async function cleanupResources(resources: TestRunResources): Promise<void> {
  const failures: unknown[] = [];
  for (const lease of [...resources.leases].reverse()) {
    try {
      await lease.release();
    } catch (error) {
      failures.push(
        new Error(
          `清理 Redis 容器 ${lease.containerId}（${
            redisDisplay(lease.url)
          }）失败：${String(error)}`,
          { cause: error },
        ),
      );
    }
  }
  resources.leases = [];
  try {
    await dropOwnedDatabases(
      resources.admin,
      resources.createdDatabases,
      resources.plan.prefix,
    );
  } catch (error) {
    failures.push(error);
  }
  resources.createdDatabases = [];
  try {
    await resources.admin.end();
  } catch (error) {
    failures.push(
      new Error(`测试 admin 连接关闭失败：${String(error)}`, { cause: error }),
    );
  }
  if (resources.runRootCreated) {
    const root = resources.plan.storageRoot;
    if (isOwnedStorageRoot(root, resources.plan.prefix)) {
      try {
        await Deno.remove(root, { recursive: true });
      } catch (error) {
        failures.push(
          new Error(`清理测试存储目录 ${root} 失败：${String(error)}`, {
            cause: error,
          }),
        );
      }
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "测试资源清理失败");
  }
}

/**
 * 把 `--profile` 转成 P0 计时环境变量；child 会继承这些变量写各自的 JSONL。
 *
 * @returns 计时/报告目录；未开启 profile 时仍返回报告目录（分片计划要落盘）
 */
function activateReporting(options: LauncherOptions, runId: string): string {
  const baseEnvironment = Deno.env.toObject();
  for (
    const [key, value] of Object.entries(profileEnvironment(
      options,
      runId,
      baseEnvironment,
    ))
  ) {
    Deno.env.set(key, value);
  }
  // 报告目录与 `--profile` 无关：manifest 与分片计划始终落盘。
  return resolveReportDirectory(runId, baseEnvironment);
}

/**
 * 读取文件耗时基线，并核对基线里的每个文件仍然存在。
 *
 * 2026-11-04 评审：原实现把读取失败降级为"全部按中位数估值"，又从不校验条目
 * 指向的文件是否还在——已删除的测试会在基线里长期占位，分片计划看起来有依据，
 * 实际用的是假数据。这里两者都直接失败，缺失路径一次列全。
 */
async function loadBaseline(): Promise<FileDurationBaseline> {
  const baseline = await loadFileDurationBaseline(DURATION_BASELINE_PATH);
  const missing = Object.keys(baseline.files).filter((file) => {
    try {
      return !Deno.statSync(`${MODULE_ROOT}/${file}`).isFile;
    } catch {
      return true;
    }
  });
  if (missing.length > 0) {
    throw new Error(
      `测试耗时基线包含 ${missing.length} 个不存在的测试文件（请同步更新 ${DURATION_BASELINE_PATH}）：${
        missing.join(", ")
      }`,
    );
  }
  return baseline;
}

/** 发现并规划分片；任何覆盖缺口都直接失败，不允许"少跑但显示绿"。 */
async function createShardPlan(options: LauncherOptions): Promise<ShardPlan> {
  const discovery = await measurePhase(
    "core.launcher.discover",
    () => discoverTestFiles(MODULE_ROOT),
  );
  if (discovery.files.length === 0) {
    throw new Error("分片发现没有找到任何测试文件，拒绝假绿");
  }
  if (discovery.missingRoots.length > 0) {
    console.warn(
      `[test-launcher] 元数据登记但尚不存在的测试根（已跳过，不代表已验收）：${
        discovery.missingRoots.join(", ")
      }`,
    );
  }
  const baseline = await measurePhase(
    "core.launcher.baseline",
    () => loadBaseline(),
  );
  const plan = await measurePhase(
    "core.launcher.plan",
    () =>
      Promise.resolve(
        buildShardPlan(
          discovery.files,
          discovery.excluded,
          options.shardCount,
          options.jobs,
          baseline,
        ),
      ),
  );
  const problems = auditShardPlan(plan);
  if (problems.length > 0) {
    throw new Error(`分片计划不完整：\n${problems.join("\n")}`);
  }
  return plan;
}

/** 分片计划的资源视图：dry-run 输出与真实执行共用同一套命名规则。 */
function dryRunResourcePlan(
  plan: RunPlan,
  shardPlan: ShardPlan,
  timingDirectory: string,
): DryRunResourcePlan {
  return {
    runId: plan.runId,
    prefix: plan.prefix,
    templateDatabase: plan.templateDatabase,
    storageRoot: plan.storageRoot,
    timingDirectory,
    shards: shardPlan.shards.map((shard) => ({
      name: shard.name,
      databaseName: shardDatabaseName(plan, shard.name),
      storageDir: `${plan.storageRoot}/${shard.name}`,
      redisLabels: {
        owner: plan.prefix,
        name: shard.name,
        "created-by": "test-launcher",
      },
    })),
  };
}

/** 运行清单输入（P0 `TestRunManifest` 的项目内构造入参）。 */
export interface ManifestInput {
  runId: string;
  /** 运行入口：core / domain:<name> / shared / smoke / parallel。 */
  suite: string;
  /** 完整命令行（含 launcher 参数）。 */
  command: string[];
  /** `git rev-parse HEAD`；失败时不写该字段。 */
  commit?: string;
  denoVersion: string;
  runner: { os: string; arch: string; ci: boolean };
  concurrency: { shards: number; jobs: number; filter?: string };
  startedAt: number;
  endedAt: number;
  /** 发现的全部测试文件（含被排除的 perf）。 */
  discovered: string[];
  /** 进入分片计划的文件。 */
  selected: string[];
  /** 实际启动过 child 的文件并集。 */
  executed: string[];
  /** 实际存在的 JUnit XML 路径。 */
  junit: string[];
  exitCode: number;
}

/**
 * 构造 P0 运行清单（纯函数，便于零依赖测试）。
 *
 * 字段与 `scripts/test-performance-report.ts` 的 `TestRunManifest` 对齐：
 * 报告据此区分"测试变少""单用例变快""并行度增加"。`canary` 由 P1-B 的 Judge
 * 探测填写，Core 启动器固定为 null。
 */
export function buildManifest(input: ManifestInput): TestRunManifest {
  const uniqueSorted = (values: readonly string[]) =>
    [...new Set(values)].sort();
  return {
    version: 1,
    runId: input.runId,
    suite: input.suite,
    command: input.command.join(" "),
    ...(input.commit ? { commit: input.commit } : {}),
    denoVersion: input.denoVersion,
    runner: input.runner,
    concurrency: input.concurrency,
    startedAt: new Date(input.startedAt).toISOString(),
    endedAt: new Date(input.endedAt).toISOString(),
    durationMs: Math.max(0, Math.round(input.endedAt - input.startedAt)),
    discovered: uniqueSorted(input.discovered),
    selected: uniqueSorted(input.selected),
    executed: uniqueSorted(input.executed),
    junit: uniqueSorted(input.junit),
    canary: null,
    exitCode: input.exitCode,
  };
}

/** 读取当前提交；不在 git 工作区时不写 commit 字段，而不是伪造值。 */
async function readCommit(): Promise<string | undefined> {
  try {
    const result = await new Deno.Command("git", {
      args: ["-C", MODULE_ROOT, "rev-parse", "HEAD"],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!result.success) return undefined;
    const commit = new TextDecoder().decode(result.stdout).trim();
    return commit.length > 0 ? commit : undefined;
  } catch {
    return undefined;
  }
}

/** 某个分片/入口的 JUnit 输出路径。 */
export function junitPathFor(reportDir: string, shardName: string): string {
  return `${reportDir}/junit-${shardName}.xml`;
}

/**
 * 写运行清单；报告是诊断能力，写失败只告警，不能掩盖真实测试结果。
 *
 * @returns 写入路径；失败时返回 undefined
 */
async function writeManifest(
  reportDir: string,
  input: ManifestInput,
): Promise<string | undefined> {
  const path = `${reportDir}/manifest.json`;
  try {
    await Deno.mkdir(reportDir, { recursive: true });
    const manifest = buildManifest({
      ...input,
      commit: input.commit ?? await readCommit(),
    });
    await Deno.writeTextFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`[test-launcher] 运行清单已写入：${path}`);
    return path;
  } catch (error) {
    console.warn(
      `[test-launcher] 运行清单写入失败（不影响测试结果）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

/** 把分片计划写到报告目录；必须发生在任何 child 启动之前。 */
async function writeShardPlan(
  directory: string,
  plan: ShardPlan,
  options: LauncherOptions,
  resources: DryRunResourcePlan,
): Promise<string> {
  await Deno.mkdir(directory, { recursive: true });
  const path = `${directory}/shard-plan.json`;
  const payload = {
    version: 1,
    mode: options.mode,
    generatedAt: new Date().toISOString(),
    shardCount: plan.shardCount,
    jobs: Math.min(plan.jobs, plan.shards.length),
    profile: options.profile,
    selectedFiles: plan.selectedFiles,
    excludedFiles: plan.excludedFiles,
    baseline: plan.baseline,
    shards: plan.shards,
    resources,
  };
  await Deno.writeTextFile(path, `${JSON.stringify(payload, null, 2)}\n`);
  return path;
}

/** 并发执行分片的产出：退出码 + 实际启动过的文件 + 实际生成的 JUnit。 */
export interface ShardRunOutcome {
  exitCode: number;
  executedFiles: string[];
  junitFiles: string[];
}

/** 过滤出真实存在的 JUnit 文件，避免清单指向未生成的报告。 */
async function existingJunitFiles(
  reportDir: string,
  shardNames: readonly string[],
): Promise<string[]> {
  const paths: string[] = [];
  for (const name of shardNames) {
    const path = junitPathFor(reportDir, name);
    try {
      const info = await Deno.stat(path);
      if (info.isFile) paths.push(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return paths.sort();
}

/** 并发执行分片：最多 `limit` 个 child 同时运行，片内串行。 */
async function runShardsWithConcurrency(
  resources: TestRunResources,
  plan: ShardPlan,
  options: LauncherOptions,
  reportDir: string,
): Promise<ShardRunOutcome> {
  const limit = Math.max(1, Math.min(options.jobs, plan.shards.length));
  const statuses: number[] = new Array(plan.shards.length).fill(1);
  const executed: string[] = [];
  const launched: string[] = [];
  let nextIndex = 0;

  const runOne = async (index: number): Promise<void> => {
    const shard = plan.shards[index]!;
    try {
      const runtime = await cloneShard(resources, shard);
      // 资源就绪即视为该分片已进入执行：child 失败也必须记入 executed。
      executed.push(...shard.files);
      launched.push(shard.name);
      statuses[index] = await measurePhase(
        "core.launcher.child",
        () =>
          runDenoTests(
            resources,
            runtime.databaseName,
            runtime.databaseUrl,
            runtime.redis.url,
            runtime.storageDir,
            "parallel",
            shard.files,
            options.testArgs,
            false,
            shard.name,
            reportDir,
          ),
        { caseName: `shard:${shard.name}`, count: shard.files.length },
      );
    } catch (error) {
      // 单个分片的资源/启动错误只影响该分片；其余分片继续跑完，整体退出码非零。
      console.error(
        `[test-launcher] 分片 ${shard.name} 失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      statuses[index] = 1;
    }
  };

  const workers = Array.from(
    { length: Math.min(limit, plan.shards.length) },
    async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= plan.shards.length) return;
        await runOne(index);
      }
    },
  );
  await Promise.all(workers);
  return {
    exitCode: statuses.some((status) => status !== 0) ? 1 : 0,
    executedFiles: executed,
    junitFiles: await existingJunitFiles(reportDir, launched),
  };
}

/** 从透传参数里取出 `--filter`，写入清单的并发段。 */
function filterFromTestArgs(testArgs: readonly string[]): string | undefined {
  for (let index = 0; index < testArgs.length; index += 1) {
    const arg = testArgs[index]!;
    if (arg === "--filter") return testArgs[index + 1];
    if (arg.startsWith("--filter=")) return arg.slice("--filter=".length);
  }
  return undefined;
}

/** 启动器自身的完整命令行，写进 manifest 便于复核。 */
function launcherCommand(rawArgs: readonly string[]): string[] {
  return ["deno", "run", "-A", "scripts/test-launcher.ts", ...rawArgs];
}

function runnerInfo(): { os: string; arch: string; ci: boolean } {
  return {
    os: Deno.build.os,
    arch: Deno.build.arch,
    ci: Boolean(Deno.env.get("CI")),
  };
}

async function runParallel(
  options: LauncherOptions,
  environment: TestEnvironment,
  plan: RunPlan,
  reportDir: string,
  rawArgs: readonly string[],
): Promise<number> {
  // 清单的 startedAt/endedAt 是 wall clock（报告按时间排序），
  // durationMs 由两者相减；分片内部耗时仍用 measurePhase（performance.now）。
  const startedAt = Date.now();
  const shardPlan = await createShardPlan(options);
  let resources: TestRunResources | undefined;
  let exitCode = 0;
  let failure: unknown;
  let executedFiles: string[] = [];
  let junitFiles: string[] = [];
  try {
    resources = await prepareResources(environment, plan);
    const resourceView = dryRunResourcePlan(plan, shardPlan, reportDir);
    const planPath = await writeShardPlan(
      reportDir,
      shardPlan,
      options,
      resourceView,
    );
    console.log(
      `[test-launcher] 分片计划已保存：${planPath}（文件 ${shardPlan.selectedFiles.length} 个，排除 perf ${shardPlan.excludedFiles.length} 个，并发 ${
        Math.min(options.jobs, shardPlan.shards.length)
      }）`,
    );
    const outcome = await runShardsWithConcurrency(
      resources,
      shardPlan,
      options,
      reportDir,
    );
    exitCode = outcome.exitCode;
    executedFiles = outcome.executedFiles;
    junitFiles = outcome.junitFiles;
  } catch (error) {
    failure = error;
    exitCode = 1;
  }

  // 运行清单先于资源清理写出：即使测试失败、清理也失败，报告仍可归因。
  await writeManifest(reportDir, {
    runId: plan.runId,
    suite: "core",
    command: launcherCommand(rawArgs),
    denoVersion: Deno.version.deno,
    runner: runnerInfo(),
    concurrency: {
      shards: shardPlan.shardCount,
      jobs: Math.min(options.jobs, shardPlan.shards.length),
      ...(filterFromTestArgs(options.testArgs)
        ? { filter: filterFromTestArgs(options.testArgs)! }
        : {}),
    },
    startedAt,
    endedAt: Date.now(),
    discovered: [...shardPlan.selectedFiles, ...shardPlan.excludedFiles],
    selected: shardPlan.selectedFiles,
    executed: executedFiles,
    junit: junitFiles,
    exitCode,
  });

  if (resources) {
    try {
      await measurePhase(
        "core.launcher.cleanup",
        () => cleanupResources(resources!),
      );
    } catch (cleanupError) {
      if (failure !== undefined) {
        throw new AggregateError(
          [failure, cleanupError],
          "并行测试失败且资源清理未完全成功",
        );
      }
      throw cleanupError;
    }
  }
  if (failure !== undefined) throw failure;
  return exitCode;
}

async function runSingle(
  options: LauncherOptions,
  environment: TestEnvironment,
  plan: RunPlan,
  reportDir: string,
  rawArgs: readonly string[],
): Promise<number> {
  const startedAt = Date.now();
  const requestedPaths = pathsFor(options);
  let resources: TestRunResources | undefined;
  let exitCode = 0;
  let failure: unknown;
  let executed: string[] = [];
  let junitFiles: string[] = [];
  const suite = options.mode === "domain" && options.domain
    ? `domain:${options.domain}`
    : options.mode;
  try {
    resources = await prepareResources(environment, plan);
    const runtime = await cloneShard(resources, {
      name: "single",
      files: requestedPaths,
      estimatedMs: 0,
    });
    const paths = await existingTestPaths(requestedPaths);
    executed = paths;
    exitCode = await measurePhase(
      "core.launcher.child",
      () =>
        runDenoTests(
          resources!,
          runtime.databaseName,
          runtime.databaseUrl,
          runtime.redis.url,
          runtime.storageDir,
          options.mode,
          paths,
          options.testArgs,
          options.runPerf,
          "single",
          reportDir,
        ),
      { caseName: "single", count: paths.length },
    );
    junitFiles = await existingJunitFiles(reportDir, ["single"]);
  } catch (error) {
    failure = error;
    exitCode = 1;
  }

  await writeManifest(reportDir, {
    runId: plan.runId,
    suite,
    command: launcherCommand(rawArgs),
    denoVersion: Deno.version.deno,
    runner: runnerInfo(),
    concurrency: {
      shards: 1,
      jobs: 1,
      ...(filterFromTestArgs(options.testArgs)
        ? { filter: filterFromTestArgs(options.testArgs)! }
        : {}),
    },
    startedAt,
    endedAt: Date.now(),
    discovered: requestedPaths,
    selected: requestedPaths,
    executed,
    junit: junitFiles,
    exitCode,
  });

  if (resources) {
    try {
      await measurePhase(
        "core.launcher.cleanup",
        () => cleanupResources(resources!),
      );
    } catch (cleanupError) {
      if (failure !== undefined) {
        throw new AggregateError(
          [failure, cleanupError],
          "测试失败且资源清理未完全成功",
        );
      }
      throw cleanupError;
    }
  }
  if (failure !== undefined) throw failure;
  return exitCode;
}

async function runDryRun(options: LauncherOptions): Promise<number> {
  const storageRoot = Deno.env.get("TEST_STORAGE_ROOT")?.trim() ||
    DRY_RUN_STORAGE_ROOT;
  // dry-run 必须与实际运行环境解耦：child 进程继承的 NOJ_TEST_RUN_ID 若参与
  // 计划生成，会破坏"同一提交多次输出一致"的比对前提，也会让 dry-run 测试在
  // 正式运行中变成另一种选择。固定 runId 只用于展示资源计划。
  const plan = createRunPlan(storageRoot, DRY_RUN_ID);
  const reportDir = resolveReportDirectory(plan.runId);
  if (options.mode !== "parallel") {
    const requestedPaths = pathsFor(options);
    const paths = await existingTestPaths(requestedPaths);
    console.log(JSON.stringify(
      {
        dryRun: true,
        mode: options.mode,
        paths,
        shardCount: 1,
        jobs: 1,
        profile: options.profile,
        resources: dryRunResourcePlan(
          plan,
          {
            shardCount: 1,
            jobs: 1,
            selectedFiles: paths,
            excludedFiles: [],
            shards: [{ name: "single", files: paths, estimatedMs: 0 }],
            baseline: {
              source: "not-required-for-single",
              generatedAt: new Date(0).toISOString(),
              knownFiles: 0,
              unknownMs: 0,
            },
          },
          reportDir,
        ),
        wouldWrite: `${reportDir}/shard-plan.json`,
      },
      null,
      2,
    ));
    return 0;
  }
  const shardPlan = await createShardPlan(options);
  const resourcePlan = dryRunResourcePlan(plan, shardPlan, reportDir);
  console.log(JSON.stringify(
    {
      dryRun: true,
      mode: options.mode,
      shardCount: shardPlan.shardCount,
      jobs: Math.min(options.jobs, shardPlan.shards.length),
      profile: options.profile,
      selectedFiles: shardPlan.selectedFiles.length,
      excludedFiles: shardPlan.excludedFiles,
      baseline: shardPlan.baseline,
      shards: shardPlan.shards.map((shard) => ({
        name: shard.name,
        files: shard.files.length,
        estimatedMs: shard.estimatedMs,
        filesList: shard.files,
      })),
      resources: resourcePlan,
      wouldWrite: `${reportDir}/shard-plan.json`,
    },
    null,
    2,
  ));
  return 0;
}

async function run(
  options: LauncherOptions,
  rawArgs: readonly string[],
): Promise<number> {
  if (options.dryRun) return await runDryRun(options);

  const environment = readTestEnvironment();
  // 调用方（scripts/test-baseline.ts）可指定 runId；未指定时由启动器生成。
  const requestedRunId = Deno.env.get("NOJ_TEST_RUN_ID")?.trim();
  const plan = createRunPlan(
    environment.storageRoot,
    requestedRunId || undefined,
  );
  const reportDir = activateReporting(options, plan.runId);
  // JUnit 与 manifest 都写在这里；显式建目录，避免依赖 Deno 是否为
  // `--junit-path` 自动创建父目录。
  await Deno.mkdir(reportDir, { recursive: true });
  console.log(
    `[test-launcher] run=${plan.runId} prefix=${plan.prefix} ` +
      `admin=${
        new URL(environment.pgAdminUrl).hostname
      } mode=${options.mode} profile=${options.profile}`,
  );
  if (options.mode === "parallel") {
    return await runParallel(
      options,
      environment,
      plan,
      reportDir,
      rawArgs,
    );
  }
  return await runSingle(options, environment, plan, reportDir, rawArgs);
}

export async function main(args: string[] = Deno.args): Promise<number> {
  const options = parseLauncherArgs(args);
  return await run(options, args);
}

if (import.meta.main) {
  try {
    const code = await main();
    Deno.exit(code);
  } catch (error) {
    console.error(`[test-launcher] 失败：${String(error)}`);
    Deno.exit(1);
  }
}
