import type { CmdResult, CommandRunner } from "../runtime/command.ts";
import { realRunner } from "../runtime/command.ts";
import type { JudgeEnv } from "./env.ts";
import { envValue } from "./env.ts";
import type { JudgeOptions } from "./options.ts";

/** 必需配置项：未配置或仍为占位值时视为问题。 */
const REQUIRED_CONFIG_KEYS = [
  "NOJ_VERSION",
  "REDIS_URL",
  "JUDGE_QUEUE",
  "RESULT_QUEUE",
  "WORK_DIR",
  "JUDGE_MAX_CONCURRENT_JUDGES",
  "JUDGE_IMAGE_PREFIX",
  "JUDGE_IMAGE_REGISTRY",
  "JUDGE_DOCKER_SOCKET",
  "JUDGE_DOCKER_SOCKET_GID",
  "JUDGE_UID",
  "JUDGE_GID",
] as const;

function isPlaceholder(value: string, key?: string): boolean {
  if (value === "") return true;
  if (/change-me|changeme|example|placeholder|replace-me|your-/.test(value)) {
    return true;
  }
  if (value === "latest" || value === "main") return true;
  // 队列名允许使用 xxx-* 这类真实业务前缀；版本等其余字段仍按 shell 的 xxx* 识别为占位值。
  if (key === "JUDGE_QUEUE" || key === "RESULT_QUEUE") return false;
  return value.startsWith("xxx");
}

function isReleaseVersion(value: string): boolean {
  return /^v?[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$/.test(value);
}

async function unameValue(
  runner: CommandRunner,
  flag: string,
  fallback: string,
): Promise<string> {
  try {
    const r = await runner.run("uname", [flag]);
    if (r.code === 0 && r.stdout.trim() !== "") return r.stdout.trim();
  } catch {
    // 命令不可用时回退到 Deno 编译期信息
  }
  return fallback;
}

/** 执行 docker 命令；docker 二进制缺失时转换为友好错误。 */
async function runDocker(
  runner: CommandRunner,
  args: string[],
  opts?: { env?: Record<string, string> },
): Promise<CmdResult> {
  try {
    return await runner.run("docker", args, opts);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new Error("缺少依赖：docker");
    }
    throw e;
  }
}

function expectedArch(machine: string): string | undefined {
  if (machine === "x86_64" || machine === "amd64") return "amd64";
  if (machine === "aarch64" || machine === "arm64") return "arm64";
  return undefined;
}

/** 检查基础主机环境；硬性失败直接抛错，磁盘/内存等警告不阻断。 */
async function checkDiskSpaceWarning(
  runner: CommandRunner,
  dir: string,
): Promise<void> {
  let r;
  try {
    r = await runner.run("df", ["-Pk", dir]);
  } catch {
    throw new Error(`无法读取目标目录磁盘空间：${dir}`);
  }
  if (r.code !== 0) {
    throw new Error(`无法读取目标目录磁盘空间：${dir}`);
  }
  const line = r.stdout.split(/\r?\n/)[1];
  const availableKb = line?.trim().split(/\s+/)[3];
  if (availableKb === undefined || !/^[0-9]+$/.test(availableKb)) {
    throw new Error(`无法读取目标目录磁盘空间：${dir}`);
  }
  if (Number(availableKb) < 5 * 1024 * 1024) {
    console.warn("目标目录可用空间少于 5 GiB，评测镜像和缓存可能不足");
  }
}

function checkMemoryWarning(): void {
  try {
    const text = Deno.readTextFileSync("/proc/meminfo");
    const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(text);
    if (m && Number(m[1]) < 512 * 1024) {
      console.warn("可用内存少于 512 MiB，建议降低 Judge 并发");
    }
  } catch {
    // 非 Linux 或无法读取时跳过内存告警
  }
}

function detectPanel(opts: JudgeOptions): string {
  if (opts.panel === "baota") return "baota";
  if (opts.panel === "none") return "none";
  try {
    if (Deno.statSync("/www/server/panel").isDirectory) return "baota";
  } catch {
    // 未检测到宝塔目录
  }
  try {
    const bt = Deno.statSync("/usr/bin/bt");
    if ((bt.mode ?? 0) & 0o111) return "baota";
  } catch {
    // 未检测到宝塔命令
  }
  return "none";
}

function showPanelGuidance(panelName: string): void {
  if (panelName !== "baota") return;
  console.log(
    "已检测到宝塔面板。脚本会直接使用宝塔管理的标准 Docker/Compose，不调用宝塔 API。\n" +
      "请在宝塔的 Docker 页面确认 Docker 已安装并运行；部署完成后可以在那里查看本机 Redis 和 Judge 容器。\n" +
      "脚本不会修改已有站点、反向代理、容器或面板配置，Judge 也不需要公开端口。\n" +
      "安全提醒：Judge 仍必须使用只服务于 Judge 的 rootless Docker socket，不能填写 /run/docker.sock 或 /var/run/docker.sock。",
  );
}

export async function checkBaseEnvironment(
  opts: JudgeOptions,
  runner: CommandRunner = realRunner(),
): Promise<void> {
  const os = (await unameValue(runner, "-s", Deno.build.os)).toLowerCase();
  if (os !== "linux") {
    throw new Error("独立 Judge 部署目前只支持 Linux");
  }
  showPanelGuidance(detectPanel(opts));

  const machine = (await unameValue(runner, "-m", Deno.build.arch))
    .toLowerCase();
  const arch = expectedArch(machine);
  if (arch === undefined) {
    throw new Error(
      `不支持的 CPU 架构：${machine}（当前支持 x86_64/amd64 与 ARM64）`,
    );
  }

  const dockerVersion = await runDocker(runner, ["--version"]);
  if (dockerVersion.code !== 0) {
    throw new Error("缺少依赖：docker");
  }

  const dockerInfo = await runDocker(runner, ["info"]);
  if (dockerInfo.code !== 0) {
    throw new Error("Docker daemon 未运行或当前用户无权限");
  }

  const composeVersion = await runDocker(runner, ["compose", "version"]);
  if (composeVersion.code !== 0) {
    throw new Error("Docker Compose v2 不可用");
  }

  let dirExists = false;
  try {
    dirExists = Deno.statSync(opts.dir).isDirectory;
  } catch {
    dirExists = false;
  }
  if (dirExists) {
    await checkDiskSpaceWarning(runner, opts.dir);
    checkMemoryWarning();
  }
}

/** 检查 Judge 配置值，返回问题列表。 */
export function checkConfigValues(env: JudgeEnv): string[] {
  const issues: string[] = [];
  const value = (key: string): string => envValue(env, key) ?? "";

  for (const key of REQUIRED_CONFIG_KEYS) {
    if (isPlaceholder(value(key), key)) {
      issues.push(`${key} 未配置或仍是占位值`);
    }
  }

  if (!isReleaseVersion(value("NOJ_VERSION"))) {
    issues.push("NOJ_VERSION 必须是不可变 Release 标签，如 v0.1.0");
  }
  if (!/^[1-9][0-9]*$/.test(value("JUDGE_MAX_CONCURRENT_JUDGES"))) {
    issues.push("JUDGE_MAX_CONCURRENT_JUDGES 必须是正整数");
  }
  if (!/^[0-9]+$/.test(value("JUDGE_DOCKER_SOCKET_GID"))) {
    issues.push("JUDGE_DOCKER_SOCKET_GID 必须是数字");
  }
  if (
    !/^[0-9]+$/.test(value("JUDGE_UID")) ||
    !/^[0-9]+$/.test(value("JUDGE_GID"))
  ) {
    issues.push("JUDGE_UID 和 JUDGE_GID 必须是数字");
  }

  const dockerHost = value("JUDGE_DOCKER_HOST");
  if (!dockerHost.startsWith("unix:///")) {
    issues.push("JUDGE_DOCKER_HOST 必须使用 unix:// endpoint");
  } else if (dockerHost !== "unix:///run/noj-judge/docker.sock") {
    issues.push(
      "JUDGE_DOCKER_HOST 必须为容器内专用 endpoint：unix:///run/noj-judge/docker.sock",
    );
  }

  if (value("JUDGE_REQUIRE_ISOLATED_DOCKER") !== "true") {
    issues.push("JUDGE_REQUIRE_ISOLATED_DOCKER 必须为 true");
  }

  return issues;
}

/** 检查专用 Docker socket；返回问题列表。 */
export async function checkSocket(
  env: JudgeEnv,
  runner: CommandRunner = realRunner(),
): Promise<string[]> {
  const issues: string[] = [];
  const socketPath = envValue(env, "JUDGE_DOCKER_SOCKET") ?? "";
  const configuredGid = envValue(env, "JUDGE_DOCKER_SOCKET_GID") ?? "";

  if (
    socketPath === "/var/run/docker.sock" || socketPath === "/run/docker.sock"
  ) {
    issues.push(
      `禁止使用应用宿主机 Docker socket：${socketPath}；请准备专用 rootless socket`,
    );
  }
  if (!socketPath.startsWith("/")) {
    issues.push("JUDGE_DOCKER_SOCKET 必须是绝对路径");
  }
  if (socketPath.includes(":")) {
    issues.push("JUDGE_DOCKER_SOCKET 必须是本机 Unix socket 路径");
  }
  if (issues.length > 0) return issues;

  let stat: Deno.FileInfo;
  try {
    stat = Deno.statSync(socketPath);
  } catch {
    issues.push(`专用 Docker socket 不存在或不是 Unix socket：${socketPath}`);
    return issues;
  }
  if (!stat.isSocket) {
    issues.push(`专用 Docker socket 不存在或不是 Unix socket：${socketPath}`);
    return issues;
  }
  const readOk = await runner.run("test", ["-r", socketPath])
    .then((r) => r.code === 0)
    .catch(() => false);
  const writeOk = await runner.run("test", ["-w", socketPath])
    .then((r) => r.code === 0)
    .catch(() => false);
  if (!readOk || !writeOk) {
    issues.push(`当前用户无法读写专用 Docker socket：${socketPath}`);
    return issues;
  }

  const socketGid = stat.gid?.toString() ?? "";
  if (socketGid !== configuredGid) {
    issues.push(
      `Docker socket GID=${socketGid} 与配置 JUDGE_DOCKER_SOCKET_GID=${configuredGid} 不一致`,
    );
    return issues;
  }

  let r;
  try {
    r = await runDocker(runner, ["info"], {
      env: { DOCKER_HOST: `unix://${socketPath}` },
    });
  } catch (e) {
    if (e instanceof Error && e.message === "缺少依赖：docker") {
      issues.push("缺少依赖：docker");
    } else {
      issues.push(`专用 rootless Docker daemon 不可连接：${socketPath}`);
    }
    return issues;
  }
  if (r.code !== 0) {
    issues.push(`专用 rootless Docker daemon 不可连接：${socketPath}`);
  }
  return issues;
}

function redisHost(url: string): string {
  let rest = url.replace(/^[a-z]+:\/\//i, "");
  const at = rest.indexOf("@");
  if (at !== -1) rest = rest.slice(at + 1);
  rest = rest.split("/")[0] ?? "";
  const colon = rest.indexOf(":");
  return colon === -1 ? rest || "未知主机" : rest.slice(0, colon) || "未知主机";
}

function isRedisUrl(url: string): boolean {
  return /^rediss?:\/\/./.test(url);
}

/** 检查 Redis 可连接性；返回问题列表。 */
export async function checkRedis(
  env: JudgeEnv,
  runner: CommandRunner = realRunner(),
): Promise<string[]> {
  const issues: string[] = [];
  const url = envValue(env, "REDIS_URL") ?? "";
  const checkUrlConfig = envValue(env, "REDIS_CHECK_URL") ?? "";

  if (!isRedisUrl(url)) {
    issues.push("REDIS_URL 必须使用 redis:// 或 rediss://");
  }
  const checkUrl = checkUrlConfig === "" ? url : checkUrlConfig;
  if (!isRedisUrl(checkUrl)) {
    issues.push("REDIS_CHECK_URL 必须使用 redis:// 或 rediss://");
  }
  if (issues.length > 0) return issues;

  let redisCliAvailable = false;
  try {
    const probe = await runner.run("redis-cli", ["--version"]);
    redisCliAvailable = probe.code === 0;
  } catch {
    redisCliAvailable = false;
  }

  let ok = false;
  if (redisCliAvailable) {
    try {
      const ping = await runner.run("redis-cli", ["-u", checkUrl, "ping"]);
      ok = ping.code === 0;
    } catch {
      ok = false;
    }
  } else {
    let envFile = "";
    try {
      envFile = Deno.makeTempFileSync({
        prefix: "noj-judge-redis-check.",
        suffix: "",
      });
      Deno.writeTextFileSync(envFile, `REDIS_URL=${checkUrl}\n`);
      Deno.chmodSync(envFile, 0o600);
      const docker = await runner.run(
        "docker",
        [
          "run",
          "--rm",
          "--network",
          "host",
          "--env-file",
          envFile,
          "redis:7-alpine",
          "sh",
          "-c",
          'redis-cli -u "$REDIS_URL" ping',
        ],
      );
      ok = docker.code === 0;
    } catch {
      ok = false;
    } finally {
      if (envFile !== "") {
        try {
          Deno.removeSync(envFile);
        } catch {
          // 临时文件清理失败可忽略
        }
      }
    }
  }

  if (!ok) {
    issues.push(`Redis 连接失败：${redisHost(checkUrl)}（密码不会显示）`);
  }
  return issues;
}

/** 检查 Worker 镜像架构与当前主机是否匹配；返回问题列表。 */
export async function checkImageArchitecture(
  env: JudgeEnv,
  runner: CommandRunner = realRunner(),
): Promise<string[]> {
  const issues: string[] = [];
  const machine = (
    await unameValue(runner, "-m", Deno.build.arch)
  ).toLowerCase();
  const expected = expectedArch(machine);
  if (expected === undefined) {
    issues.push(
      `不支持的 CPU 架构：${machine}（当前支持 x86_64/amd64 与 ARM64）`,
    );
    return issues;
  }

  const registry = envValue(env, "JUDGE_IMAGE_REGISTRY") ?? "";
  const version = envValue(env, "NOJ_VERSION") ?? "";
  const image = `${registry}/noj-judge:${version}`;

  let localArch = "";
  try {
    const inspect = await runner.run(
      "docker",
      ["image", "inspect", image, "--format", "{{.Architecture}}"],
    );
    if (inspect.code === 0) localArch = inspect.stdout.trim();
  } catch {
    localArch = "";
  }
  if (localArch !== "") {
    if (localArch !== expected) {
      issues.push(
        `本地 Worker 镜像架构为 ${localArch}，当前主机需要 ${expected}：${image}`,
      );
    }
    return issues;
  }

  try {
    const inspect = await runner.run(
      "docker",
      ["buildx", "imagetools", "inspect", image],
    );
    if (inspect.code === 0) {
      const details = `${inspect.stdout}\n${inspect.stderr}`;
      const pattern = new RegExp(
        `linux/${expected}|Architecture:\\s+${expected}`,
        "i",
      );
      if (!pattern.test(details)) {
        issues.push(
          `Worker 镜像没有当前主机架构 linux/${expected}：${image}`,
        );
      }
    } else {
      console.warn(
        `无法预先读取 Worker manifest，将由 docker pull 报告网络、认证或架构错误：${image}`,
      );
    }
  } catch {
    console.warn(
      `无法预先读取 Worker manifest，将由 docker pull 报告网络、认证或架构错误：${image}`,
    );
  }
  return issues;
}
