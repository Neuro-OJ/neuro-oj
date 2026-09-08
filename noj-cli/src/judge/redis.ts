import type { CommandRunner } from "../runtime/command.ts";
import { realRunner } from "../runtime/command.ts";
import { envValue, loadJudgeEnv } from "./env.ts";
import type { JudgeOptions } from "./options.ts";

/** Redis 连接信息摘要，供后续命令组装 Judge 环境变量使用。 */
export interface RedisConnection {
  runtimeUrl: string;
  checkUrl: string;
  source: "existing" | "local" | "pending";
}

/** 本机 Redis 容器镜像，与 `scripts/deploy/judge-install.sh` 保持一致。 */
const REDIS_IMAGE = "redis:7-alpine";
/** 本工具创建的 Redis 容器组件标签。 */
const REDIS_LABEL = "judge-standalone-redis";
/** 连接元数据文件名。 */
const METADATA_FILE = ".redis-connection.env";
/** 连接说明文件名。 */
const GUIDE_FILE = "redis-connection.txt";

/**
 * 生成本机 Redis 密码：24 字节随机数编码为 48 位十六进制字符串。
 * 对应 shell 中 `openssl rand -hex 24`。
 */
export function generateRedisPassword(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 校验本机 Redis 宿主机端口。
 * 只允许 1024-65535 的整数，避免特权端口与非法值。
 */
export function validateRedisPort(port: number): void {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`本机 Redis 端口必须在 1024-65535 范围内：${port}`);
  }
}

/** 返回本机 Redis 连接信息文件路径。 */
export function redisConnectionFiles(opts: JudgeOptions): {
  metadata: string;
  guide: string;
} {
  return {
    metadata: `${opts.dir}/${METADATA_FILE}`,
    guide: `${opts.dir}/${GUIDE_FILE}`,
  };
}

/** 读取已保存的本机 Redis 连接信息；缺任一字段时抛错。 */
function readRedisConnectionFiles(opts: JudgeOptions): {
  coreUrl: string;
  runtimeUrl: string;
  checkUrl: string;
} {
  const { metadata } = redisConnectionFiles(opts);
  const env = loadJudgeEnv(metadata);
  const coreUrl = envValue(env, "REDIS_CORE_URL") ?? "";
  const runtimeUrl = envValue(env, "REDIS_RUNTIME_URL") ?? "";
  const checkUrl = envValue(env, "REDIS_CHECK_URL") ?? "";
  if (!coreUrl || !runtimeUrl || !checkUrl) {
    throw new Error(
      `检测到本工具创建的 Redis，但缺少连接信息：${metadata}；请手动恢复后再继续`,
    );
  }
  return { coreUrl, runtimeUrl, checkUrl };
}

/**
 * 写入 Redis 连接信息文件：`.redis-connection.env`（机器读取）与
 * `redis-connection.txt`（人工指引），两个文件均为 0600。
 */
function writeRedisConnectionFiles(
  opts: JudgeOptions,
  coreUrl: string,
  runtimeUrl: string,
  checkUrl: string,
  port: number,
): void {
  const { metadata, guide } = redisConnectionFiles(opts);
  Deno.mkdirSync(opts.dir, { recursive: true });
  const metadataText = `REDIS_CORE_URL=${coreUrl}\n` +
    `REDIS_RUNTIME_URL=${runtimeUrl}\n` +
    `REDIS_CHECK_URL=${checkUrl}\n`;
  Deno.writeTextFileSync(metadata, metadataText);
  Deno.chmodSync(metadata, 0o600);

  const guideText =
    "# Redis 连接信息（含密码，请勿提交到代码仓库或公开分享）\n" +
    "# noj-core 使用：\n" +
    `REDIS_URL=${coreUrl}\n\n` +
    "# Judge 容器使用：\n" +
    `REDIS_URL=${runtimeUrl}\n`;
  Deno.writeTextFileSync(guide, guideText);
  Deno.chmodSync(guide, 0o600);

  console.log(`Redis 连接信息已保存：${guide}（权限 600）`);
  console.error(
    `  请让 noj-core 和 Judge 使用同一个 Redis；不要把它们配置到不同实例。\n` +
      `  noj-core 地址：127.0.0.1:${port}；Judge 容器地址：host.docker.internal:${port}`,
  );
}

/** 检查本机端口是否已被监听（仅检查 127.0.0.1）。 */
async function isPortInUse(port: number): Promise<boolean> {
  try {
    const conn = await Deno.connect({ hostname: "127.0.0.1", port });
    conn.close();
    return true;
  } catch {
    return false;
  }
}

/** 执行 docker 命令；docker 缺失时转换为友好错误。 */
async function runDocker(
  runner: CommandRunner,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    return await runner.run("docker", args);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new Error("缺少依赖：docker");
    }
    throw e;
  }
}

/**
 * 创建或复用本机 Redis 容器，并写入连接信息文件。
 * 行为与 `scripts/deploy/judge-install.sh` 的 `create_local_redis` 保持一致。
 */
export async function createLocalRedis(
  opts: JudgeOptions,
  runner: CommandRunner = realRunner(),
): Promise<void> {
  const containerName = opts.redisContainer;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(containerName)) {
    throw new Error(`本机 Redis 容器名格式无效：${containerName}`);
  }
  validateRedisPort(opts.redisPort);

  const inspect = await runDocker(runner, [
    "container",
    "inspect",
    containerName,
  ]);
  if (inspect.code === 0) {
    const labelResult = await runDocker(runner, [
      "container",
      "inspect",
      "--format",
      '{{ index .Config.Labels "com.neuro-oj.component" }}',
      containerName,
    ]);
    const label = labelResult.stdout.trim();
    if (label !== REDIS_LABEL) {
      throw new Error(
        `Redis 容器名已被其他容器占用：${containerName}；不会删除或修改它，请换名或连接已有 Redis`,
      );
    }
    const existing = readRedisConnectionFiles(opts);
    writeRedisConnectionFiles(
      opts,
      existing.coreUrl,
      existing.runtimeUrl,
      existing.checkUrl,
      opts.redisPort,
    );
    console.log(`已复用本工具已创建的 Redis：${containerName}`);
    return;
  }

  if (await isPortInUse(opts.redisPort)) {
    throw new Error(
      `本机 Redis 端口已被占用：127.0.0.1:${opts.redisPort}；请换一个端口，或选择连接已有 Redis`,
    );
  }

  const password = generateRedisPassword();
  const configFile = `${opts.dir}/redis.conf`;
  Deno.mkdirSync(opts.dir, { recursive: true });
  Deno.writeTextFileSync(
    configFile,
    `appendonly yes\nrequirepass ${password}\n`,
  );
  Deno.chmodSync(configFile, 0o600);

  const args = [
    "run",
    "-d",
    "--name",
    containerName,
    "--label",
    "com.neuro-oj.component=judge-standalone-redis",
    "--label",
    "com.neuro-oj.managed-by=judge-install",
    "--restart",
    "unless-stopped",
    "--publish",
    `127.0.0.1:${opts.redisPort}:6379`,
    "--volume",
    `${containerName}-data:/data`,
    "--volume",
    `${configFile}:/usr/local/etc/redis/redis.conf:ro`,
    REDIS_IMAGE,
    "redis-server",
    "/usr/local/etc/redis/redis.conf",
  ];
  const result = await runDocker(runner, args);
  if (result.code !== 0) {
    throw new Error(
      "本机 Redis 创建失败；端口可能被占用或 Docker 权限不足。原有服务未被修改",
    );
  }

  const coreUrl = `redis://:${password}@127.0.0.1:${opts.redisPort}/0`;
  const runtimeUrl =
    `redis://:${password}@host.docker.internal:${opts.redisPort}/0`;
  const checkUrl = coreUrl;
  writeRedisConnectionFiles(
    opts,
    coreUrl,
    runtimeUrl,
    checkUrl,
    opts.redisPort,
  );
  console.log(
    `本机 Redis 已创建：${containerName}（数据卷：${containerName}-data）`,
  );
}
