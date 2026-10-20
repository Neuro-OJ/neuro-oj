/**
 * 测试启动器的环境、命名和资源所有权契约。
 *
 * 这个模块只包含纯逻辑，不能连接 PostgreSQL、Redis 或 Docker。正式启动器和
 * 零依赖逻辑测试共同使用这里的边界检查，避免资源清理规则藏在编排代码里。
 */
import type { LaunchMode } from "./test-launcher-args.ts";

export interface TestEnvironment {
  pgAdminUrl: string;
  redisUrl: string;
  storageRoot: string;
  jwtSecret: string;
}

export interface RunPlan {
  runId: string;
  prefix: string;
  templateDatabase: string;
  storageRoot: string;
}

export interface BootstrapObservation {
  currentDatabase: string;
  usersTable: string | null;
}

export interface RedisContainerLabels {
  owner: string;
  name: string;
  createdBy: string;
}

const REQUIRED_ENV = [
  "TEST_PG_ADMIN_URL",
  "TEST_REDIS_URL",
  "TEST_STORAGE_ROOT",
  "JWT_SECRET",
] as const;

/** 子测试环境中必须清除的连接和测试资源变量。 */
export const RESETTABLE_ENV = [
  "DATABASE_URL",
  "REDIS_URL",
  "NOJ_TEST_SCHEDULING_REDIS_URL",
  "SUPPORT_PACKAGE_DIR",
  "NOJ_MIGRATIONS_DIR",
  "NOJ_TEST_DATABASE_OWNED",
  "NOJ_TEST_DATABASE_PREFIX",
  "NOJ_TEST_DATABASE_NAME",
  "RATE_LIMIT_ENABLED",
  "NOJ_BYPASS_JWT_REVOKE",
  "TEST_PG_ADMIN_URL",
  "TEST_REDIS_URL",
  "TEST_STORAGE_ROOT",
] as const;

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** 测试模式的正式环境变量；缺少任何一个都必须失败而不是静默跳过。 */
export function readTestEnvironment(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): TestEnvironment {
  const missing = REQUIRED_ENV.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `测试启动器缺少必需环境变量：${missing.join("、")}；` +
        "不会读取开发 .env，请为本次测试显式提供隔离资源",
    );
  }

  const jwtSecret = env.JWT_SECRET!.trim();
  if (jwtSecret.length < 32) {
    throw new Error("JWT_SECRET 必须至少 32 个字符，测试启动器拒绝弱密钥");
  }

  validateUrl(env.TEST_PG_ADMIN_URL!, "TEST_PG_ADMIN_URL", [
    "postgres:",
    "postgresql:",
  ]);
  validateUrl(env.TEST_REDIS_URL!, "TEST_REDIS_URL", ["redis:", "rediss:"]);
  if (new URL(env.TEST_PG_ADMIN_URL!).pathname.replace(/^\/+/, "") === "") {
    throw new Error(
      "TEST_PG_ADMIN_URL 必须显式包含 admin 数据库名，例如 /postgres",
    );
  }

  const storageRoot = env.TEST_STORAGE_ROOT!.trim();
  if (!storageRoot.startsWith("/")) {
    throw new Error("TEST_STORAGE_ROOT 必须是绝对路径，避免清理范围无法确认");
  }
  return {
    pgAdminUrl: env.TEST_PG_ADMIN_URL!.trim(),
    redisUrl: env.TEST_REDIS_URL!.trim(),
    storageRoot,
    jwtSecret,
  };
}

function validateUrl(url: string, name: string, protocols: string[]): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${name} 不是合法 URL`);
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new Error(`${name} 必须使用 ${protocols.join("/ ")} 协议`);
  }
}

/** 只接受启动器生成的数据库标识符，所有 SQL 标识符都经过此校验。 */
export function assertDatabaseIdentifier(name: string): string {
  if (!IDENTIFIER_RE.test(name)) {
    throw new Error(`测试数据库标识符非法：${name}`);
  }
  return name;
}

/** 判断数据库名是否属于本 run；不接受仅前缀相同但缺少分隔符的名称。 */
export function isOwnedDatabaseName(name: string, prefix: string): boolean {
  return Boolean(prefix) && name.startsWith(`${prefix}_`) &&
    IDENTIFIER_RE.test(name);
}

/** 判断存储目录是否是本 run 的精确末级目录，禁止前缀模糊匹配。 */
export function isOwnedStorageRoot(root: string, prefix: string): boolean {
  return root !== "/" && IDENTIFIER_RE.test(prefix) &&
    root.endsWith(`/${prefix}`);
}

/**
 * 为一次运行建立稳定的资源计划。
 *
 * `runId` 只允许短的标识符，不能由用户传入路径或 SQL 片段；默认值包含
 * 时间与 UUID 片段，保证并行启动的两个 run 不复用数据库或目录。
 */
export function createRunPlan(
  storageRoot: string,
  runId = `r${Date.now().toString(36)}${
    crypto.randomUUID().replaceAll("-", "").slice(0, 12)
  }`,
): RunPlan {
  if (!/^[A-Za-z0-9_]{4,32}$/.test(runId)) {
    throw new Error("NOJ_TEST_RUN_ID 只能包含字母、数字和下划线，长度 4-32");
  }
  const prefix = assertDatabaseIdentifier(`noj_test_${runId}`);
  const templateDatabase = assertDatabaseIdentifier(`${prefix}_template`);
  const root = storageRoot.replace(/\/+$/, "");
  if (!root || root === "/") {
    throw new Error("TEST_STORAGE_ROOT 不能是文件系统根目录");
  }
  if (root.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("TEST_STORAGE_ROOT 不能包含 . 或 .. 路径段");
  }
  const runRoot = `${root}/${prefix}`;
  if (!runRoot.startsWith(`${root}/`)) {
    throw new Error("测试存储 run 目录越界");
  }
  if (runRoot === "/" || !runRoot.endsWith(`/${prefix}`)) {
    throw new Error("测试存储 run 目录边界无法确认");
  }
  return { runId, prefix, templateDatabase, storageRoot: runRoot };
}

/**
 * 创建本 run 的存储根目录。
 *
 * 父目录可以是本次首次创建的；它属于 TEST_STORAGE_ROOT，不属于 run，因而
 * 清理阶段只能删除成功创建的精确 runRoot。runRoot 使用 recursive=false，
 * 让预存在的 run 直接失败，避免两个启动器共享或覆盖同一存储空间。
 */
export async function createRunStorageRoot(plan: RunPlan): Promise<void> {
  const parentRoot = plan.storageRoot.slice(
    0,
    plan.storageRoot.lastIndexOf("/"),
  );
  await Deno.mkdir(parentRoot || "/", { recursive: true });
  await Deno.mkdir(plan.storageRoot, { recursive: false });
}

/** 生成本 run 的 shard 数据库名；名称越界或不属于本 run 时直接失败。 */
export function shardDatabaseName(plan: RunPlan, shardName: string): string {
  if (!/^[A-Za-z0-9_]{1,16}$/.test(shardName)) {
    throw new Error(`分片名非法：${shardName}`);
  }
  const name = assertDatabaseIdentifier(`${plan.prefix}_${shardName}`);
  if (!isOwnedDatabaseName(name, plan.prefix)) {
    throw new Error(`分片数据库不属于本 run：${name}`);
  }
  return name;
}

/** 把连接 URL 指向生成的数据库名；名称已通过标识符校验。 */
export function databaseUrlFor(url: string, databaseName: string): string {
  assertDatabaseIdentifier(databaseName);
  const parsed = new URL(url);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

/** 为 Redis 临时容器生成可审计的 owner 标签；run 与 shard 均必须精确匹配。 */
export function redisContainerLabels(
  plan: Pick<RunPlan, "prefix">,
  name: string,
): RedisContainerLabels {
  return { owner: plan.prefix, name, createdBy: "test-launcher" };
}

/**
 * 构造专用 Redis 容器的 Docker 命令。
 *
 * 每次调用都是独立容器、随机宿主端口和临时文件系统；这个契约让测试可以
 * 直接验证跨 run 不会退化为共享 DB slot/FLUSHDB，而不需要在零依赖任务中
 * 启动 Docker。
 */
export function redisContainerRunArgs(
  plan: Pick<RunPlan, "prefix">,
  name: string,
): string[] {
  const labels = redisContainerLabels(plan, name);
  return [
    "run",
    "--detach",
    "--rm",
    "--label",
    `com.noj.test.owner=${labels.owner}`,
    "--label",
    "com.noj.test.resource=redis",
    "--label",
    `com.noj.test.name=${labels.name}`,
    "--label",
    `com.noj.test.created-by=${labels.createdBy}`,
    "--publish",
    "127.0.0.1::6379",
    "redis:7-alpine",
    "redis-server",
    "--save",
    "",
    "--appendonly",
    "no",
  ];
}

/** 清理前的 label 判断，防止一个 run 清理另一个 run 的 Redis 容器。 */
export function ownsRedisContainer(
  labels: RedisContainerLabels,
  plan: Pick<RunPlan, "prefix">,
  name: string,
): boolean {
  const expected = redisContainerLabels(plan, name);
  return labels.owner === expected.owner && labels.name === expected.name &&
    labels.createdBy === expected.createdBy;
}

/** 检查正式迁移和 seed 的结果，负例必须显式失败。 */
export function assertBootstrapObservation(
  observation: BootstrapObservation,
  expectedDatabase: string,
): void {
  if (observation.currentDatabase !== expectedDatabase) {
    throw new Error(
      `测试启动器连接错库：current_database()=${observation.currentDatabase}，` +
        `期望 ${expectedDatabase}`,
    );
  }
  if (observation.usersTable !== "users") {
    throw new Error(
      `测试启动器未完成正式迁移：current_database()=${observation.currentDatabase} ` +
        "中不存在 users 表",
    );
  }
}

/** 构造传给子测试进程的环境，确保子进程不能继承开发连接。 */
export function makeChildEnvironment(
  baseEnvironment: Record<string, string | undefined>,
  environment: Pick<TestEnvironment, "jwtSecret">,
  plan: Pick<RunPlan, "prefix">,
  databaseName: string,
  databaseUrl: string,
  redisUrl: string,
  storageDir: string,
  mode: LaunchMode,
  runPerf = mode === "perf",
): Record<string, string> {
  const env = { ...baseEnvironment };
  for (const key of RESETTABLE_ENV) delete env[key];
  Object.assign(env, {
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    SUPPORT_PACKAGE_DIR: storageDir,
    STORAGE_PROVIDER: "local",
    NOJ_ENV: "test",
    JWT_SECRET: environment.jwtSecret,
    BCRYPT_SALT_ROUNDS: env.BCRYPT_SALT_ROUNDS ?? "4",
    NOJ_TEST_DATABASE_OWNED: "1",
    NOJ_TEST_DATABASE_PREFIX: plan.prefix,
    NOJ_TEST_DATABASE_NAME: databaseName,
  });
  if (runPerf) {
    env.NOJ_RUN_PERF = "1";
    env.NOJ_PERF_ALLOW_EXTERNAL_DB = "1";
  } else {
    delete env.NOJ_RUN_PERF;
    delete env.NOJ_PERF_ALLOW_EXTERNAL_DB;
  }
  return env as Record<string, string>;
}
