/**
 * 真实测试启动器的零依赖契约测试。
 *
 * 数据库/Redis 行为由 launcher 在隔离资源上验证；这里锁住发现、参数、命名
 * 和失败边界，防止测试入口重新退化为隐式 `.env`、固定 DB 或宽泛清理。
 */
import {
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
} from "../../scripts/test-launcher-resources.ts";
import { buildManifest, junitPathFor } from "../../scripts/test-launcher.ts";
import {
  applyShardEnvironment,
  existingTestPaths,
  parseLauncherArgs,
  parseSafeTestArgs,
  pathsFor,
  profileEnvironment,
  resolveReportDirectory,
  TEST_TARGET_NAMES,
} from "../../scripts/test-launcher-args.ts";
import {
  LEGACY_DOMAIN_NAMES,
  TARGET_MODULE_NAMES,
  testRootsForTarget,
} from "../../../scripts/module-test-metadata.ts";
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@^1";

Deno.test("test-launcher: 缺少隔离依赖时直接失败", () => {
  assertThrows(
    () => readTestEnvironment({}),
    Error,
    "TEST_PG_ADMIN_URL、TEST_REDIS_URL、TEST_STORAGE_ROOT、JWT_SECRET",
  );
});

Deno.test("test-launcher: 弱 JWT_SECRET 和相对存储路径被拒绝", () => {
  const base = {
    TEST_PG_ADMIN_URL: "postgres://postgres@127.0.0.1:5432/postgres",
    TEST_REDIS_URL: "redis://127.0.0.1:6379/0",
    TEST_STORAGE_ROOT: "/tmp/noj-tests",
    JWT_SECRET: "too-short",
  };
  assertThrows(() => readTestEnvironment(base), Error, "至少 32");
  assertThrows(
    () =>
      readTestEnvironment({
        ...base,
        JWT_SECRET: "x".repeat(32),
        TEST_PG_ADMIN_URL: "postgres://user@127.0.0.1:5432",
      }),
    Error,
    "admin 数据库名",
  );
  assertThrows(
    () =>
      readTestEnvironment({
        ...base,
        JWT_SECRET: "x".repeat(32),
        TEST_STORAGE_ROOT: "tmp",
      }),
    Error,
    "绝对路径",
  );
});

Deno.test("test-launcher: 测试资源只来自 TEST_*，不继承开发连接", () => {
  const environment = readTestEnvironment({
    TEST_PG_ADMIN_URL: "postgres://test-admin@127.0.0.1:5432/postgres",
    TEST_REDIS_URL: "redis://127.0.0.1:6379/0",
    TEST_STORAGE_ROOT: "/tmp/noj-tests",
    JWT_SECRET: "x".repeat(32),
    DATABASE_URL: "postgres://dev@127.0.0.1:5432/development",
    REDIS_URL: "redis://127.0.0.1:6379/9",
  });
  assertEquals(
    environment.pgAdminUrl,
    "postgres://test-admin@127.0.0.1:5432/postgres",
  );
  assertEquals(environment.redisUrl, "redis://127.0.0.1:6379/0");
});

Deno.test("test-launcher: mode/domain/shard 参数发现明确", () => {
  assertEquals(parseLauncherArgs([]).mode, "test");
  assertEquals(parseLauncherArgs(["domain", "identity"]).domain, "identity");
  assertEquals(
    parseLauncherArgs(["domain", "education", "--perf"]).runPerf,
    true,
  );
  assertEquals(parseLauncherArgs(["perf"]).runPerf, true);
  assertEquals(parseLauncherArgs(["parallel", "--shards", "1"]).shardCount, 1);
  assertThrows(
    () => parseLauncherArgs(["domain"]),
    Error,
    "必须指定有效模块或 legacy domain",
  );
  assertThrows(
    () => parseLauncherArgs(["domain", "unknown"]),
    Error,
    "必须指定有效模块或 legacy domain",
  );
  assertEquals(
    TARGET_MODULE_NAMES.length,
    12,
    "metadata 必须保留 12 个目标模块",
  );
  assertEquals(
    LEGACY_DOMAIN_NAMES.length,
    15,
    "metadata 必须保留 15 个 legacy domain 别名",
  );
  for (const target of TEST_TARGET_NAMES) {
    assertEquals(
      parseLauncherArgs(["domain", target]).domain,
      target,
      `模块和 legacy domain 都必须可作为正式入口：${target}`,
    );
  }
  assertThrows(
    () => parseLauncherArgs(["test", "--shards", "1"]),
    Error,
    "只适用于 parallel",
  );
  assertThrows(
    () => parseLauncherArgs(["test", "--parallel"]),
    Error,
    "拒绝 --parallel",
  );
  assertThrows(
    () => parseLauncherArgs(["parallel", "--parallel=4"]),
    Error,
    "拒绝 --parallel",
  );
  assertEquals(
    parseLauncherArgs([
      "test",
      "--filter",
      "Redis",
      "--fail-fast",
      "--reporter=dot",
      "--shuffle=42",
      "--trace-leaks",
    ]).testArgs,
    [
      "--filter",
      "Redis",
      "--fail-fast",
      "--reporter=dot",
      "--shuffle=42",
      "--trace-leaks",
    ],
  );
  for (
    const argument of [
      "--config=/tmp/other-deno.json",
      "--import-map",
      "--no-config",
      "--eval=process.exit(0)",
      "--allow-all",
      "--deny-net",
      "--jobs=1",
    ]
  ) {
    assertThrows(
      () => parseSafeTestArgs([argument]),
      Error,
      "不允许或不识别参数",
    );
  }
  assertThrows(
    () => parseSafeTestArgs(["--reporter=unknown"]),
    Error,
    "不支持 reporter",
  );
});

Deno.test("test-launcher: 目标模块只发现已迁移的测试根", () => {
  const targetRoots = testRootsForTarget("problems");
  assert(
    targetRoots.includes("src/modules/problems/tests") &&
      !targetRoots.some((root) => root.startsWith("src/domains/")) &&
      !targetRoots.some((root) => root.includes("legacy-")),
    "目标模块入口不得重新发现已删除的 legacy 测试根",
  );
});

Deno.test("test-launcher: 每次 run 的数据库名和 storage 根目录唯一可界定", () => {
  const first = createRunPlan("/tmp/noj-tests", "run_one");
  const second = createRunPlan("/tmp/noj-tests", "run_two");
  assert(first.prefix !== second.prefix);
  assert(first.storageRoot.startsWith("/tmp/noj-tests/"));
  assert(isOwnedStorageRoot(first.storageRoot, first.prefix));
  assert(!isOwnedStorageRoot(`${first.storageRoot}_leftover`, first.prefix));
  assertThrows(
    () => createRunPlan("/tmp/../var", "run_three"),
    Error,
    "不能包含",
  );
  assert(isOwnedDatabaseName(first.templateDatabase, first.prefix));
  assert(isOwnedDatabaseName(shardDatabaseName(first, "core"), first.prefix));
  assert(!isOwnedDatabaseName(`${first.prefix}x_core`, first.prefix));
  assertThrows(
    () => assertDatabaseIdentifier("bad;drop database"),
    Error,
    "非法",
  );
});

Deno.test("test-launcher: 不存在的父目录可创建且清理不越过 run 根", async () => {
  const base = await Deno.makeTempDir({ prefix: "noj-launcher-storage-" });
  const parent = `${base}/new-parent`;
  const plan = createRunPlan(parent, "run_storage_parent");
  try {
    await createRunStorageRoot(plan);
    assert((await Deno.stat(parent)).isDirectory);
    assert((await Deno.stat(plan.storageRoot)).isDirectory);
    await Deno.remove(plan.storageRoot, { recursive: true });
    assert((await Deno.stat(parent)).isDirectory);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("test-launcher: 预存在 run 根拒绝启动且不触碰原目录", async () => {
  const base = await Deno.makeTempDir({ prefix: "noj-launcher-storage-" });
  const plan = createRunPlan(`${base}/storage`, "run_storage_existing");
  try {
    await Deno.mkdir(plan.storageRoot, { recursive: true });
    const error = await assertRejects(
      () => createRunStorageRoot(plan),
      Error,
    );
    assert(
      error.name === "AlreadyExists" || error.message.includes("File exists"),
      `预存在 run 根应以 EEXIST 失败，实际为：${error.message}`,
    );
    assert((await Deno.stat(plan.storageRoot)).isDirectory);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("test-launcher: 数据库 URL 只替换已生成的数据库名", () => {
  const url = databaseUrlFor(
    "postgres://user:password@127.0.0.1:5432/postgres?sslmode=disable",
    "noj_test_run_single",
  );
  const parsed = new URL(url);
  assertEquals(parsed.pathname, "/noj_test_run_single");
  assertEquals(parsed.searchParams.get("sslmode"), "disable");
  assertThrows(
    () => databaseUrlFor("postgres://127.0.0.1/postgres", "x;drop"),
    Error,
    "非法",
  );
});

Deno.test("test-launcher: child 环境声明所有权且不继承 bypass/限流开关", () => {
  const plan = createRunPlan("/tmp/noj-tests", "run_env");
  const environment = readTestEnvironment({
    TEST_PG_ADMIN_URL: "postgres://test-admin@127.0.0.1:5432/postgres",
    TEST_REDIS_URL: "redis://127.0.0.1:6379/0",
    TEST_STORAGE_ROOT: "/tmp/noj-tests",
    JWT_SECRET: "x".repeat(32),
  });
  const child = makeChildEnvironment(
    {
      DATABASE_URL: "postgres://dev@127.0.0.1:5432/development",
      REDIS_URL: "redis://127.0.0.1:6379/9",
      NOJ_TEST_SCHEDULING_REDIS_URL: "redis://127.0.0.1:6379/10",
      RATE_LIMIT_ENABLED: "false",
      NOJ_BYPASS_JWT_REVOKE: "1",
      BCRYPT_SALT_ROUNDS: "4",
    },
    environment,
    plan,
    "noj_test_run_env_core",
    "postgres://test-admin@127.0.0.1:5432/noj_test_run_env_core",
    "redis://127.0.0.1:32770/0",
    "/tmp/noj-tests/run_env/core",
    "parallel",
  );
  assertEquals(child.NOJ_ENV, "test");
  assertEquals(
    child.DATABASE_URL,
    "postgres://test-admin@127.0.0.1:5432/noj_test_run_env_core",
  );
  assertEquals(child.REDIS_URL, "redis://127.0.0.1:32770/0");
  assertEquals(child.NOJ_TEST_SCHEDULING_REDIS_URL, undefined);
  assertEquals(child.NOJ_TEST_DATABASE_OWNED, "1");
  assertEquals(child.NOJ_TEST_DATABASE_PREFIX, plan.prefix);
  assertEquals(child.NOJ_TEST_DATABASE_NAME, "noj_test_run_env_core");
  assertEquals(child.RATE_LIMIT_ENABLED, undefined);
  assertEquals(child.NOJ_BYPASS_JWT_REVOKE, undefined);
});

Deno.test("test-launcher: Redis 容器 owner label 阻断跨 run 和跨 shard 清理", () => {
  const first = createRunPlan("/tmp/noj-tests", "run_one");
  const second = createRunPlan("/tmp/noj-tests", "run_two");
  const firstCore = redisContainerLabels(first, "core");
  assert(ownsRedisContainer(firstCore, first, "core"));
  assert(!ownsRedisContainer(firstCore, second, "core"));
  assert(!ownsRedisContainer(firstCore, first, "db"));
  assert(
    !ownsRedisContainer({ ...firstCore, createdBy: "other" }, first, "core"),
  );
});

Deno.test("test-launcher: 跨 run Redis 使用专用容器命令而非共享 FLUSHDB", () => {
  const first = createRunPlan("/tmp/noj-tests", "run_redis_a");
  const second = createRunPlan("/tmp/noj-tests", "run_redis_b");
  const firstArgs = redisContainerRunArgs(first, "core");
  const secondArgs = redisContainerRunArgs(second, "core");
  assertEquals(firstArgs[0], "run");
  assert(firstArgs.includes("--rm"));
  assert(firstArgs.includes("127.0.0.1::6379"));
  assert(firstArgs.includes("redis:7-alpine"));
  assert(!firstArgs.some((arg) => /flushdb/i.test(arg)));
  assert(!secondArgs.some((arg) => /flushdb/i.test(arg)));
  assert(firstArgs.join("\u0000") !== secondArgs.join("\u0000"));
  assert(
    firstArgs.includes(`com.noj.test.owner=${first.prefix}`) &&
      secondArgs.includes(`com.noj.test.owner=${second.prefix}`),
  );
});

Deno.test("test-launcher: 空库迁移负例和存量模板正例都可观测", () => {
  assertThrows(
    () =>
      assertBootstrapObservation({
        currentDatabase: "noj_test_run",
        usersTable: null,
      }, "noj_test_run"),
    Error,
    "不存在 users 表",
  );
  assertThrows(
    () =>
      assertBootstrapObservation({
        currentDatabase: "development",
        usersTable: "users",
      }, "noj_test_run"),
    Error,
    "连接错库",
  );
  assertBootstrapObservation({
    currentDatabase: "noj_test_run",
    usersTable: "users",
  }, "noj_test_run");
});

Deno.test("test-launcher: 缺失迁移根显式报告，全部缺失时拒绝假绿", async () => {
  const root = await Deno.makeTempDir({ prefix: "noj-launcher-paths-" });
  try {
    await Deno.writeTextFile(
      `${root}/present.test.ts`,
      'Deno.test("x", () => {});',
    );
    const paths = await existingTestPaths([
      `${root}/present.test.ts`,
      `${root}/future-module/tests`,
    ]);
    assertEquals(paths, [`${root}/present.test.ts`]);
    await assertRejects(
      () => existingTestPaths([`${root}/missing-module/tests`]),
      Error,
      "没有发现任何实际测试路径",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

const CORE_ROOT = new URL("../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

Deno.test("test-launcher: parallel 默认 4 片 2 并发，--jobs/--profile 可解析", () => {
  const defaults = parseLauncherArgs(["parallel"]);
  assertEquals(defaults.shardCount, 4);
  assertEquals(defaults.jobs, 2);
  assertEquals(defaults.profile, false);
  assertEquals(defaults.dryRun, false);
  const explicit = parseLauncherArgs([
    "parallel",
    "--shards",
    "2",
    "--jobs",
    "1",
    "--profile",
    "--dry-run",
  ]);
  assertEquals(explicit.shardCount, 2);
  assertEquals(explicit.jobs, 1);
  assertEquals(explicit.profile, true);
  assertEquals(explicit.dryRun, true);
});

Deno.test("test-launcher: --shards/--jobs 上限与入口限制必须失败", () => {
  assertThrows(
    () => parseLauncherArgs(["parallel", "--shards", "9"]),
    Error,
    "超过上限",
  );
  assertThrows(
    () => parseLauncherArgs(["parallel", "--jobs", "9"]),
    Error,
    "超过上限",
  );
  assertThrows(
    () => parseLauncherArgs(["parallel", "--jobs", "0"]),
    Error,
    "≥1 的整数",
  );
  assertThrows(
    () => parseLauncherArgs(["test", "--jobs", "2"]),
    Error,
    "只适用于 parallel",
  );
  assertThrows(
    () => parseLauncherArgs(["domain", "identity", "--shards", "2"]),
    Error,
    "只适用于 parallel",
  );
});

Deno.test("test-launcher: 显式测试文件路径必须与磁盘一致（防静默漏跑）", async () => {
  // 回归：shared 入口曾把 `types_safety_test.ts` / `defensive-patterns_test.ts`
  // 写成 `*.test.ts`，旧的 existingTestPaths 当成迁移期缺失跳过。
  const modes = [
    { mode: "shared" as const },
    { mode: "smoke" as const },
    { mode: "perf" as const },
    ...TEST_TARGET_NAMES.map((domain) => ({
      mode: "domain" as const,
      domain,
    })),
  ];
  for (const mode of modes) {
    const explicitFiles = pathsFor(mode).filter((path) => path.endsWith(".ts"));
    assert(explicitFiles.length > 0, `${mode.mode} 入口必须有显式测试文件`);
    for (const file of explicitFiles) {
      const info = await Deno.stat(`${CORE_ROOT}/${file}`);
      assert(info.isFile, `显式测试文件不存在：${file}`);
    }
  }
  assertEquals(
    pathsFor({ mode: "shared" }).filter((path) =>
      path.startsWith("tests/types_safety") ||
      path.startsWith("tests/defensive-patterns")
    ),
    ["tests/types_safety_test.ts", "tests/defensive-patterns_test.ts"],
    "shared 入口必须使用真实文件名",
  );
});

Deno.test("test-launcher: 缺失的显式测试文件直接失败，缺目录仅警告", async () => {
  const root = await Deno.makeTempDir({ prefix: "noj-launcher-missing-" });
  try {
    await Deno.writeTextFile(
      `${root}/present.test.ts`,
      'Deno.test("x", () => {});',
    );
    assertEquals(
      await existingTestPaths([
        `${root}/present.test.ts`,
        `${root}/future-module/tests`,
      ]),
      [`${root}/present.test.ts`],
    );
    await assertRejects(
      () => existingTestPaths([`${root}/types_safety.test.ts`]),
      Error,
      "显式引用的测试文件不存在",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("test-launcher: --profile 环境契约（默认不落盘）", () => {
  assertEquals(
    profileEnvironment({ profile: false }, "run_abc", {}),
    {},
    "不带 --profile 时不得注入任何计时变量",
  );
  const plain = profileEnvironment({ profile: true }, "run_abc", {});
  assertEquals(plain.NOJ_TEST_PROFILE, "1");
  assert(plain.NOJ_TEST_TIMING_DIR?.endsWith("performance/run_abc"));
  assertEquals(plain.NOJ_TEST_RUN_ID, "run_abc");
  assertEquals(plain.NOJ_TEST_SHARD, "launcher");

  // scripts/test-baseline.ts 会为每次重复测量指定自己的目录与 runId。
  const inherited = profileEnvironment({ profile: true }, "run_abc", {
    NOJ_TEST_TIMING_DIR: "/tmp/baseline-run-2",
    NOJ_TEST_RUN_ID: "baseline-123-2",
  });
  assertEquals(inherited.NOJ_TEST_TIMING_DIR, "/tmp/baseline-run-2");
  assertEquals(inherited.NOJ_TEST_RUN_ID, "baseline-123-2");
  assertEquals(inherited.NOJ_TEST_PROFILE, "1");
});

Deno.test("test-launcher: child 环境继承 profile 并覆盖分片名", () => {
  const env = {
    DATABASE_URL: "postgres://test@127.0.0.1:5432/db",
    NOJ_TEST_PROFILE: "1",
    NOJ_TEST_TIMING_DIR: "/tmp/timing",
    NOJ_TEST_RUN_ID: "run_abc",
    NOJ_TEST_SHARD: "launcher",
  };
  const shardEnv = applyShardEnvironment(env, "shard3");
  assertEquals(shardEnv.NOJ_TEST_SHARD, "shard3");
  assertEquals(shardEnv.NOJ_TEST_PROFILE, "1");
  assertEquals(shardEnv.NOJ_TEST_TIMING_DIR, "/tmp/timing");
  assertEquals(shardEnv.NOJ_TEST_RUN_ID, "run_abc");
  assertEquals(env.NOJ_TEST_SHARD, "launcher", "不得原地修改父环境");
});

Deno.test("test-launcher: --dry-run 无 TEST_* 变量也能输出完整计划", async () => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(Deno.env.toObject())) {
    if (
      key.startsWith("TEST_") || key === "JWT_SECRET" ||
      key === "DATABASE_URL" || key === "REDIS_URL"
    ) continue;
    env[key] = value;
  }
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "scripts/test-launcher.ts",
      "parallel",
      "--shards",
      "2",
      "--jobs",
      "1",
      "--dry-run",
    ],
    cwd: CORE_ROOT,
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  assertEquals(result.code, 0, `dry-run 失败：${stderr}`);
  const plan = JSON.parse(stdout) as {
    dryRun: boolean;
    shardCount: number;
    jobs: number;
    selectedFiles: number;
    shards: { name: string; files: number; filesList: string[] }[];
    resources: { templateDatabase: string; shards: { databaseName: string }[] };
    wouldWrite: string;
  };
  assertEquals(plan.dryRun, true);
  assertEquals(plan.shardCount, 2);
  assertEquals(plan.jobs, 1);
  assert(plan.selectedFiles > 400, "dry-run 必须发现全部 Core 测试文件");
  assertEquals(plan.shards.length, 2);
  assertEquals(plan.resources.shards.length, 2);
  for (const shard of plan.shards) {
    assertEquals(
      shard.filesList[0],
      "tests/00_migrate_test.ts",
      "迁移入口必须位于每个分片首位",
    );
    assertEquals(shard.files, shard.filesList.length);
  }
  assert(
    plan.resources.templateDatabase.includes("dry_run_plan"),
    "dry-run 资源计划必须使用固定 runId，便于比对",
  );
  assert(plan.wouldWrite.endsWith("shard-plan.json"));
});

Deno.test("test-launcher: 报告目录优先使用调用方的 NOJ_TEST_TIMING_DIR", () => {
  assertEquals(
    resolveReportDirectory("run_abc", {}),
    new URL("../../.test-cache/performance/run_abc", import.meta.url).pathname,
  );
  assertEquals(
    resolveReportDirectory("run_abc", {
      NOJ_TEST_TIMING_DIR: "/tmp/baseline-run-1",
    }),
    "/tmp/baseline-run-1",
  );
  assertEquals(
    profileEnvironment({ profile: true }, "run_abc", {
      NOJ_TEST_TIMING_DIR: "/tmp/baseline-run-1",
    }).NOJ_TEST_TIMING_DIR,
    "/tmp/baseline-run-1",
  );
});

Deno.test("test-launcher: JUnit 文件名按 shard 区分", () => {
  assertEquals(
    junitPathFor("/tmp/report", "shard2"),
    "/tmp/report/junit-shard2.xml",
  );
  assertEquals(
    junitPathFor("/tmp/report", "single"),
    "/tmp/report/junit-single.xml",
  );
});

Deno.test("test-launcher: buildManifest 字段与 TestRunManifest 对齐", () => {
  const startedAt = Date.parse("2026-11-03T00:00:00.000Z");
  const manifest = buildManifest({
    runId: "run_abc",
    suite: "core",
    command: ["deno", "run", "-A", "scripts/test-launcher.ts", "parallel"],
    commit: "be1ee7b51",
    denoVersion: "2.9.8",
    runner: { os: "linux", arch: "x86_64", ci: true },
    concurrency: { shards: 4, jobs: 2, filter: "Redis" },
    startedAt,
    endedAt: startedAt + 65_000,
    discovered: [
      "tests/b.test.ts",
      "tests/a.test.ts",
      "tests/a.test.ts",
    ],
    selected: ["tests/a.test.ts"],
    executed: ["tests/a.test.ts"],
    junit: ["/tmp/report/junit-shard1.xml"],
    exitCode: 0,
  });
  assertEquals(manifest.version, 1);
  assertEquals(manifest.runId, "run_abc");
  assertEquals(manifest.suite, "core");
  assertEquals(
    manifest.command,
    "deno run -A scripts/test-launcher.ts parallel",
  );
  assertEquals(manifest.commit, "be1ee7b51");
  assertEquals(manifest.denoVersion, "2.9.8");
  assertEquals(manifest.runner, { os: "linux", arch: "x86_64", ci: true });
  assertEquals(manifest.concurrency, {
    shards: 4,
    jobs: 2,
    filter: "Redis",
  });
  assertEquals(manifest.startedAt, "2026-11-03T00:00:00.000Z");
  assertEquals(manifest.endedAt, "2026-11-03T00:01:05.000Z");
  assertEquals(manifest.durationMs, 65_000);
  assertEquals(manifest.discovered, ["tests/a.test.ts", "tests/b.test.ts"]);
  assertEquals(manifest.selected, ["tests/a.test.ts"]);
  assertEquals(manifest.executed, ["tests/a.test.ts"]);
  assertEquals(manifest.junit, ["/tmp/report/junit-shard1.xml"]);
  assertEquals(manifest.canary, null);
  assertEquals(manifest.exitCode, 0);
  // 失败运行同样可构造清单，且不带 commit 字段时不会伪造。
  const failed = buildManifest({
    runId: "run_fail",
    suite: "domain:identity",
    command: ["deno", "run", "-A", "scripts/test-launcher.ts", "domain"],
    denoVersion: "2.9.8",
    runner: { os: "linux", arch: "x86_64", ci: false },
    concurrency: { shards: 1, jobs: 1 },
    startedAt,
    endedAt: startedAt + 1,
    discovered: [],
    selected: [],
    executed: [],
    junit: [],
    exitCode: 1,
  });
  assertEquals(failed.commit, undefined);
  assertEquals(failed.exitCode, 1);
  assertEquals(failed.suite, "domain:identity");
});

Deno.test("test-launcher: NOJ_TEST_RUN_ID 允许连字符但数据库前缀仍合法", () => {
  const plan = createRunPlan("/tmp/noj-tests", "baseline-1751234567-2");
  assertEquals(plan.runId, "baseline-1751234567-2");
  assert(
    plan.prefix.startsWith("noj_test_baseline_1751234567_2"),
    `数据库前缀必须把连字符替换为下划线：${plan.prefix}`,
  );
  assert(isOwnedDatabaseName(plan.templateDatabase, plan.prefix));
  assert(isOwnedStorageRoot(plan.storageRoot, plan.prefix));
  assertThrows(
    () => createRunPlan("/tmp/noj-tests", "bad/run"),
    Error,
    "只能包含字母、数字、下划线和连字符",
  );
});
