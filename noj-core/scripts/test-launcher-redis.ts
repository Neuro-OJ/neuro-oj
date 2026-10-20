/**
 * 测试启动器的 Redis 资源编排。
 *
 * 正式测试使用每个 run/shard 独立的 Redis 容器，因此不需要也不允许对共享
 * endpoint 执行 FLUSHDB。容器释放前会重新读取 owner label，避免清理越界。
 */
import IORedis from "ioredis";
import {
  ownsRedisContainer,
  redisContainerLabels,
  redisContainerRunArgs,
  type RunPlan,
} from "./test-launcher-resources.ts";

export interface RedisLease {
  url: string;
  containerId: string;
  ownerLabel: string;
  release: () => Promise<void>;
}

function redisDisplay(url: string): string {
  const parsed = new URL(url);
  return `${parsed.hostname}:${parsed.port || "6379"}${parsed.pathname}`;
}

/**
 * 检查显式提供的测试 Redis endpoint。
 *
 * TEST_REDIS_URL 是 bootstrap 迁移和 seed 使用的实际 endpoint，不能静默回退
 * 到开发 Redis。child 测试流量使用本启动器创建的独立容器。
 */
export async function checkTestRedis(url: string): Promise<void> {
  // @ts-ignore ioredis 的 Deno 类型解析受限，但运行时构造器稳定。
  const redis = new IORedis(url, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
    enableOfflineQueue: false,
  });
  let failure: unknown;
  try {
    await redis.connect();
    await redis.ping();
  } catch (error) {
    failure = new Error(
      `无法连接 TEST_REDIS_URL（${redisDisplay(url)}）：${String(error)}`,
      { cause: error },
    );
  }
  try {
    await redis.quit();
  } catch (closeError) {
    if (failure !== undefined) {
      throw new AggregateError(
        [failure, closeError],
        `检查 TEST_REDIS_URL 后关闭连接失败（${redisDisplay(url)}）`,
      );
    }
    throw new Error(
      `关闭 TEST_REDIS_URL 连接失败（${redisDisplay(url)}）：${
        String(closeError)
      }`,
      { cause: closeError },
    );
  }
  if (failure !== undefined) throw failure;
}

export { redisDisplay };

async function runDocker(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const command = new Deno.Command("docker", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

/** 启动带精确 owner label 的专用 Redis 容器。 */
export async function acquireRedisLease(
  plan: RunPlan,
  name: string,
): Promise<RedisLease> {
  const resourceLabels = redisContainerLabels(plan, name);
  const ownerLabel = `${resourceLabels.owner}:${resourceLabels.name}`;
  const started = await runDocker(redisContainerRunArgs(plan, name));
  if (started.code !== 0) {
    throw new Error(
      `无法创建隔离 Redis 容器（${ownerLabel}）：${
        started.stderr.trim() || started.stdout.trim()
      }`,
    );
  }
  const containerId = started.stdout.trim().split("\n")[0]?.trim();
  if (!containerId) {
    throw new Error(`Redis 容器启动未返回 container ID（${ownerLabel}）`);
  }
  const port = await waitForRedisContainer(
    containerId,
    plan.prefix,
    name,
    ownerLabel,
  );
  const url = `redis://127.0.0.1:${port}/0`;
  return {
    url,
    containerId,
    ownerLabel,
    release: async () =>
      await releaseRedisContainer(containerId, plan.prefix, name),
  };
}

async function waitForRedisContainer(
  containerId: string,
  expectedOwner: string,
  expectedName: string,
  ownerLabel: string,
): Promise<number> {
  let lastError = "";
  for (let attempt = 0; attempt < 40; attempt++) {
    const portResult = await runDocker(["port", containerId, "6379/tcp"]);
    if (portResult.code === 0) {
      const match = portResult.stdout.match(/:(\d+)\s*$/m);
      if (match) {
        const port = Number(match[1]);
        const url = `redis://127.0.0.1:${port}/0`;
        try {
          await checkTestRedis(url);
          return port;
        } catch (error) {
          lastError = String(error);
        }
      }
    } else {
      lastError = portResult.stderr.trim() || portResult.stdout.trim();
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const notReady = new Error(
    `隔离 Redis 容器未就绪（${ownerLabel}）：${lastError}`,
  );
  try {
    await releaseRedisContainer(containerId, expectedOwner, expectedName);
  } catch (cleanupError) {
    throw new AggregateError(
      [notReady, cleanupError],
      `隔离 Redis 容器未就绪且清理失败（${ownerLabel}）`,
    );
  }
  throw notReady;
}

async function releaseRedisContainer(
  containerId: string,
  expectedOwner: string,
  expectedName: string,
): Promise<void> {
  const inspect = await runDocker([
    "inspect",
    "--format",
    '{{index .Config.Labels "com.noj.test.owner"}}|{{index .Config.Labels "com.noj.test.name"}}|{{index .Config.Labels "com.noj.test.created-by"}}',
    containerId,
  ]);
  if (inspect.code !== 0) {
    if (/no such object|No such container/i.test(inspect.stderr)) return;
    throw new Error(
      `无法核验 Redis 容器 ${containerId} 的 owner label：${inspect.stderr.trim()}`,
    );
  }
  const [owner, name, createdBy] = inspect.stdout.trim().split("|");
  if (
    !ownsRedisContainer(
      { owner: owner ?? "", name: name ?? "", createdBy: createdBy ?? "" },
      { prefix: expectedOwner },
      expectedName,
    )
  ) {
    throw new Error(`拒绝清理 owner label 不匹配的 Redis 容器：${containerId}`);
  }
  const removed = await runDocker(["rm", "--force", containerId]);
  if (
    removed.code !== 0 &&
    !/no such object|No such container/i.test(removed.stderr)
  ) {
    throw new Error(
      `清理 Redis 容器 ${containerId} 失败：${removed.stderr.trim()}`,
    );
  }
}
