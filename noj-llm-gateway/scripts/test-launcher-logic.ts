/**
 * Gateway 正式测试启动器的纯逻辑。
 *
 * 资源入口必须由调用方显式提供；这里不能读取 .env、开发配置或默认端口。
 * 真实 PostgreSQL/Redis 的连接和清理在 test-launcher.ts，缺依赖校验在本文件
 * 保持可被零依赖测试覆盖。
 */

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export interface GatewayTestEnvironment {
  pgAdminUrl: string;
  redisUrl: string;
}

export interface GatewayTestRunPlan {
  runId: string;
  databaseName: string;
  redisPrefix: string;
}

const REQUIRED_ENV = ["TEST_PG_ADMIN_URL", "TEST_REDIS_URL"] as const;
const REDIS_PREFIX_RE = /^noj-gateway-test:[A-Za-z0-9_:-]{4,128}:$/;
const REPORTERS = new Set(["pretty", "dot", "junit", "tap", "json", "github"]);

function parseOptionValue(
  args: readonly string[],
  index: number,
  option: string,
): { value: string; nextIndex: number } {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`Gateway 测试启动器的 ${option} 缺少值`);
  }
  return { value, nextIndex: index + 1 };
}

function assertReporter(value: string): string {
  if (!REPORTERS.has(value)) {
    throw new Error(
      `Gateway 测试启动器不支持 reporter：${value}；` +
        `允许值：${[...REPORTERS].join("、")}`,
    );
  }
  return value;
}

/** 读取正式测试资源；任何必需资源缺失都必须失败，不能让测试变成 ignored。 */
export function readTestEnvironment(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): GatewayTestEnvironment {
  const missing = REQUIRED_ENV.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Gateway 正式测试缺少必需环境变量：${missing.join("、")}；` +
        "不会读取开发 .env 或回退默认 PostgreSQL/Redis",
    );
  }

  const pgAdminUrl = env.TEST_PG_ADMIN_URL!.trim();
  const redisUrl = env.TEST_REDIS_URL!.trim();
  validateUrl(pgAdminUrl, "TEST_PG_ADMIN_URL", [
    "postgres:",
    "postgresql:",
  ]);
  validateUrl(redisUrl, "TEST_REDIS_URL", ["redis:", "rediss:"]);
  if (new URL(pgAdminUrl).pathname.replace(/^\/+/, "") === "") {
    throw new Error(
      "TEST_PG_ADMIN_URL 必须显式包含 admin 数据库名，例如 /postgres",
    );
  }
  return { pgAdminUrl, redisUrl };
}

function validateUrl(url: string, name: string, protocols: string[]): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${name} 不是合法 URL`);
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new Error(`${name} 必须使用 ${protocols.join("/")} 协议`);
  }
}

/** 只接受启动器自己生成的 PostgreSQL 标识符。 */
export function assertDatabaseIdentifier(name: string): string {
  if (!IDENTIFIER_RE.test(name)) {
    throw new Error(`Gateway 测试数据库标识符非法：${name}`);
  }
  return name;
}

/** 生成一次测试运行的唯一数据库名与 Redis key namespace。 */
export function createRunPlan(
  runId = `r${Date.now().toString(36)}${
    crypto.randomUUID().replaceAll("-", "").slice(0, 12)
  }`,
): GatewayTestRunPlan {
  if (!/^[A-Za-z0-9_]{4,32}$/.test(runId)) {
    throw new Error(
      "NOJ_GATEWAY_TEST_RUN_ID 只能包含字母、数字和下划线，长度 4-32",
    );
  }
  const databaseName = assertDatabaseIdentifier(`noj_gateway_test_${runId}`);
  return {
    runId,
    databaseName,
    redisPrefix: `noj-gateway-test:${runId}:`,
  };
}

/** 验证启动器拥有的 Redis namespace；清理不得接受任意用户提供的 pattern。 */
export function assertRedisPrefix(prefix: string): string {
  if (!REDIS_PREFIX_RE.test(prefix)) {
    throw new Error(`Gateway 测试 Redis namespace 非法：${prefix}`);
  }
  return prefix;
}

/** 生成只匹配本 run 的 Redis SCAN pattern。 */
export function redisPrefixPattern(prefix: string): string {
  return `${assertRedisPrefix(prefix)}*`;
}

/**
 * 只转发安全的 Deno test 选项。
 *
 * 测试根目录、权限、检查模式和并发由启动器固定；filter、fail-fast、reporter
 * 等诊断选项可透传。路径参数会被拒绝，避免绕过统一的 tests 入口。
 */
export function parseTestArgs(args: readonly string[]): string[] {
  const forwarded: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--filter") {
      const { value, nextIndex } = parseOptionValue(args, index, arg);
      forwarded.push(arg, value);
      index = nextIndex;
      continue;
    }
    if (arg.startsWith("--filter=")) {
      if (arg.length === "--filter=".length) {
        throw new Error("Gateway 测试启动器的 --filter 缺少值");
      }
      forwarded.push(arg);
      continue;
    }
    if (arg === "--reporter") {
      const { value, nextIndex } = parseOptionValue(args, index, arg);
      forwarded.push(arg, assertReporter(value));
      index = nextIndex;
      continue;
    }
    if (arg.startsWith("--reporter=")) {
      forwarded.push(
        `--reporter=${assertReporter(arg.slice("--reporter=".length))}`,
      );
      continue;
    }
    if (
      arg === "--fail-fast" ||
      arg === "--shuffle" ||
      arg === "--trace-leaks" ||
      arg === "--hide-stacktraces" ||
      arg === "--no-clear-screen"
    ) {
      forwarded.push(arg);
      continue;
    }
    if (arg === "--parallel" || arg.startsWith("--parallel=")) {
      throw new Error(
        "Gateway 测试启动器拒绝 --parallel：每个 run 只能使用自己的 Redis namespace",
      );
    }
    if (/^--fail-fast=\d+$/.test(arg) || /^--shuffle=\d+$/.test(arg)) {
      forwarded.push(arg);
      continue;
    }
    if (!arg.startsWith("-")) {
      throw new Error(`Gateway 测试启动器不接受路径参数：${arg}`);
    }
    throw new Error(
      `Gateway 测试启动器不允许或不识别参数：${arg}；` +
        "测试路径、权限、配置和并发均由启动器固定",
    );
  }
  return forwarded;
}

/**
 * 统一执行与 finally 清理。
 *
 * 子测试返回非零退出码也属于正常完成路径，必须先执行 cleanup 再将该退出码交给
 * 调用方；子测试抛错和 cleanup 同时失败时保留两个错误。
 */
export async function runWithResourceCleanup<T>(
  operation: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  let result: T | undefined;
  let operationError: unknown;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }

  let cleanupError: unknown;
  try {
    await cleanup();
  } catch (error) {
    cleanupError = error;
  }

  if (operationError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [operationError, cleanupError],
      "Gateway 测试执行失败且资源清理失败",
    );
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) {
    throw new Error("Gateway 测试资源清理失败", { cause: cleanupError });
  }
  return result as T;
}

/** 将显式 admin URL 指向启动器创建的本 run 数据库。 */
export function databaseUrlFor(
  adminUrl: string,
  databaseName: string,
): string {
  assertDatabaseIdentifier(databaseName);
  const parsed = new URL(adminUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

/** 仅用于日志/诊断，绝不输出 URL 中的用户、密码或查询参数。 */
export function resourceDisplay(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.hostname}:${
    parsed.port || "default"
  }${parsed.pathname}`;
}
