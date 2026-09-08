import type { CommandRunner } from "../runtime/command.ts";
import { realRunner } from "../runtime/command.ts";
import type { PromptIO } from "../tui/io.ts";
import { realIO } from "../tui/io.ts";
import { input, secretInput, select } from "../tui/widgets.ts";
import { fileExists } from "../util/fs.ts";
import {
  checkBaseEnvironment,
  checkConfigValues,
  checkImageArchitecture,
  checkRedis,
  checkSocket,
} from "./checks.ts";
import { composeArgs, runJudgeCompose, writeJudgeCompose } from "./compose.ts";
import type { JudgeEnv } from "./env.ts";
import { envValue, loadJudgeEnv, saveJudgeEnv, setJudgeEnv } from "./env.ts";
import type { JudgeOptions } from "./options.ts";
import { createLocalRedis, redisConnectionFiles } from "./redis.ts";

/** 显式 stat 读取文件权限位；文件不存在或不可 stat 时直接抛错。 */
function statFileMode(path: string): number {
  return Deno.statSync(path).mode ?? 0;
}

/** 生成初始化 .env.judge 所需的默认值；非交互必填项缺失时报错。 */
function baseEnvValues(opts: JudgeOptions): Record<string, string> {
  const get = (key: string): string | undefined => Deno.env.get(key);
  const optional = (key: string, fallback: string): string =>
    get(key) ?? fallback;
  const redisUrl = get("REDIS_URL") ?? "";

  return {
    NOJ_VERSION: opts.version ?? get("NOJ_VERSION") ?? "",
    REDIS_URL: redisUrl,
    REDIS_CHECK_URL: optional("REDIS_CHECK_URL", redisUrl),
    REDIS_SOURCE: optional("REDIS_SOURCE", "existing"),
    JUDGE_QUEUE: optional("JUDGE_QUEUE", "noj:judge:queue"),
    RESULT_QUEUE: optional("RESULT_QUEUE", "noj:judge:results"),
    WORK_DIR: optional("WORK_DIR", "/tmp/noj-judge"),
    JUDGE_MAX_CONCURRENT_JUDGES: optional("JUDGE_MAX_CONCURRENT_JUDGES", "2"),
    JUDGE_IMAGE_PREFIX: optional("JUDGE_IMAGE_PREFIX", "noj-"),
    JUDGE_IMAGE_REGISTRY: optional("JUDGE_IMAGE_REGISTRY", "ghcr.io/neuro-oj"),
    JUDGE_DOCKER_SOCKET: get("JUDGE_DOCKER_SOCKET") ?? "",
    JUDGE_DOCKER_SOCKET_GID: get("JUDGE_DOCKER_SOCKET_GID") ?? "",
    JUDGE_DOCKER_HOST: "unix:///run/noj-judge/docker.sock",
    JUDGE_REQUIRE_ISOLATED_DOCKER: "true",
    JUDGE_UID: optional("JUDGE_UID", "10001"),
    JUDGE_GID: optional("JUDGE_GID", "10001"),
    JUDGE_CPU_LIMIT_MILLICORES: optional("JUDGE_CPU_LIMIT_MILLICORES", "1000"),
    JUDGE_MAX_EVALUATOR_TIME_MS: optional(
      "JUDGE_MAX_EVALUATOR_TIME_MS",
      "300000",
    ),
    JUDGE_MAX_SOLUTION_CALL_TIMEOUT_MS: optional(
      "JUDGE_MAX_SOLUTION_CALL_TIMEOUT_MS",
      "60000",
    ),
    JUDGE_COMMAND_WHITELIST: optional(
      "JUDGE_COMMAND_WHITELIST",
      "python3,deno,node,bash,sh",
    ),
    JUDGE_ALLOW_EVALUATOR_NETWORK: optional(
      "JUDGE_ALLOW_EVALUATOR_NETWORK",
      "false",
    ),
    JUDGE_EVALUATOR_NETWORK: optional("JUDGE_EVALUATOR_NETWORK", "bridge"),
    JUDGE_ALLOW_HTTP_S3: optional("JUDGE_ALLOW_HTTP_S3", "false"),
    SUPPORT_PACKAGE_DOWNLOAD_TIMEOUT: optional(
      "SUPPORT_PACKAGE_DOWNLOAD_TIMEOUT",
      "60",
    ),
    SUPPORT_CACHE_DIR: optional(
      "SUPPORT_CACHE_DIR",
      "/tmp/noj-judge/support-cache",
    ),
    SUPPORT_CACHE_MAX_ITEMS: optional("SUPPORT_CACHE_MAX_ITEMS", "500"),
    SUPPORT_CACHE_MAX_MB: optional("SUPPORT_CACHE_MAX_MB", "2048"),
  };
}

/** 非交互安装：必填项缺失时直接报错。 */
function nonInteractiveEnvValues(opts: JudgeOptions): Record<string, string> {
  const values = baseEnvValues(opts);
  const requireValue = (key: string): void => {
    if ((values[key] ?? "").trim() !== "") return;
    throw new Error(`非交互安装缺少必填配置：${key}`);
  };
  requireValue("NOJ_VERSION");
  requireValue("REDIS_URL");
  requireValue("JUDGE_DOCKER_SOCKET");
  requireValue("JUDGE_DOCKER_SOCKET_GID");
  return values;
}

/** 交互式读取配置项：环境变量已存在时跳过，否则按默认值提示。 */
async function promptValue(
  io: PromptIO,
  key: string,
  label: string,
  defaultValue?: string,
  options?: { secret?: boolean; hint?: string },
): Promise<string> {
  const fromEnv = Deno.env.get(key)?.trim();
  if (fromEnv) return fromEnv;
  if (options?.hint) io.write(`  说明：${options.hint}\n`);
  if (options?.secret) {
    return secretInput(io, `  ${label}`);
  }
  while (true) {
    const raw = await input(io, `  ${label}`, defaultValue);
    if (raw.trim() !== "") return raw.trim();
    io.write("输入不能为空，请重试。\n");
  }
}

/** Redis 交互配置：已有环境变量、已有 Redis / 本机 Redis / 稍后配置。 */
async function promptRedis(
  io: PromptIO,
  opts: JudgeOptions,
  runner: CommandRunner,
): Promise<{ url: string; checkUrl: string; source: string }> {
  const existingUrl = Deno.env.get("REDIS_URL")?.trim();
  if (existingUrl) {
    return {
      url: existingUrl,
      checkUrl: Deno.env.get("REDIS_CHECK_URL")?.trim() || existingUrl,
      source: "existing",
    };
  }

  io.write("\n配置 Redis\n");
  io.write("Redis 是 noj-core 和 Judge 之间传递评测任务的中转站。\n");
  io.write(
    "Judge 必须连接 noj-core 正在使用的同一个 Redis、数据库和队列。\n\n",
  );
  const choice = await select(io, "请选择 Redis 来源", [
    "连接已有 Redis（推荐，适合生产环境）",
    "创建本机 Redis（仅适合明确知道 core 也要使用它的场景）",
    "稍后配置（本次不会启动 Judge）",
  ]);
  switch (choice) {
    case 0: {
      const url = await secretInput(io, "  Redis 完整连接地址");
      return { url, checkUrl: url, source: "existing" };
    }
    case 1: {
      await createLocalRedis(opts, runner);
      const { metadata } = redisConnectionFiles(opts);
      const meta = loadJudgeEnv(metadata);
      const runtimeUrl = envValue(meta, "REDIS_RUNTIME_URL") ?? "";
      const checkUrl = envValue(meta, "REDIS_CHECK_URL") ?? "";
      if (!runtimeUrl || !checkUrl) {
        throw new Error(`本机 Redis 连接信息不完整：${metadata}`);
      }
      return { url: runtimeUrl, checkUrl, source: "local" };
    }
    default:
      throw new Error(
        "已选择稍后配置；请配置与 noj-core 相同的 REDIS_URL 后重新执行 install",
      );
  }
}

/** 交互式生成 .env.judge 的完整配置值。 */
async function interactiveEnvValues(
  io: PromptIO,
  opts: JudgeOptions,
  runner: CommandRunner,
): Promise<Record<string, string>> {
  const values = baseEnvValues(opts);

  values.NOJ_VERSION = opts.version ??
    await promptValue(
      io,
      "NOJ_VERSION",
      "Worker 版本（例如 0.8.0-rc.1）",
      undefined,
      {
        hint: "填已发布的镜像版本，不要填写 main 或 latest。",
      },
    );
  const redis = await promptRedis(io, opts, runner);
  values.REDIS_URL = redis.url;
  values.REDIS_CHECK_URL = redis.checkUrl;
  values.REDIS_SOURCE = redis.source;
  values.JUDGE_QUEUE = await promptValue(
    io,
    "JUDGE_QUEUE",
    "任务队列名称",
    "noj:judge:queue",
    { hint: "必须与 noj-core 的任务队列名称一致，通常直接回车。" },
  );
  values.RESULT_QUEUE = await promptValue(
    io,
    "RESULT_QUEUE",
    "结果队列名称",
    "noj:judge:results",
    { hint: "必须与 noj-core 的结果队列名称一致，通常直接回车。" },
  );
  values.WORK_DIR = await promptValue(
    io,
    "WORK_DIR",
    "Worker 容器工作目录",
    "/tmp/noj-judge",
    { hint: "容器内部目录，通常直接回车。" },
  );
  values.JUDGE_MAX_CONCURRENT_JUDGES = await promptValue(
    io,
    "JUDGE_MAX_CONCURRENT_JUDGES",
    "最大并发评测数",
    "2",
    { hint: "同时运行的评测数量；机器资源较少时可填写 1。" },
  );
  values.JUDGE_IMAGE_PREFIX = await promptValue(
    io,
    "JUDGE_IMAGE_PREFIX",
    "评测镜像前缀",
    "noj-",
    { hint: "题目运行时镜像的前缀，通常直接回车。" },
  );
  values.JUDGE_IMAGE_REGISTRY = await promptValue(
    io,
    "JUDGE_IMAGE_REGISTRY",
    "Worker 镜像仓库",
    "ghcr.io/neuro-oj",
    { hint: "Worker 镜像所在仓库，不要填写末尾的 /noj-judge。" },
  );
  values.JUDGE_DOCKER_SOCKET = await promptValue(
    io,
    "JUDGE_DOCKER_SOCKET",
    "专用 Docker socket 路径",
    "/run/noj-judge/docker.sock",
    { hint: "必须是 Judge 专用 rootless socket，不能使用宿主机共享 socket。" },
  );
  values.JUDGE_DOCKER_SOCKET_GID = await promptValue(
    io,
    "JUDGE_DOCKER_SOCKET_GID",
    "Docker socket 所属组 GID",
    "10001",
    {
      hint:
        "可用 stat -c '%g' /run/noj-judge/docker.sock 查询；必须与 socket 实际 GID 一致。",
    },
  );
  values.JUDGE_UID = await promptValue(
    io,
    "JUDGE_UID",
    "Worker 用户 UID",
    "10001",
    { hint: "容器内非 root 用户，通常直接回车。" },
  );
  values.JUDGE_GID = await promptValue(
    io,
    "JUDGE_GID",
    "Worker 用户 GID",
    "10001",
    { hint: "容器内非 root 用户组，通常直接回车。" },
  );

  return values;
}

/**
 * 初始化 Judge 环境文件。
 * 已有配置时保留并视需要更新 NOJ_VERSION；dry-run 时不写文件；
 * 文件缺失且非 dry-run 时按非交互环境变量或交互提示生成配置。
 */
async function initializeJudgeEnv(
  opts: JudgeOptions,
  runner: CommandRunner,
  io: PromptIO,
): Promise<void> {
  const envExists = await fileExists(opts.envFile);

  if (opts.dryRun) {
    if (envExists) {
      console.log(`[dry-run] 保留已有配置：${opts.envFile}`);
    } else {
      console.log(`[dry-run] 将创建配置：${opts.envFile}`);
    }
    return;
  }

  if (envExists) {
    Deno.chmodSync(opts.envFile, 0o600);
    console.log(`保留已有配置：${opts.envFile}`);
    if (opts.version !== undefined) {
      setJudgeEnv(opts.envFile, "NOJ_VERSION", opts.version);
    }
    return;
  }

  Deno.mkdirSync(opts.dir, { recursive: true });
  const values = opts.nonInteractive
    ? nonInteractiveEnvValues(opts)
    : await interactiveEnvValues(io, opts, runner);
  saveJudgeEnv(opts.envFile, values);
  console.log(`已创建配置：${opts.envFile}`);
}

/** Redis 主机摘要，用于 status 输出。 */
function redisHost(env: JudgeEnv): string {
  const url = envValue(env, "REDIS_CHECK_URL") ?? envValue(env, "REDIS_URL") ??
    "";
  let rest = url.replace(/^[a-z]+:\/\//i, "");
  const at = rest.indexOf("@");
  if (at !== -1) rest = rest.slice(at + 1);
  rest = rest.split("/")[0] ?? "";
  const colon = rest.indexOf(":");
  return (colon === -1 ? rest : rest.slice(0, colon)) || "未知主机";
}

/** 执行 Judge 配置检查：文件存在性/权限、配置值、socket、Redis、镜像和 Compose。 */
async function checkJudgeConfiguration(
  opts: JudgeOptions,
  runner: CommandRunner,
): Promise<void> {
  const envExists = await fileExists(opts.envFile);
  const composeExists = await fileExists(opts.composeFile);

  if (opts.dryRun) {
    if (!envExists || !composeExists) {
      console.log("[dry-run] 跳过配置检查（配置文件尚不存在）");
      return;
    }
  } else {
    if (!envExists) {
      throw new Error(`找不到配置文件：${opts.envFile}，请先执行 install`);
    }
    if (!composeExists) {
      throw new Error(
        `找不到 Compose 配置：${opts.composeFile}，请先执行 install`,
      );
    }
  }

  if (envExists) {
    const mode = statFileMode(opts.envFile) & 0o777;
    if (mode !== 0o600 && mode !== 0o400) {
      throw new Error(`配置文件权限必须为 600 或 400：${opts.envFile}`);
    }
  }

  const env = loadJudgeEnv(opts.envFile);
  const configIssues = checkConfigValues(env);
  if (configIssues.length > 0) {
    for (const issue of configIssues) console.error(`  - ${issue}`);
    throw new Error("Judge 配置未完成，请修复上面的配置项");
  }

  const socketIssues = await checkSocket(env, runner);
  if (socketIssues.length > 0) {
    for (const issue of socketIssues) console.error(`  - ${issue}`);
    throw new Error("Judge 配置检查失败，请修复上面的配置项");
  }

  if (opts.dryRun) {
    console.log("[dry-run] 跳过 Redis、镜像和 Compose 实际连接检查");
    console.log("Judge 配置检查通过");
    return;
  }

  const redisIssues = await checkRedis(env, runner);
  if (redisIssues.length > 0) {
    for (const issue of redisIssues) console.error(`  - ${issue}`);
    throw new Error("Redis 检查失败，请修复上面的配置项");
  }

  const imageIssues = await checkImageArchitecture(env, runner);
  if (imageIssues.length > 0) {
    for (const issue of imageIssues) console.error(`  - ${issue}`);
    throw new Error("Worker 镜像架构检查失败，请修复上面的配置项");
  }

  const composeConfig = await runner.run(
    "docker",
    composeArgs(opts, ["config", "--quiet"]),
  );
  if (composeConfig.code !== 0) {
    throw new Error("独立 Judge Compose 配置无效");
  }

  console.log("Judge 配置检查通过");
}

/** install：先检查基础环境，再初始化环境 → 写 compose → 检查 → pull → up。 */
async function runInstall(
  opts: JudgeOptions,
  runner: CommandRunner,
  io: PromptIO,
): Promise<number> {
  await checkBaseEnvironment(opts, runner);
  await initializeJudgeEnv(opts, runner, io);
  writeJudgeCompose(opts.composeFile, opts.dryRun);
  await checkJudgeConfiguration(opts, runner);
  const pull = await runJudgeCompose(opts, ["pull"], runner);
  if (pull !== 0) return pull;
  return runJudgeCompose(opts, ["up", "-d", "--remove-orphans"], runner);
}

/** install-env：检查 Docker/Compose/curl 并输出 rootless 准备指引。 */
async function runInstallEnv(
  opts: JudgeOptions,
  runner: CommandRunner,
): Promise<number> {
  await checkBaseEnvironment(opts, runner);
  let curlOk = false;
  try {
    curlOk = (await runner.run("curl", ["--version"])).code === 0;
  } catch {
    curlOk = false;
  }
  if (!curlOk) {
    throw new Error("缺少依赖：curl");
  }
  console.log(
    "\n请确认已准备以下隔离条件：\n" +
      "  1. 只服务于 Judge 的 rootless Docker daemon；\n" +
      "  2. 独立 Unix socket（例如 /run/noj-judge/docker.sock）；\n" +
      "  3. Worker 用户的 UID/GID 及 socket group 权限；\n" +
      "  4. 与 noj-core 使用同一 Redis、任务队列和结果队列。\n\n" +
      "本工具不会自动安装或替换 Docker daemon，也不会把 /var/run/docker.sock 提供给 Judge。",
  );
  return 0;
}

/** check：基础环境 + 配置检查。 */
async function runCheck(
  opts: JudgeOptions,
  runner: CommandRunner,
): Promise<number> {
  await checkBaseEnvironment(opts, runner);
  await checkJudgeConfiguration(opts, runner);
  return 0;
}

/** start：检查后 compose up。 */
async function runStart(
  opts: JudgeOptions,
  runner: CommandRunner,
): Promise<number> {
  await checkBaseEnvironment(opts, runner);
  await checkJudgeConfiguration(opts, runner);
  return runJudgeCompose(opts, ["up", "-d", "--remove-orphans"], runner);
}

/** stop：先确认已安装，再 compose stop。 */
async function runStop(
  opts: JudgeOptions,
  runner: CommandRunner,
): Promise<number> {
  if (!(await fileExists(opts.envFile))) {
    throw new Error(`找不到配置文件：${opts.envFile}，请先执行 install`);
  }
  return runJudgeCompose(opts, ["stop"], runner);
}

/** status：检查后打印脱敏摘要并执行 compose ps。 */
async function runStatus(
  opts: JudgeOptions,
  runner: CommandRunner,
): Promise<number> {
  await checkBaseEnvironment(opts, runner);
  await checkJudgeConfiguration(opts, runner);
  const env = loadJudgeEnv(opts.envFile);
  console.log(`版本：${envValue(env, "NOJ_VERSION") ?? ""}`);
  console.log(`Redis 主机：${redisHost(env)}`);
  console.log(`任务队列：${envValue(env, "JUDGE_QUEUE") ?? ""}`);
  console.log(`结果队列：${envValue(env, "RESULT_QUEUE") ?? ""}`);
  console.log(`Docker socket：${envValue(env, "JUDGE_DOCKER_SOCKET") ?? ""}`);
  return runJudgeCompose(opts, ["ps"], runner);
}

/** logs：先检查基础环境与已安装配置，再查看 Judge 日志。 */
async function runLogs(
  opts: JudgeOptions,
  runner: CommandRunner,
): Promise<number> {
  await checkBaseEnvironment(opts, runner);
  if (!(await fileExists(opts.envFile))) {
    throw new Error(`找不到配置文件：${opts.envFile}，请先执行 install`);
  }
  const args = ["logs", "--tail=200"];
  if (opts.follow) args.push("--follow");
  if (opts.follow && !opts.dryRun && runner.stream) {
    return runner.stream(
      "docker",
      composeArgs(opts, args),
      (line) => console.log(line),
    );
  }
  return runJudgeCompose(opts, args, runner);
}

/** upgrade：可选更新版本 → 写 compose → 检查 → pull → up。 */
async function runUpgrade(
  opts: JudgeOptions,
  runner: CommandRunner,
): Promise<number> {
  if (!(await fileExists(opts.envFile))) {
    throw new Error(`找不到配置文件：${opts.envFile}，请先执行 install`);
  }
  if (opts.version !== undefined) {
    if (opts.dryRun) {
      console.log(`[dry-run] 将更新 NOJ_VERSION=${opts.version}`);
    } else {
      setJudgeEnv(opts.envFile, "NOJ_VERSION", opts.version);
    }
  } else {
    console.log(`保留已有配置：${opts.envFile}`);
  }

  writeJudgeCompose(opts.composeFile, opts.dryRun);
  await checkBaseEnvironment(opts, runner);
  await checkJudgeConfiguration(opts, runner);
  const pull = await runJudgeCompose(opts, ["pull"], runner);
  if (pull !== 0) return pull;
  return runJudgeCompose(opts, ["up", "-d", "--remove-orphans"], runner);
}

/** download：下载 judge-install.sh 到目标目录（保留脚本兜底）。 */
async function downloadJudgeScript(
  opts: JudgeOptions,
  runner: CommandRunner,
): Promise<number> {
  const repoPattern = /^https:\/\/github\.com\/[^/]+\/[^/]+?\/?$/;
  if (!repoPattern.test(opts.repo)) {
    throw new Error("--repo 目前只支持 https://github.com/组织/仓库");
  }
  const slug = opts.repo
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\/$/, "")
    .replace(/\.git$/, "");
  const url =
    `https://raw.githubusercontent.com/${slug}/${opts.ref}/scripts/deploy/judge-install.sh`;
  const target = `${opts.dir}/judge-install.sh`;

  if (opts.dryRun) {
    console.log(`[dry-run] 将下载部署脚本：${url} -> ${target}`);
    return 0;
  }

  Deno.mkdirSync(opts.dir, { recursive: true });
  const tmp = `${opts.dir}/.judge-install.${crypto.randomUUID()}`;
  const curl = await runner.run("curl", [
    "-fsSL",
    "--retry",
    "3",
    url,
    "-o",
    tmp,
  ]);
  if (curl.code !== 0) {
    await Deno.remove(tmp).catch(() => {});
    throw new Error(`下载部署脚本失败，请检查仓库、ref 和网络：${url}`);
  }

  const bash = await runner.run("bash", ["-n", tmp]);
  if (bash.code !== 0) {
    await Deno.remove(tmp).catch(() => {});
    throw new Error(`下载内容不是有效 Bash 脚本：${url}`);
  }

  await Deno.chmod(tmp, 0o700);
  await Deno.rename(tmp, target);
  console.log(`已下载部署脚本：${target}`);
  return 0;
}

/**
 * Judge 命令聚合入口。
 * 依据 `scripts/deploy/judge-install.sh` 的 main() 映射到各命令实现；
 * 返回 0 或非零退出码，错误统一打印 `judge: ...`。
 */
export async function runJudgeCommand(
  opts: JudgeOptions,
  runner: CommandRunner = realRunner(),
  io: PromptIO = realIO(),
): Promise<number> {
  try {
    if (opts.downloadOnly || opts.command === "download") {
      return await downloadJudgeScript(opts, runner);
    }
    switch (opts.command) {
      case "install":
        return await runInstall(opts, runner, io);
      case "install-env":
        return await runInstallEnv(opts, runner);
      case "check":
        return await runCheck(opts, runner);
      case "start":
        return await runStart(opts, runner);
      case "stop":
        return await runStop(opts, runner);
      case "status":
        return await runStatus(opts, runner);
      case "logs":
        return await runLogs(opts, runner);
      case "upgrade":
        return await runUpgrade(opts, runner);
      default:
        throw new Error(`未知 judge 命令: ${opts.command}`);
    }
  } catch (e) {
    console.error(`judge: ${(e as Error).message}`);
    return 1;
  }
}
