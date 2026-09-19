/**
 * `docker-compose.judge.yml` 的渲染与 socket 连接校验（T21）。
 *
 * 迁移 `judge-install.sh` 的 `write_compose()`（:582-637）、`check_socket()`
 * （:695-717）、`check_redis()`（:728-752）、`image_name()`/`local_image_arch()`/
 * `check_image_architecture()`（:753-789）。
 *
 * ## 为什么渲染是**纯函数**
 *
 * bash 的 `write_compose` 用 heredoc 生成 YAML，服务集合、环境变量默认值、卷、
 * 安全选项全部内联在文本里——要验证"渲染结果是否与 bash 一致"只能起容器或
 * 逐行 diff。本模块把它做成 `(env) => string`，于是：
 * - "socket 挂载必须是 `:ro`"、"不得映射多余端口"、"cap_drop ALL 必须在"这类
 *   **安全属性**可以用字符串断言直接锁住；
 * - 测试无需 docker。
 *
 * ## 渲染出的安全属性（逐条都有断言）
 *
 * | 属性 | 为什么 |
 * | --- | --- |
 * | socket 挂载 `:ro` | Judge 只需与 rootless daemon 通信，不需要写 socket 文件本身 |
 * | `cap_drop: ALL` | 容器内不应有任何 capability |
 * | `no-new-privileges:true` | 阻止 setuid 提权 |
 * | `read_only: true` + `tmpfs: /tmp` | 根文件系统只读；可写面收敛到 tmpfs 与卷 |
 * | `user: UID:GID`（非 root） | 评测代码不应以 root 运行 |
 * | `JUDGE_REQUIRE_ISOLATED_DOCKER: "true"` | 硬编码，不接受配置覆盖 |
 * | 无 `ports:` | Judge 是消费者（拉队列），不需要对外暴露端口 |
 *
 * 本模块不持有模块级可变状态（AGENTS.md §8.2 多副本约束）。
 */

import { isAbsolute } from "@std/path";
import type { CommandRunner } from "../../runtime/command.ts";
import { UsageError } from "../../util/args.ts";
import {
  assertDedicatedSocket,
  JUDGE_SOCKET_CONTAINER_PATH,
  type JudgePaths,
} from "./config.ts";

/** Compose 里 judge 服务的镜像（bash `:589` 的默认 registry）。 */
export const DEFAULT_JUDGE_IMAGE_REGISTRY = "ghcr.io/neuro-oj";

/** 渲染环境变量的默认值（bash `:591-612` 的 `${VAR:-default}` 逐字）。 */
export const COMPOSE_ENV_DEFAULTS: Readonly<Record<string, string>> = {
  JUDGE_QUEUE: "noj:judge:queue",
  RESULT_QUEUE: "noj:judge:results",
  JUDGE_PRIORITY_POLL_TIMEOUT_MS: "100",
  WORK_DIR: "/tmp/noj-judge",
  JUDGE_MAX_CONCURRENT_JUDGES: "2",
  JUDGE_CPU_LIMIT_MILLICORES: "1000",
  JUDGE_MAX_EVALUATOR_TIME_MS: "300000",
  JUDGE_MAX_SOLUTION_CALL_TIMEOUT_MS: "60000",
  JUDGE_IMAGE_PREFIX: "noj-",
  JUDGE_COMMAND_WHITELIST: "python3,deno,node,bash,sh",
  JUDGE_ALLOW_EVALUATOR_NETWORK: "false",
  JUDGE_EVALUATOR_NETWORK: "bridge",
  JUDGE_ALLOW_HTTP_S3: "false",
  SUPPORT_PACKAGE_DOWNLOAD_TIMEOUT: "60",
  SUPPORT_CACHE_DIR: "/tmp/noj-judge/support-cache",
  SUPPORT_CACHE_MAX_ITEMS: "500",
  SUPPORT_CACHE_MAX_MB: "2048",
};

/**
 * 渲染 `docker-compose.judge.yml`（bash `write_compose` :588-636 的等价）。
 *
 * 输出**逐字对齐** bash 的 heredoc（含缩进与键序）：运维会按这个形状读文件，
 * 且 diff 友好性能让升级时的变更一目了然。缺省值取自
 * {@link COMPOSE_ENV_DEFAULTS}，必填项（`NOJ_VERSION`/`REDIS_URL`/
 * `JUDGE_DOCKER_SOCKET`/`JUDGE_DOCKER_SOCKET_GID`）缺失时**抛错**
 * （对应 bash 的 `${VAR:?…}`）。
 *
 * **Socket 安全在渲染前再校验一次**：`writeJudgeEnv` 已校验过，但渲染可能被
 * 直接调用（例如升级时从既有配置渲染）——防线不依赖调用方的纪律。
 */
export function renderJudgeCompose(env: Record<string, string>): string {
  const value = (key: string): string =>
    env[key] !== undefined && env[key] !== ""
      ? env[key]!
      : COMPOSE_ENV_DEFAULTS[key] ?? "";

  const require = (key: string): string => {
    const v = env[key] ?? "";
    if (v === "") {
      throw new UsageError(`渲染 Judge Compose 缺少必填项：${key}`);
    }
    return v;
  };

  const socketPath = require("JUDGE_DOCKER_SOCKET");
  assertDedicatedSocket(socketPath);

  const version = require("NOJ_VERSION");
  const redisUrl = require("REDIS_URL");
  const socketGid = require("JUDGE_DOCKER_SOCKET_GID");
  const registry = env["JUDGE_IMAGE_REGISTRY"] !== undefined &&
      env["JUDGE_IMAGE_REGISTRY"] !== ""
    ? env["JUDGE_IMAGE_REGISTRY"]!
    : DEFAULT_JUDGE_IMAGE_REGISTRY;
  const uid = env["JUDGE_UID"] !== undefined && env["JUDGE_UID"] !== ""
    ? env["JUDGE_UID"]!
    : "10001";
  const gid = env["JUDGE_GID"] !== undefined && env["JUDGE_GID"] !== ""
    ? env["JUDGE_GID"]!
    : "10001";
  const dockerHost = env["JUDGE_DOCKER_HOST"] !== undefined &&
      env["JUDGE_DOCKER_HOST"] !== ""
    ? env["JUDGE_DOCKER_HOST"]!
    : "unix://" + JUDGE_SOCKET_CONTAINER_PATH;

  return `services:
  judge:
    image: "${registry}/noj-judge:${version}"
    environment:
      REDIS_URL: "${redisUrl}"
      JUDGE_QUEUE: "${value("JUDGE_QUEUE")}"
      RESULT_QUEUE: "${value("RESULT_QUEUE")}"
      JUDGE_PRIORITY_POLL_TIMEOUT_MS: "${
    value("JUDGE_PRIORITY_POLL_TIMEOUT_MS")
  }"
      WORK_DIR: "${value("WORK_DIR")}"
      JUDGE_MAX_CONCURRENT_JUDGES: "${value("JUDGE_MAX_CONCURRENT_JUDGES")}"
      JUDGE_CPU_LIMIT_MILLICORES: "${value("JUDGE_CPU_LIMIT_MILLICORES")}"
      JUDGE_MAX_EVALUATOR_TIME_MS: "${value("JUDGE_MAX_EVALUATOR_TIME_MS")}"
      JUDGE_MAX_SOLUTION_CALL_TIMEOUT_MS: "${
    value("JUDGE_MAX_SOLUTION_CALL_TIMEOUT_MS")
  }"
      JUDGE_IMAGE_PREFIX: "${value("JUDGE_IMAGE_PREFIX")}"
      JUDGE_COMMAND_WHITELIST: "${value("JUDGE_COMMAND_WHITELIST")}"
      JUDGE_ALLOW_EVALUATOR_NETWORK: "${value("JUDGE_ALLOW_EVALUATOR_NETWORK")}"
      JUDGE_EVALUATOR_NETWORK: "${value("JUDGE_EVALUATOR_NETWORK")}"
      JUDGE_ALLOW_HTTP_S3: "${value("JUDGE_ALLOW_HTTP_S3")}"
      JUDGE_DOCKER_HOST: "${dockerHost}"
      JUDGE_REQUIRE_ISOLATED_DOCKER: "true"
      SUPPORT_PACKAGE_DOWNLOAD_TIMEOUT: "${
    value("SUPPORT_PACKAGE_DOWNLOAD_TIMEOUT")
  }"
      SUPPORT_CACHE_DIR: "${value("SUPPORT_CACHE_DIR")}"
      SUPPORT_CACHE_MAX_ITEMS: "${value("SUPPORT_CACHE_MAX_ITEMS")}"
      SUPPORT_CACHE_MAX_MB: "${value("SUPPORT_CACHE_MAX_MB")}"
    volumes:
      - "${socketPath}:${JUDGE_SOCKET_CONTAINER_PATH}:ro"
      - judge-cache:/tmp/noj-judge
    user: "${uid}:${gid}"
    group_add:
      - "${socketGid}"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    restart: unless-stopped

volumes:
  judge-cache:
    name: noj-judge-standalone-cache
`;
}

/** 构造 `docker compose … judge` 的**纯参数数组**（bash `run_compose` :810-820）。 */
export function judgeComposeArgs(
  paths: JudgePaths,
  command: string[],
  projectName = "noj-judge-standalone",
): string[] {
  return [
    "compose",
    "--project-name",
    projectName,
    "--env-file",
    paths.envFile,
    "-f",
    paths.composeFile,
    ...command,
  ];
}

// ---------------- socket 连通性与 GID ----------------.

/** {@link checkStandaloneJudgeSocket} 的注入点。 */
export interface JudgeSocketCheckOptions {
  runner: CommandRunner;
  dockerBin?: string;
  /** socket GID 读取（`stat -c '%g'` 的等价）。 */
  socketGid?: (path: string) => Promise<number | null>;
  /** socket 权限读取（`stat -c '%a'` 的等价）。 */
  socketMode?: (path: string) => Promise<string | null>;
  /** 文件类型判定（`-S` 的等价）。 */
  isSocket?: (path: string) => Promise<boolean>;
  /** 读写权限判定（`-r -w` 的等价）。 */
  isReadWritable?: (path: string) => Promise<boolean>;
}

/** {@link checkStandaloneJudgeSocket} 的结果。 */
export interface JudgeSocketCheckResult {
  ok: boolean;
  error: string | null;
  /** 成功时的诊断信息（GID / 权限），供 `status` 展示。 */
  detail: string | null;
}

/**
 * 校验**独立 Judge** 的专用 rootless Docker socket 可用
 * （bash `judge-install.sh:check_socket` :695-717 的等价）。
 *
 * 命名带 `Standalone` 前缀是**必须**的：`prod/config.ts` 已有同名的
 * `checkJudgeSocket`（那一个校验的是**生产 compose 里**的 judge socket 挂载），
 * 两者的配置来源与判定都不同。同名会让包入口的再导出撞名——而撞名正是
 * 双模态遗留问题的表征，不该靠"少导出一个"来掩盖。
 *
 * 检查顺序与 bash 一致，且**共享 socket 的拒绝在最前**：
 * 1. 共享宿主 socket → 拒绝（{@link assertDedicatedSocket}，含 realpath 归一）；
 * 2. 绝对路径、不含 `:`（Unix socket 而非 TCP endpoint）；
 * 3. 是 Unix socket（`-S`）；
 * 4. 当前用户可读写（`-r -w`）；
 * 5. 实际 GID 与 `JUDGE_DOCKER_SOCKET_GID` 一致（不一致会让容器内的非 root
 *    用户**没有权限访问 socket**，表现为运行期才暴露的连接失败）；
 * 6. 经 `DOCKER_HOST=unix://<path> docker info` 确认 rootless daemon 可连接。
 *
 * 任一条失败返回 `ok:false` 并给出**可操作**的错误（第 6 条附 rootless 准备指引）。
 */
export async function checkStandaloneJudgeSocket(
  env: Record<string, string>,
  opts: JudgeSocketCheckOptions,
): Promise<JudgeSocketCheckResult> {
  const socketPath = (env["JUDGE_DOCKER_SOCKET"] ?? "").trim();
  const dockerBin = opts.dockerBin ?? "docker";

  try {
    assertDedicatedSocket(socketPath);
  } catch (err) {
    return { ok: false, error: (err as Error).message, detail: null };
  }

  const isSock = opts.isSocket ?? defaultIsSocket;
  const readWrite = opts.isReadWritable ?? defaultIsReadWritable;
  const readGid = opts.socketGid ?? defaultSocketGid;
  const readMode = opts.socketMode ?? defaultSocketMode;

  if (!(await isSock(socketPath))) {
    return {
      ok: false,
      error: `专用 Docker socket 不存在或不是 Unix socket：${socketPath}`,
      detail: null,
    };
  }
  if (!(await readWrite(socketPath))) {
    return {
      ok: false,
      error: `当前用户无法读写专用 Docker socket：${socketPath}`,
      detail: null,
    };
  }

  const actualGid = await readGid(socketPath);
  const configuredGid = env["JUDGE_DOCKER_SOCKET_GID"] ?? "";
  if (
    actualGid !== null && configuredGid !== "" &&
    String(actualGid) !== configuredGid
  ) {
    return {
      ok: false,
      error: `Docker socket GID=${actualGid} 与配置 JUDGE_DOCKER_SOCKET_GID=` +
        `${configuredGid} 不一致（可用 stat -c '%g' ${socketPath} 查询）`,
      detail: null,
    };
  }

  // 用**目标 socket** 探一次 daemon：这是唯一能证明 rootless daemon 真的在跑
  // 且能被访问的方式。`DOCKER_HOST` 经 env 传入，不拼进命令行。
  let code: number;
  try {
    const res = await opts.runner.run(dockerBin, ["info"], {
      env: { DOCKER_HOST: `unix://${socketPath}` },
    });
    code = res.code;
  } catch {
    code = 1;
  }
  if (code !== 0) {
    return {
      ok: false,
      error: `专用 rootless Docker daemon 不可连接：${socketPath}；` +
        `请先执行 install-env 准备 rootless socket`,
      detail: null,
    };
  }

  const mode = await readMode(socketPath);
  return {
    ok: true,
    error: null,
    detail: `专用 rootless Docker socket 可用（GID=${actualGid ?? "?"}，权限=${
      mode ?? "?"
    }）`,
  };
}

/** `-S` 语义：Unix socket。 */
async function defaultIsSocket(path: string): Promise<boolean> {
  try {
    const st = await Deno.stat(path);
    return st.isSocket === true;
  } catch {
    return false;
  }
}

/** `-r -w` 语义：当前用户可读写（best-effort：无法判定时视为可读）。 */
async function defaultIsReadWritable(path: string): Promise<boolean> {
  try {
    const st = await Deno.stat(path);
    const mode = (st.mode ?? 0) & 0o777;
    // 仅做权限位判断（真实的 access(2) 在 Deno 里没有绑定）。
    // 判不出来时返回 true，交由第 6 步的 `docker info` 做最终裁决——
    // 那里会真实地连接一次。
    return (mode & 0o600) !== 0 || (mode & 0o066) !== 0 || mode === 0;
  } catch {
    return false;
  }
}

/** `stat -c '%g'` 语义。 */
async function defaultSocketGid(path: string): Promise<number | null> {
  try {
    const st = await Deno.stat(path);
    return st.gid ?? null;
  } catch {
    return null;
  }
}

/** `stat -c '%a'` 语义（八进制串）。 */
async function defaultSocketMode(path: string): Promise<string | null> {
  try {
    const st = await Deno.stat(path);
    return ((st.mode ?? 0) & 0o777).toString(8).padStart(3, "0");
  } catch {
    return null;
  }
}

// ---------------- Redis 校验 ----------------

/** {@link checkJudgeRedis} 的注入点。 */
export interface JudgeRedisCheckOptions {
  runner: CommandRunner;
  dockerBin?: string;
  /** `redis-cli` 是否可用（`command -v redis-cli`）。 */
  redisCliAvailable?: boolean;
  /** 回退用的 Redis 客户端镜像。 */
  redisImage?: string;
}

/** {@link checkJudgeRedis} 的结果。 */
export interface JudgeRedisCheckResult {
  ok: boolean;
  error: string | null;
  /** 脱敏后的主机名（**绝不含口令**）。 */
  host: string | null;
}

/**
 * 校验 `REDIS_URL` 可连接（bash `check_redis` :728-752 的等价）。
 *
 * 两个实现要点：
 *
 * 1. **URL 形态先校验**：必须是 `redis://` 或 `rediss://`。这挡住"把口令写在
 *    别处"或"填了 http 地址"这类误配。
 * 2. **优先用宿主 `redis-cli`**；缺失时回退 `redis:7-alpine` 容器，且口令经
 *    **`--env-file`** 传入而非命令行参数——命令行参数会出现在 `ps` 输出里，
 *    等于把 Redis 口令广播给同机所有用户（bash `:739-747` 正是这么做的）。
 *
 * 错误信息里只出现**主机名**（{@link redisHostOf}），绝不回显口令。
 */
export async function checkJudgeRedis(
  env: Record<string, string>,
  opts: JudgeRedisCheckOptions,
): Promise<JudgeRedisCheckResult> {
  const url = env["REDIS_URL"] ?? "";
  const checkUrl = (env["REDIS_CHECK_URL"] ?? "") || url;
  if (!/^rediss?:\/\//.test(url)) {
    return {
      ok: false,
      error: `REDIS_URL 必须使用 redis:// 或 rediss://：${redactUrl(url)}`,
      host: null,
    };
  }
  if (!/^rediss?:\/\//.test(checkUrl)) {
    return {
      ok: false,
      error: `REDIS_CHECK_URL 必须使用 redis:// 或 rediss://：${
        redactUrl(checkUrl)
      }`,
      host: null,
    };
  }
  const host = redisHostOf(checkUrl);
  const dockerBin = opts.dockerBin ?? "docker";

  if (opts.redisCliAvailable === true) {
    let code: number;
    try {
      code =
        (await opts.runner.run("redis-cli", ["-u", checkUrl, "ping"])).code;
    } catch {
      code = 1;
    }
    return code === 0 ? { ok: true, error: null, host } : {
      ok: false,
      error: `Redis 连接失败：${host}（密码不会显示）`,
      host,
    };
  }

  // 回退：容器内 redis-cli。口令经 env-file 传入，**不进 argv**。
  const envFile = await Deno.makeTempFile({
    prefix: "noj-judge-redis-check-",
    suffix: ".env",
  });
  try {
    await Deno.writeTextFile(envFile, `REDIS_URL=${checkUrl}\n`);
    await Deno.chmod(envFile, 0o600);
    let code: number;
    try {
      code = (await opts.runner.run(
        dockerBin,
        [
          "run",
          "--rm",
          "--network",
          "host",
          "--env-file",
          envFile,
          opts.redisImage ?? "redis:7-alpine",
          "sh",
          "-c",
          'redis-cli -u "$REDIS_URL" ping',
        ],
      )).code;
    } catch {
      code = 1;
    }
    return code === 0 ? { ok: true, error: null, host } : {
      ok: false,
      error: `Redis 连接失败：${host}；系统未安装 redis-cli，` +
        `已尝试使用临时 Redis 客户端`,
      host,
    };
  } finally {
    await Deno.remove(envFile).catch(() => {});
  }
}

/**
 * 从 URL 提取主机名（bash `redis_host` :718-727 的等价）。
 *
 * 逐条剥掉协议、认证段、路径与端口——**只保留主机名**供错误信息使用。
 * 这个函数的存在就是为了让错误信息里永远不出现口令。
 */
export function redisHostOf(url: string): string {
  let rest = url;
  const schemeAt = rest.indexOf("://");
  if (schemeAt >= 0) rest = rest.slice(schemeAt + 3);
  const at = rest.lastIndexOf("@");
  if (at >= 0) rest = rest.slice(at + 1);
  const slash = rest.indexOf("/");
  if (slash >= 0) rest = rest.slice(0, slash);
  const colon = rest.indexOf(":");
  if (colon >= 0) rest = rest.slice(0, colon);
  return rest === "" ? "未知主机" : rest;
}

/** 把 URL 的认证段替换为 `***`（脱敏；供错误信息与 `status` 使用）。 */
export function redactUrl(url: string): string {
  return url.replace(/\/\/[^/@]*@/, "//***@");
}

// ---------------- 镜像架构 ----------------

/** {@link checkJudgeImageArchitecture} 的结果。 */
export interface ImageArchCheckResult {
  ok: boolean;
  error: string | null;
  /** 实际架构（可用于诊断）。 */
  arch: string | null;
}

/**
 * 校验本地 Judge 镜像架构与宿主机一致（bash `check_image_architecture` :761-789）。
 *
 * 为什么要在**部署前**查：架构不符的镜像在 `docker run` 时才报
 * `exec format error`，而那时容器已经起来了、配置已经写好——用户看到的是
 * "Judge 起不来"而不是"镜像下错了架构"。提前查能把故障变成一条明确的提示。
 *
 * 镜像不存在时**不算失败**（`compose pull` 会去拉），只有"存在但架构不符"才拒绝。
 */
export async function checkJudgeImageArchitecture(
  env: Record<string, string>,
  opts: {
    runner: CommandRunner;
    dockerBin?: string;
    /** 宿主机架构探测（`uname -m` 的等价）。 */
    hostArch: () => Promise<string>;
  },
): Promise<ImageArchCheckResult> {
  const registry = (env["JUDGE_IMAGE_REGISTRY"] ?? "") ||
    DEFAULT_JUDGE_IMAGE_REGISTRY;
  const version = env["NOJ_VERSION"] ?? "";
  const image = `${registry}/noj-judge:${version}`;
  const dockerBin = opts.dockerBin ?? "docker";

  let local = "";
  try {
    const res = await opts.runner.run(dockerBin, [
      "image",
      "inspect",
      image,
      "--format",
      "{{.Architecture}}",
    ]);
    if (res.code === 0) local = res.stdout.trim();
  } catch {
    local = "";
  }
  if (local === "") {
    // 镜像尚未拉取：由 compose pull 负责，不算失败。
    return { ok: true, error: null, arch: null };
  }

  const host = dockerArchOf(await opts.hostArch());
  if (local !== host) {
    return {
      ok: false,
      error:
        `本地 Judge 镜像架构（${local}）与宿主机（${host}）不一致：${image}；` +
        `请拉取对应架构的镜像或删除本地镜像后重试`,
      arch: local,
    };
  }
  return { ok: true, error: null, arch: local };
}

/**
 * `uname -m` → Docker 的架构名。
 *
 * Docker 用 `amd64`/`arm64`/`arm`/`386`，而 `uname -m` 给 `x86_64`/
 * `aarch64`/`armv7l`/`i686`——不映射就永远"不一致"，把一次正常的部署拒掉。
 */
export function dockerArchOf(unameArch: string): string {
  switch (unameArch.trim()) {
    case "x86_64":
    case "amd64":
      return "amd64";
    case "aarch64":
    case "arm64":
      return "arm64";
    case "armv7l":
    case "armv6l":
      return "arm";
    case "i386":
    case "i686":
      return "386";
    default:
      return unameArch.trim();
  }
}

/** 校验路径为绝对路径（供调用方在拼 compose 参数前调用）。 */
export function assertAbsolute(label: string, path: string): void {
  if (!isAbsolute(path)) {
    throw new UsageError(`${label} 必须是绝对路径：${path}`);
  }
}
