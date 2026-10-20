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
import {
  existingTestPaths,
  parseLauncherArgs,
  parseSafeTestArgs,
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
    17,
    "metadata 必须保留 17 个 legacy domain 别名",
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

Deno.test("test-launcher: target 与 legacy alias 同时发现迁移期两套测试根", () => {
  const targetRoots = testRootsForTarget("problems");
  const legacyRoots = testRootsForTarget("catalog");
  assert(
    targetRoots.includes("src/modules/problems/tests") &&
      targetRoots.includes("src/domains/catalog/tests") &&
      targetRoots.includes("src/domains/objective/tests"),
    "目标模块入口必须同时保留 problems 与 catalog/objective 测试根",
  );
  assert(
    legacyRoots.join("\0") === targetRoots.join("\0"),
    "legacy alias 与目标模块必须解析为同一组迁移期测试根",
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
