import type { CommandRunner } from "../runtime/command.ts";
import { realRunner } from "../runtime/command.ts";
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

/** 读取文件权限低位，文件不存在时返回 0。 */
function fileMode(path: string): number {
  try {
    return Deno.statSync(path).mode ?? 0;
  } catch {
    return 0;
  }
}

/** 生成初始化 .env.judge 所需的默认值；非交互必填项缺失时报错。 */
function initialEnvValues(opts: JudgeOptions): Record<string, string> {
  const get = (key: string): string | undefined => Deno.env.get(key);
  const requireValue = (key: string, value: string | undefined): string => {
    if (value !== undefined && value.trim() !== "") return value;
    throw new Error(`非交互安装缺少必填配置：${key}`);
  };
  const optional = (key: string, fallback: string): string =>
    get(key) ?? fallback;

  const version = requireValue(
    "NOJ_VERSION",
    opts.version ?? get("NOJ_VERSION"),
  );
  const redisUrl = requireValue("REDIS_URL", get("REDIS_URL"));
  const socket = requireValue(
    "JUDGE_DOCKER_SOCKET",
    get("JUDGE_DOCKER_SOCKET"),
  );
  const socketGid = requireValue(
    "JUDGE_DOCKER_SOCKET_GID",
    get("JUDGE_DOCKER_SOCKET_GID"),
  );

  return {
    NOJ_VERSION: version,
    REDIS_URL: redisUrl,
    REDIS_CHECK_URL: optional("REDIS_CHECK_URL", redisUrl),
    REDIS_SOURCE: optional("REDIS_SOURCE", "existing"),
    JUDGE_QUEUE: optional("JUDGE_QUEUE", "noj:judge:queue"),
    RESULT_QUEUE: optional("RESULT_QUEUE", "noj:judge:results"),
    WORK_DIR: optional("WORK_DIR", "/tmp/noj-judge"),
    JUDGE_MAX_CONCURRENT_JUDGES: optional("JUDGE_MAX_CONCURRENT_JUDGES", "2"),
    JUDGE_IMAGE_PREFIX: optional("JUDGE_IMAGE_PREFIX", "noj-"),
    JUDGE_IMAGE_REGISTRY: optional("JUDGE_IMAGE_REGISTRY", "ghcr.io/neuro-oj"),
    JUDGE_DOCKER_SOCKET: socket,
    JUDGE_DOCKER_SOCKET_GID: socketGid,
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

/**
 * 初始化 Judge 环境文件。
 * 已有配置时保留并视需要更新 NOJ_VERSION；dry-run 时不写文件；
 * 文件缺失且非 dry-run 时从环境变量/默认值生成配置。
 */
function initializeJudgeEnv(opts: JudgeOptions): void {
  const envExists = fileMode(opts.envFile) !== 0;

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

  if (!opts.nonInteractive) {
    throw new Error(
      "交互式安装尚未实现，请使用 --non-interactive 并提供环境变量，或预先创建 .env.judge",
    );
  }

  Deno.mkdirSync(opts.dir, { recursive: true });
  saveJudgeEnv(opts.envFile, initialEnvValues(opts));
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
    const mode = fileMode(opts.envFile) & 0o777;
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

/** install：初始化环境 → 写 compose → 检查 → pull → up。 */
async function runInstall(
  opts: JudgeOptions,
  runner: CommandRunner,
): Promise<number> {
  initializeJudgeEnv(opts);
  writeJudgeCompose(opts.composeFile, opts.dryRun);
  await checkBaseEnvironment(opts, runner);
  await checkJudgeConfiguration(opts, runner);
  const pull = await runJudgeCompose(opts, ["pull"], runner);
  if (pull !== 0) return pull;
  return runJudgeCompose(opts, ["up", "-d", "--remove-orphans"], runner);
}

/** install-env：检查 Docker/Compose 并输出 rootless 准备指引。 */
async function runInstallEnv(
  opts: JudgeOptions,
  runner: CommandRunner,
): Promise<number> {
  await checkBaseEnvironment(opts, runner);
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

/** stop：compose stop。 */
function runStop(
  opts: JudgeOptions,
  runner: CommandRunner,
): Promise<number> {
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

/** logs：查看 Judge 日志，可选 --follow。 */
function runLogs(
  opts: JudgeOptions,
  runner: CommandRunner,
): Promise<number> {
  const args = ["logs", "--tail=200"];
  if (opts.follow) args.push("--follow");
  if (opts.follow && runner.stream) {
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
  const envExists = await fileExists(opts.envFile);
  if (envExists) {
    if (opts.version !== undefined) {
      setJudgeEnv(opts.envFile, "NOJ_VERSION", opts.version);
    } else {
      console.log(`保留已有配置：${opts.envFile}`);
    }
  } else if (opts.dryRun) {
    console.log(`[dry-run] 跳过配置更新：${opts.envFile} 不存在`);
  } else {
    throw new Error(`找不到配置文件：${opts.envFile}，请先执行 install`);
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
): Promise<number> {
  try {
    if (opts.downloadOnly || opts.command === "download") {
      return await downloadJudgeScript(opts, runner);
    }
    switch (opts.command) {
      case "install":
        return await runInstall(opts, runner);
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
