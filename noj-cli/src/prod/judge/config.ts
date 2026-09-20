/**
 * 独立 Judge Worker 的配置层与**安全守卫**（T21）。
 *
 * 迁移 `scripts/deploy/judge-install.sh` 的 `env_value()`/`set_env_value()`（:205-239）、
 * `initialize_env()`（:501-581）、`check_config_values()`（:667-694）、
 * `check_socket()`（:695-717）、`check_base_environment()`（:638-666）与
 * `validate_redis_port()`/`port_is_in_use()`（:345-365）。
 *
 * ## 两条不可协商的安全约束（本模块存在的首要理由）
 *
 * ### 1. 禁止共享 Docker socket
 *
 * `JUDGE_DOCKER_SOCKET` **不得**是 `/var/run/docker.sock` 或 `/run/docker.sock`。
 * 这两个 socket 是**应用宿主机**的 daemon：挂进 Judge 容器后，评测代码（题目
 * 作者提供的 evaluator / solution 镜像）就能创建、删除、exec **宿主机上的任意
 * 容器**——包括 noj-core、数据库，以及其他租户的服务。这是一个容器逃逸级别的
 * 权限提升，且它的触发条件是"正常使用功能"，不需要攻击者做任何异常操作。
 *
 * 因此本模块导出 {@link assertDedicatedSocket}，它**先于任何配置写入**被调用，
 * 且拒绝后不产生任何副作用（测试断言"零配置写入、零 compose 调用"）。
 *
 * `JUDGE_DOCKER_HOST` 还必须指向**容器内**的专用 endpoint
 * `unix:///run/noj-judge/docker.sock`——这是 socket 在容器内的挂载点，写错会让
 * Judge 连到别的东西（或被默认的 `unix:///var/run/docker.sock` 静默接管）。
 *
 * ### 2. 不碰宿主 Docker daemon
 *
 * 本模块（与整个 `prod/judge/`）**不安装、不替换、不配置**宿主机 Docker daemon，
 * 也不调用服务器面板的 API（宝塔只做探测 + 提示）。rootless daemon 由运维人员按
 * 发行版文档预先准备。
 *
 * 这条不是"暂时没做"，而是**设计边界**：自动安装 daemon 需要一个拥有 root 的
 * 安装器，而那正是评测隔离要防的东西。测试用
 * {@link FORBIDDEN_HOST_COMMANDS} 断言这些命令**从未**被调用。
 *
 * 本模块不持有模块级可变状态（AGENTS.md §8.2 多副本约束）。
 */

import { dirname, isAbsolute, join, normalize } from "@std/path";
import { isPlaceholder, validateEnv } from "../../core/config-schema.ts";
import { parseEnvFile, writeEnvFileAtomic } from "../../core/env-file.ts";
import { UsageError } from "../../util/args.ts";

/** Judge 配置文件权限（bash `chmod 600`）。 */
export const JUDGE_ENV_MODE = 0o600;

/** Judge Compose 文件权限（bash `:636` 的 `chmod 600`）。 */
export const JUDGE_COMPOSE_MODE = 0o600;

/** 默认 Judge 运行目录（bash `:87`）。 */
export const DEFAULT_JUDGE_DIR = "/srv/noj-judge";

/** 配置文件相对名。 */
export const JUDGE_ENV_FILE = ".env.judge";

/** Compose 文件相对名。 */
export const JUDGE_COMPOSE_FILE = "docker-compose.judge.yml";

/** Compose 项目名（bash `:810` 的 `--project-name`）。 */
export const JUDGE_PROJECT_NAME = "noj-judge-standalone";

/** 本机 Redis 数据卷名（bash `:635`）。 */
export const JUDGE_REDIS_VOLUME = "noj-judge-standalone-cache";

/** 容器内专用 socket 挂载点（bash `:562` 与 `:614`）。 */
export const JUDGE_SOCKET_CONTAINER_PATH = "/run/noj-judge/docker.sock";

/**
 * **被禁止的共享 socket 路径**（bash `:699-701` 逐字）。
 *
 * 两者都指向应用宿主机的 daemon。`/var/run` 通常是 `/run` 的符号链接，因此
 * 逻辑上二者等价；本模块同时拒绝**经 realpath 归一后**落在二者上的路径
 * （见 {@link assertDedicatedSocket}）——否则 `//run/docker.sock` 或符号链接
 * 就能绕过字面比较。
 */
export const FORBIDDEN_SOCKET_PATHS: readonly string[] = [
  "/var/run/docker.sock",
  "/run/docker.sock",
];

/**
 * **绝不调用**的宿主管理命令（安全约束 2 的可断言形式）。
 *
 * 这份清单同时是文档：它说明本工具的能力边界在哪里。任何新增调用都会让
 * `judge_test.ts` 的对应断言转红。
 */
export const FORBIDDEN_HOST_COMMANDS: readonly string[] = [
  "systemctl",
  "service",
  "apt",
  "apt-get",
  "yum",
  "dnf",
  "apk",
  "dockerd",
  "containerd",
  "usermod",
  "groupmod",
  "chown",
];

/** 默认 Redis 镜像（bash 的 `REDIS_IMAGE`）。 */
export const DEFAULT_JUDGE_REDIS_IMAGE = "redis:7-alpine";

/** 本机 Redis 默认宿主机端口（bash `--redis-port` 缺省 16379）。 */
export const DEFAULT_REDIS_PORT = 16379;

/** 本机 Redis 默认容器名（bash `:91`）。 */
export const DEFAULT_REDIS_CONTAINER = "noj-judge-redis";

/** 本机 Redis 容器的归属标签（bash `:434-435`）——只管理带此标签的同名容器。 */
export const REDIS_COMPONENT_LABEL = "judge-standalone-redis";
/** 管理方标签值。 */
export const REDIS_MANAGED_BY_LABEL = "judge-install";

/** 必须配置的键（bash `check_config_values` :669-672 逐字）。 */
export const JUDGE_REQUIRED_KEYS: readonly string[] = [
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
];

/** 首装写入的键与默认值（bash `:550-580` 的 heredoc 逐字）。 */
export const JUDGE_DEFAULT_VALUES: Readonly<Record<string, string>> = {
  JUDGE_QUEUE: "noj:judge:queue",
  RESULT_QUEUE: "noj:judge:results",
  JUDGE_PRIORITY_POLL_TIMEOUT_MS: "100",
  WORK_DIR: "/tmp/noj-judge",
  JUDGE_MAX_CONCURRENT_JUDGES: "2",
  JUDGE_IMAGE_PREFIX: "noj-",
  JUDGE_IMAGE_REGISTRY: "ghcr.io/neuro-oj",
  JUDGE_DOCKER_SOCKET: JUDGE_SOCKET_CONTAINER_PATH,
  JUDGE_DOCKER_SOCKET_GID: "10001",
  JUDGE_DOCKER_HOST: "unix://" + JUDGE_SOCKET_CONTAINER_PATH,
  JUDGE_REQUIRE_ISOLATED_DOCKER: "true",
  JUDGE_UID: "10001",
  JUDGE_GID: "10001",
  JUDGE_CPU_LIMIT_MILLICORES: "1000",
  JUDGE_MAX_EVALUATOR_TIME_MS: "300000",
  JUDGE_MAX_SOLUTION_CALL_TIMEOUT_MS: "60000",
  JUDGE_COMMAND_WHITELIST: "python3,deno,node,bash,sh",
  JUDGE_ALLOW_EVALUATOR_NETWORK: "false",
  JUDGE_EVALUATOR_NETWORK: "bridge",
  JUDGE_ALLOW_HTTP_S3: "false",
  SUPPORT_PACKAGE_DOWNLOAD_TIMEOUT: "60",
  SUPPORT_CACHE_DIR: "/tmp/noj-judge/support-cache",
  SUPPORT_CACHE_MAX_ITEMS: "500",
  SUPPORT_CACHE_MAX_MB: "2048",
};

/** 不可变 Release 标签（bash `is_version` :276-278：`v?N.N.N`，允许 `-rc` 后缀）。 */
const VERSION_RE = /^v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

/** `JUDGE_VERSION` 校验（`v0.1.0` / `0.8.0-rc.1` 通过；`main` / `latest` 拒绝）。 */
export function assertJudgeVersion(version: string): void {
  if (!VERSION_RE.test(version.trim())) {
    throw new UsageError(
      `NOJ_VERSION 必须是不可变 Release 标签（如 v0.1.0 或 0.8.0-rc.1），` +
        `不能填写 main / latest：收到 "${version}"`,
    );
  }
}

/**
 * 拒绝应用宿主机的共享 Docker socket（安全约束 1 的实现）。
 *
 * 三层判定，缺一不可：
 * 1. **字面比较**（bash `:699-701`）：直接命中两个已知路径；
 * 2. **realpath 归一**：`/var/run` 常是 `/run` 的符号链接，且用户可以写
 *    `//run/docker.sock`、`/run/./docker.sock` 等等价形式——只比字面
 *    等于给绕过留门；
 * 3. **须为绝对路径且不含 `:`**（bash `:703-704`）：`:` 意味着写成了
 *    `host:port` 形式的 TCP endpoint，那不是 Unix socket。
 *
 * @param socketPath 配置里的 socket 路径
 * @param realPath 归一化注入点（缺省用 `Deno.realPathSync`）；测试注入
 *   以模拟符号链接而不必真的建链接。
 */
export function assertDedicatedSocket(
  socketPath: string,
  realPath: (path: string) => string = defaultRealPath,
): void {
  const raw = socketPath.trim();
  if (raw === "") {
    throw new UsageError("JUDGE_DOCKER_SOCKET 不能为空");
  }
  if (!isAbsolute(raw)) {
    throw new UsageError(`JUDGE_DOCKER_SOCKET 必须是绝对路径：${raw}`);
  }
  if (raw.includes(":")) {
    throw new UsageError(
      `JUDGE_DOCKER_SOCKET 必须是本机 Unix socket 路径：${raw}`,
    );
  }

  // **归一化是必需的**（评审发现的绕过）：仅比较字面量会漏掉一切等价写法。
  // 实测被放行的形态：`/var/run/docker.sock/`（尾部斜杠）、`…/docker.sock/.`、
  // `/run/docker.sock/./`。它们指向同一个宿主 socket——且真实 Docker 对
  // 尾部斜杠的 bind 源同样会挂载该路径，所以一个手误的斜杠就能把宿主 socket
  // 交给 Judge，正是本模块要防的容器逃逸面。
  //
  // `realPath` 之所以不够：`Deno.realPathSync("/var/run/docker.sock/")` 抛
  // `NotADirectory`（socket 不是目录），旧实现把"抛错"当成"路径不存在"跳过，
  // 于是归一化完全没发生。
  const candidates = new Set<string>();
  const add = (path: string): void => {
    if (path === "") return;
    candidates.add(path);
    candidates.add(collapseSlashes(path));
    // **真正的路径归一化**：`normalize` 解决 `.`/`..`/重复斜杠，
    // 但它**保留尾部斜杠**（实测 `/a/b/` → `/a/b/`），故再剥一次。
    // 手写正则做不到这点：`/var/run/docker.sock/..//docker.sock`
    // 归一化后正是被禁路径，而简单的去尾斜杠看不出来。
    const normalized = normalize(path).replace(/\/+$/, "");
    if (normalized !== "" && normalized !== path) {
      candidates.add(normalized);
      candidates.add(collapseSlashes(normalized));
    }
    // 父目录也纳入：socket 常被软链到"更整洁"的路径。
    const parent = dirname(normalized === "" ? path : normalized);
    if (parent !== "" && parent !== "/") {
      candidates.add(parent);
      const realParent = safeRealPath(realPath, parent);
      if (realParent !== "") {
        candidates.add(realParent);
        candidates.add(collapseSlashes(realParent));
      }
    }
  };
  add(raw);
  // realpath 只在路径**存在**时有意义（不存在/非目录时回退字面值）。
  const resolved = safeRealPath(realPath, raw);
  add(resolved);
  // 对**父目录**再取一次 realpath：socket 常被软链到"更整洁"的路径，
  // 而针对 socket 本身取 realpath 在部分平台会失败。
  add(safeRealPath(realPath, dirname(raw.replace(/\/+$/, ""))));
  for (const candidate of candidates) {
    if (FORBIDDEN_SOCKET_PATHS.includes(candidate)) {
      throw new UsageError(
        `禁止使用应用宿主机 Docker socket：${socketPath}；` +
          `请准备只服务于 Judge 的 rootless socket（例如 /run/noj-judge/docker.sock）`,
      );
    }
  }
}

/**
 * `realPath` 的容错包装：抛错（路径不存在 / 非目录）时返回 `""`。
 *
 * 抽出来的理由：旧实现直接调用它并**把抛错当成"不存在"**，于是
 * `/var/run/docker.sock/` 这类会抛 `NotADirectory` 的输入完全跳过了归一化——
 * 那是绕过守卫的直接原因。现在抛错只影响"这一步拿不到 realpath"，
 * 字面量/去尾斜杠/父目录的归一化仍在。
 */
function safeRealPath(
  realPath: (path: string) => string,
  path: string,
): string {
  if (path === "") return "";
  try {
    return realPath(path);
  } catch {
    return "";
  }
}

/** 合并重复斜杠（`//run/docker.sock` → `/run/docker.sock`）。 */
function collapseSlashes(path: string): string {
  return path.replace(/\/{2,}/g, "/");
}

/** 缺省 realpath：路径不存在时返回空串（由调用方回退字面比较）。 */
function defaultRealPath(path: string): string {
  try {
    return Deno.realPathSync(path);
  } catch {
    return "";
  }
}

/**
 * 校验 `JUDGE_DOCKER_HOST` 必须是**容器内**的专用 endpoint（bash `:687-691`）。
 *
 * 为什么要专门校验它：即使 `JUDGE_DOCKER_SOCKET` 是对的，`JUDGE_DOCKER_HOST`
 * 若写成默认的 `unix:///var/run/docker.sock`，容器内的 Judge 就会去连宿主机
 * 的 daemon——**安全约束 1 被绕过，而配置看起来完全正常**。
 */
export function assertJudgeDockerHost(host: string): void {
  const expected = "unix://" + JUDGE_SOCKET_CONTAINER_PATH;
  if (!host.startsWith("unix://")) {
    throw new UsageError(
      `JUDGE_DOCKER_HOST 必须使用 unix:// endpoint：${host}`,
    );
  }
  if (host !== expected) {
    throw new UsageError(
      `JUDGE_DOCKER_HOST 必须为容器内专用 endpoint：${expected}（收到 ${host}）`,
    );
  }
}

/** 校验 `JUDGE_REQUIRE_ISOLATED_DOCKER` 必须为 true（bash `:692-693`）。 */
export function assertIsolatedDockerRequired(value: string): void {
  if (value !== "true") {
    throw new UsageError(
      `JUDGE_REQUIRE_ISOLATED_DOCKER 必须为 true（收到 "${value}"）：` +
        `关闭它会让 Judge 接受共享 socket`,
    );
  }
}

/** 读取 `.env.judge` 为键值表；不存在返回空表（bash `env_value` 的语义）。 */
export async function readJudgeEnv(
  path: string,
): Promise<Record<string, string>> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of parseEnvFile(text)) out[k] = v;
  return out;
}

/** 取配置值（bash `env_value` 的等价；缺失返回空串）。 */
export function envValue(env: Record<string, string>, key: string): string {
  return env[key] ?? "";
}

/**
 * 校验配置**值**（bash `check_config_values` :667-694 的等价）。
 *
 * 逐条顺序对齐 bash：必填非占位 → 版本标签 → 并发正整数 → GID/UID 数字 →
 * HOST endpoint → REQUIRE_ISOLATED_DOCKER。任一条失败即抛 {@link UsageError}
 * （退出码 2：这是配置错误，不是运行时故障）。
 *
 * 占位判定复用 T2 的 {@link isPlaceholder}（`change-me` / `REPLACE_WITH_` /
 * `your-` 等前缀），不重写一份。
 */
export function assertJudgeConfigValues(env: Record<string, string>): void {
  const missing: string[] = [];
  for (const key of JUDGE_REQUIRED_KEYS) {
    if (isPlaceholder(envValue(env, key))) missing.push(key);
  }
  if (missing.length > 0) {
    throw new UsageError(
      "Judge 配置未完成，以下项未配置或仍是占位值：\n" +
        missing.map((k) => `  - ${k}`).join("\n"),
    );
  }
  assertJudgeVersion(envValue(env, "NOJ_VERSION"));

  const concurrency = envValue(env, "JUDGE_MAX_CONCURRENT_JUDGES");
  if (!/^[1-9][0-9]*$/.test(concurrency)) {
    throw new UsageError(
      `JUDGE_MAX_CONCURRENT_JUDGES 必须是正整数：${concurrency}`,
    );
  }
  for (const key of ["JUDGE_DOCKER_SOCKET_GID", "JUDGE_UID", "JUDGE_GID"]) {
    if (!/^[0-9]+$/.test(envValue(env, key))) {
      throw new UsageError(`${key} 必须是数字：${envValue(env, key)}`);
    }
  }
  assertJudgeDockerHost(envValue(env, "JUDGE_DOCKER_HOST"));
  assertIsolatedDockerRequired(envValue(env, "JUDGE_REQUIRE_ISOLATED_DOCKER"));
}

/** 配置文件权限的可接受值（bash `:794-796`）。 */
export const JUDGE_ENV_ALLOWED_MODES: readonly string[] = ["600", "400"];

/** 校验配置文件权限（bash `check_configuration` :793-796 的前半）。 */
export async function assertJudgeEnvFileMode(path: string): Promise<void> {
  let st: Deno.FileInfo;
  try {
    st = await Deno.stat(path);
  } catch {
    throw new UsageError(`找不到配置文件：${path}，请先执行 install`);
  }
  const mode = ((st.mode ?? 0) & 0o777).toString(8).padStart(3, "0");
  if (!JUDGE_ENV_ALLOWED_MODES.includes(mode)) {
    throw new UsageError(
      `配置文件权限必须为 600 或 400：${path}（当前 ${mode}）`,
    );
  }
}

/** {@link writeJudgeEnv} 的输入。 */
export interface WriteJudgeEnvOptions {
  /** `.env.judge` 路径。 */
  path: string;
  /** 首装的值（缺省用 {@link JUDGE_DEFAULT_VALUES}）；`NOJ_VERSION`/`REDIS_URL` 必给。 */
  values?: Record<string, string>;
  /**
   * **显式**要求就地更新 `NOJ_VERSION`（对应 bash 的 `--version` / `VERSION_OVERRIDE`）。
   *
   * 与 `values["NOJ_VERSION"]` 分开是刻意的：`values` 只是"首装时该写什么"，
   * 而升级路径必须能表达"我确实想改版本"。混在一个字段里的话，任何把
   * `NOJ_VERSION` 放进 `values` 的调用（例如复用一份基线配置对象）都会**静默
   * 覆盖用户既有的版本**——那正是本模块要避免的破坏。
   *
   * 只在既有配置存在时生效（首装走 `values`）。
   */
  updateVersion?: string;
}

/** {@link writeJudgeEnv} 的结果。 */
export interface WriteJudgeEnvResult {
  /** 本次是否真的写了文件（既有配置且未要求覆盖时为 false）。 */
  written: boolean;
  /** 最终生效的键值。 */
  env: Record<string, string>;
}

/**
 * 写入首装配置（bash `initialize_env` :501-581 的等价）。
 *
 * **绝不覆盖既有配置**（bash `:517-523`：存在即 `chmod 600` + 「保留已有配置」
 * 后返回）。这不是保守，而是必要：升级时覆盖会丢掉用户手工调过的队列名、并发数、
 * socket GID——那些值无法从任何地方重新推导。
 *
 * `NOJ_VERSION` 是唯一例外：`--version` 显式给出时**就地更新**该键
 * （bash `:521` 的 `[[ -n "$VERSION_OVERRIDE" ]] && set_env_value`），因为升级
 * 的本质就是改版本，而 `set_env_value` 保留注释与其它键。
 */
export async function writeJudgeEnv(
  opts: WriteJudgeEnvOptions,
): Promise<WriteJudgeEnvResult> {
  const existing = await readJudgeEnv(opts.path);
  if (Object.keys(existing).length > 0) {
    // 既有配置：只在**显式**给了 updateVersion 时就地更新该键
    // （保留注释/顺序/其它键）。其它值一律不动。
    const updateVersion = opts.updateVersion;
    if (updateVersion !== undefined && updateVersion !== "") {
      assertJudgeVersion(updateVersion);
      await writeEnvFileAtomic(
        opts.path,
        new Map([["NOJ_VERSION", updateVersion]]),
      );
    }
    await Deno.chmod(opts.path, JUDGE_ENV_MODE);
    return {
      written: updateVersion !== undefined && updateVersion !== "",
      env: await readJudgeEnv(opts.path),
    };
  }

  const version = opts.values?.["NOJ_VERSION"] ?? "";
  const redisUrl = opts.values?.["REDIS_URL"] ?? "";
  if (version === "") {
    throw new UsageError("首装必须提供 NOJ_VERSION");
  }
  if (redisUrl === "") {
    throw new UsageError("首装必须提供 REDIS_URL");
  }
  const merged: Record<string, string> = {
    ...JUDGE_DEFAULT_VALUES,
    ...(opts.values ?? {}),
    NOJ_VERSION: version,
    REDIS_URL: redisUrl,
  };
  // 写入前先过一遍安全守卫：**拒绝时不得留下任何文件**。
  // 这是"先于配置写入"的落点——顺序反了的话，一个含共享 socket 的配置就已经
  // 落盘了，后续即使报错也得靠人工清理。
  assertDedicatedSocket(merged["JUDGE_DOCKER_SOCKET"] ?? "");
  assertJudgeConfigValues(merged);

  await Deno.mkdir(opts.path.substring(0, opts.path.lastIndexOf("/")), {
    recursive: true,
    mode: 0o700,
  });
  await writeEnvFileAtomic(opts.path, new Map(Object.entries(merged)));
  await Deno.chmod(opts.path, JUDGE_ENV_MODE);
  return { written: true, env: await readJudgeEnv(opts.path) };
}

/** Judge 目录内各文件的绝对路径。 */
export interface JudgePaths {
  dir: string;
  envFile: string;
  composeFile: string;
}

/** 由运行目录派生各文件路径（并校验目录为绝对路径）。 */
export function judgePaths(
  dir: string,
  envFile?: string,
  composeFile?: string,
): JudgePaths {
  if (!isAbsolute(dir)) {
    throw new UsageError(`Judge 运行目录必须是绝对路径：${dir}`);
  }
  const clean = dir.replace(/\/+$/, "");
  return {
    dir: clean,
    envFile: envFile ?? join(clean, JUDGE_ENV_FILE),
    composeFile: composeFile ?? join(clean, JUDGE_COMPOSE_FILE),
  };
}

/** 校验本机 Redis 端口（bash `validate_redis_port` :345-351）。 */
export function assertRedisPort(port: number): void {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new UsageError(
      `本机 Redis 端口必须在 1024-65535 范围内：${port}`,
    );
  }
}

/** 校验本机 Redis 容器名（bash `:410-411` 的正则）。 */
export function assertRedisContainerName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new UsageError(`本机 Redis 容器名格式无效：${name}`);
  }
}

/**
 * 生成本机 Redis 口令（bash `generate_redis_password` :337-343）。
 *
 * bash 优先用 openssl、否则读 `/dev/urandom`；TS 侧直接用 WebCrypto
 * （零外部依赖、不读设备文件）。与 `init/secrets.ts:randomKey` 同源。
 */
export function generateRedisPassword(bytes = 24): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let hex = "";
  for (const b of buf) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * 探测宿主是否支持独立 Judge（bash `check_base_environment` :638-666 的等价）。
 *
 * **只读探测**：不做任何安装、配置或替换（安全约束 2）。bash 侧检查
 * `uname -s` 是否为 Linux、docker/compose 是否可用；这里把 `uname` 也经注入
 * runner 以便在非 Linux 的 CI 上测试。
 */
export interface HostProbe {
  /** 平台名（`uname -s`）；缺省用 `Deno.build.os` 映射。 */
  uname?: () => Promise<string>;
  /** docker 可用性探测。 */
  dockerAvailable?: () => Promise<boolean>;
}

/** 探测结果。 */
export interface HostProbeResult {
  ok: boolean;
  /** 失败原因（ok 为 true 时 null）。 */
  error: string | null;
}

/** 执行宿主探测；**不通过即返回错误**（由调用方决定退出码）。 */
export async function checkJudgeHost(
  probe: HostProbe,
): Promise<HostProbeResult> {
  const uname = probe.uname ?? (() => Promise.resolve(defaultUname()));
  const platform = await uname();
  if (!platform.startsWith("Linux")) {
    return {
      ok: false,
      error: `独立 Judge 部署目前只支持 Linux（当前 ${platform}）`,
    };
  }
  if (probe.dockerAvailable !== undefined) {
    if (!(await probe.dockerAvailable())) {
      return {
        ok: false,
        error: "Docker daemon 未运行或当前用户无权限",
      };
    }
  }
  return { ok: true, error: null };
}

/** `Deno.build.os` → `uname -s` 风格的名字。 */
function defaultUname(): string {
  switch (Deno.build.os) {
    case "linux":
      return "Linux";
    case "darwin":
      return "Darwin";
    case "windows":
      return "Windows_NT";
    default:
      return Deno.build.os;
  }
}

/** 校验 Judge 依赖的通用键（复用 T2 `validateEnv` 的判定，不重写）。 */
export function assertJudgeEnvViaSchema(
  env: Record<string, string>,
): { missing: string[]; placeholder: string[] } {
  return validateEnv({
    NOJ_VERSION: env["NOJ_VERSION"] ?? "",
    APP_URL: env["APP_URL"] ?? "https://judge-standalone.invalid",
    CORS_ALLOWED_ORIGINS: env["CORS_ALLOWED_ORIGINS"] ??
      "https://judge-standalone.invalid",
    DOMAIN: env["DOMAIN"] ?? "judge-standalone.invalid",
    REDIS_PASSWORD: env["REDIS_PASSWORD"] ?? "n/a",
    POSTGRES_PASSWORD: env["POSTGRES_PASSWORD"] ?? "n/a",
    MINIO_ROOT_USER: env["MINIO_ROOT_USER"] ?? "n/a",
    MINIO_ROOT_PASSWORD: env["MINIO_ROOT_PASSWORD"] ?? "n/a",
    S3_ACCESS_KEY: env["S3_ACCESS_KEY"] ?? "n/a",
    S3_SECRET_KEY: env["S3_SECRET_KEY"] ?? "n/a",
    S3_BUCKET: env["S3_BUCKET"] ?? "n/a",
    S3_ENDPOINT: env["S3_ENDPOINT"] ?? "n/a",
    STORAGE_PROVIDER: env["STORAGE_PROVIDER"] ?? "n/a",
    JWT_SECRET: env["JWT_SECRET"] ?? "n/a",
    TFA_ENCRYPTION_KEY: env["TFA_ENCRYPTION_KEY"] ?? "n/a",
    NOJ_LLM_SERVICE_TOKEN: env["NOJ_LLM_SERVICE_TOKEN"] ?? "n/a",
    NOJ_LLM_STORE_KEY: env["NOJ_LLM_STORE_KEY"] ?? "n/a",
    EMAIL_PROVIDER: env["EMAIL_PROVIDER"] ?? "n/a",
    TRUSTED_PROXIES: env["TRUSTED_PROXIES"] ?? "n/a",
  });
}

/** 断言 runner 从未调用被禁的宿主管理命令（安全约束 2 的断言辅助）。 */
export function findForbiddenHostCalls(
  calls: readonly { cmd: string }[],
): string[] {
  return calls
    .map((c) => c.cmd)
    .filter((cmd) => FORBIDDEN_HOST_COMMANDS.includes(cmd));
}
