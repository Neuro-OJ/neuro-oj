/**
 * 独立 Judge 的命令编排（T21）。
 *
 * 迁移 `judge-install.sh` 的 `check_configuration()`（:790-809）、
 * `run_compose()`（:810-820）、`install`/`start`/`stop`/`status`/`logs`/`upgrade`
 * 的动作部分，以及 `ensure_target_dir()`/`validate_existing_target()`（:299-316）
 * 与 `configure_redis()` 的非交互分支（:457-500）。
 *
 * ## 与其他模块的分工
 *
 * | 模块 | 职责 |
 * | --- | --- |
 * | `config.ts` | 配置读写 + **安全守卫**（共享 socket 拒绝） |
 * | `compose.ts` | Compose 渲染（纯函数）+ socket/Redis/架构校验 |
 * | `actions.ts`（本模块） | 编排：前置 → 渲染 → compose 调用 → 结果形状 |
 *
 * ## `--dry-run` 的语义
 *
 * `--dry-run` 时**零 runner 调用、零文件写入**：只回报"将要做什么"。这条在
 * bash 里是散落的 `((DRY_RUN)) && { ok "[dry-run] …"; return 0; }`，本模块把它
 * 收敛为一个显式分支，因此可以用"注入的 runner 一次都没被调用"直接断言。
 *
 * ## 退出码
 *
 * 0 成功 / 1 运行失败（compose 非 0、daemon 不可连）/ 2 用法或前置错误
 * （配置缺失、权限不符、共享 socket、参数非法）。与 T19/T20 同一分层。
 *
 * 本模块不持有模块级可变状态（AGENTS.md §8.2 多副本约束）。
 */

import type { CommandRunner } from "../../runtime/command.ts";
import { UsageError } from "../../util/args.ts";
import {
  assertDedicatedSocket,
  assertJudgeConfigValues,
  assertJudgeEnvFileMode,
  checkJudgeHost,
  type HostProbe,
  JUDGE_COMPOSE_MODE,
  type JudgePaths,
  judgePaths,
  readJudgeEnv,
  writeJudgeEnv,
} from "./config.ts";
import {
  checkJudgeImageArchitecture,
  checkJudgeRedis,
  checkStandaloneJudgeSocket,
  judgeComposeArgs,
  redactUrl,
  renderJudgeCompose,
} from "./compose.ts";

/** 所有动作的公共注入点。 */
export interface JudgeActionOptions {
  /** Judge 运行目录（`--dir`）。 */
  dir: string;
  /** 配置文件覆盖（`--env-file`）。 */
  envFile?: string;
  /** Compose 文件覆盖（`--compose-file`）。 */
  composeFile?: string;
  /** 命令注入点。 */
  runner: CommandRunner;
  /** docker 可执行名。 */
  dockerBin?: string;
  /** 只显示动作，不做任何修改。 */
  dryRun?: boolean;
  /** 人类日志汇聚点。 */
  log?: (line: string) => void;
  /** 时间源（测试注入）。 */
  now?: () => Date;
}

/** 动作结果的公共形状。 */
export interface JudgeActionResult {
  /** 0 / 1 / 2。 */
  exitCode: number;
  /** 面向用户的一句话结论。 */
  message: string;
  /** 参与本次动作的路径。 */
  paths: JudgePaths;
}

/** `install` 的注入点。 */
export interface JudgeInstallOptions
  extends JudgeActionOptions, JudgeSocketProbes {
  /** 版本（`--version`）；缺省用既有配置里的值。 */
  version?: string;
  /** Redis URL（非交互必填）。 */
  redisUrl?: string;
  /** Redis 检查 URL（缺省等于 `redisUrl`）。 */
  redisCheckUrl?: string;
  /** 专用 socket 路径（缺省 `/run/noj-judge/docker.sock`）。 */
  socketPath?: string;
  /** socket GID（缺省 10001）。 */
  socketGid?: string;
  /** 额外的配置覆盖（队列名、并发数等）。 */
  values?: Record<string, string>;
  /** 宿主探测（平台/docker 可用性）。 */
  host?: HostProbe;
}

/**
 * `install-env`（bash `install_env()`:847-867）：依赖检查 + rootless 隔离指引。
 *
 * **为什么单列一个子命令**：独立 Judge 节点的部署**不能**自动化——它要求运维者
 * 先准备一个只服务于 Judge 的 rootless Docker daemon 与独立 socket。本工具刻意
 * **不**安装、**不**替换宿主 daemon（自动安装需要 root 安装器，那正是评测隔离
 * 要防的东西）。因此这条命令的产出是"**检查 + 指引**"：确认依赖可用，并把必须
 * 由人工确认的四条隔离条件说清楚。
 *
 * ## 对照 bash（R3）
 *
 * | bash（`judge-install.sh:847-867`） | 本实现 |
 * | --- | --- |
 * | Linux 判定 | {@link checkJudgeHost} 的 OS 探测 |
 * | `detect_panel` + `show_panel_guidance` | `host` 的面板探测（只提示，不调 API） |
 * | `require_command curl` / `docker` | `host` 的依赖探测 |
 * | `docker info` 失败 → fail | 见下（退出码 **1**） |
 * | `docker compose version` 失败 → fail | 见下（退出码 **1**） |
 * | 打印四条隔离条件 | 见下（逐条对应） |
 * | 声明不动宿主 daemon 与 socket | 见下（**不可省略**：它是安全边界的对外声明） |
 *
 * ## 与 bash 的差异
 *
 * 1. **退出码与 bash 一致**（`judge-install.sh:51-54` 的 `fail()` 是 `exit 1`）：
 *    daemon 不可连、Compose 不可用都返回 **1**。这与 `judge` 模块整体的
 *    "2 = 用法或前置错误、1 = 运行失败"分层**不同**——因为 bash 侧本就把
 *    judge 的各类失败统一为 1。此处以**逐命令 parity** 为准（R3 要求退出码
 *    逐命令一致），而不是套用模块内的通用分层。
 * 2. **前置失败不打印后续指引**：指引只在依赖全部通过后才输出，否则用户会误以为
 *    环境已就绪。
 */
export async function judgeInstallEnv(
  opts: JudgeActionOptions & { host?: HostProbe },
): Promise<JudgeActionResult> {
  const paths = judgePaths(opts.dir, opts.envFile, opts.composeFile);
  const log = opts.log ?? (() => {});

  // ---- 依赖与宿主检查（只读；不安装任何东西）----
  const host = await checkJudgeHost(opts.host ?? {});
  if (!host.ok) {
    return fail(paths, 1, host.error ?? "宿主环境不满足要求");
  }

  const dockerBin = opts.dockerBin ?? "docker";
  const daemon = await opts.runner.run(dockerBin, ["info"]);
  if (daemon.code !== 0) {
    const detail = daemon.stderr.trim();
    return fail(
      paths,
      1,
      "Docker daemon 未运行或当前用户无权限" +
        (detail === "" ? "" : `：${detail}`),
    );
  }
  const compose = await opts.runner.run(dockerBin, ["compose", "version"]);
  if (compose.code !== 0) {
    return fail(paths, 1, "Docker Compose v2 不可用");
  }
  log("✓ Docker daemon 与 Compose 可用");

  // ---- 四条隔离条件（bash :859-864 逐条对应）----
  log("");
  log("请确认已准备以下隔离条件：");
  log("  1. 只服务于 Judge 的 rootless Docker daemon；");
  log("  2. 独立 Unix socket（例如 /run/noj-judge/docker.sock）；");
  log("  3. Worker 用户的 UID/GID 及 socket group 权限；");
  log("  4. 与 noj-core 使用同一 Redis、任务队列和结果队列。");
  log("");
  // 安全边界的对外声明：读起来像说明文字，但它界定了本工具**不会**做什么。
  log(
    "本工具不会自动安装或替换 Docker daemon，" +
      "也不会把 /var/run/docker.sock 提供给 Judge。",
  );

  return { exitCode: 0, message: "Judge 部署依赖检查通过", paths };
}

/**
 * `install`（bash `install` 动作的等价）：建目录 → 写配置 → 渲染 Compose →
 * 前置校验 → `compose up -d`。
 *
 * **顺序是安全要求**：配置写入（{@link writeJudgeEnv}）内部会在落盘前调用
 * `assertDedicatedSocket`，因此共享 socket 被拒时**不会留下任何配置文件**。
 * 紧随其后的 `checkJudgeSocket` 是运行期复核（socket 可能刚被创建/改权限）。
 */
export async function judgeInstall(
  opts: JudgeInstallOptions,
): Promise<JudgeActionResult> {
  const log = opts.log ?? (() => {});
  const paths = judgePaths(opts.dir, opts.envFile, opts.composeFile);

  // ---- 宿主探测（只读；不安装/不配置 daemon）----
  const host = await checkJudgeHost(opts.host ?? {});
  if (!host.ok) {
    return fail(paths, 2, host.error ?? "宿主环境不满足要求");
  }

  // ---- 配置：写或保留 ----
  let env: Record<string, string>;
  try {
    const existing = await readJudgeEnv(paths.envFile);
    const values: Record<string, string> = { ...(opts.values ?? {}) };
    // `--version` 是**显式**的版本变更（对应 bash 的 VERSION_OVERRIDE）：
    // 走 updateVersion 而非塞进 values，否则复用一份基线配置对象的调用会静默
    // 覆盖用户既有版本。首装时更新 version 也从这里取。
    const explicitVersion = opts.version !== undefined && opts.version !== ""
      ? opts.version
      : undefined;
    if (explicitVersion !== undefined) values["NOJ_VERSION"] = explicitVersion;
    if (opts.redisUrl !== undefined && opts.redisUrl !== "") {
      values["REDIS_URL"] = opts.redisUrl;
      values["REDIS_CHECK_URL"] = opts.redisCheckUrl ?? opts.redisUrl;
    }
    if (opts.socketPath !== undefined && opts.socketPath !== "") {
      values["JUDGE_DOCKER_SOCKET"] = opts.socketPath;
    }
    if (opts.socketGid !== undefined && opts.socketGid !== "") {
      values["JUDGE_DOCKER_SOCKET_GID"] = opts.socketGid;
    }
    if (opts.dryRun === true) {
      // dry-run：只校验既有配置（若有），不写任何文件
      env = Object.keys(existing).length > 0 ? existing : values;
      if (Object.keys(existing).length === 0) {
        assertJudgeConfigValues({ ...defaultsForDryRun(), ...values });
      } else {
        assertJudgeConfigValues(env);
      }
      log(`[dry-run] 将创建或更新配置：${paths.envFile}`);
      log(`[dry-run] 将生成 Compose 配置：${paths.composeFile}`);
      log("[dry-run] 将启动 Judge 容器（compose up -d）");
      return {
        exitCode: 0,
        message: "[dry-run] 安装流程校验通过，未做任何修改",
        paths,
      };
    }
    const written = await writeJudgeEnv({
      path: paths.envFile,
      values: Object.keys(values).length > 0 ? values : undefined,
      updateVersion: explicitVersion,
    });
    env = written.env;
    log(
      written.written
        ? `✓ 配置就绪：${paths.envFile}`
        : `✓ 保留已有配置：${paths.envFile}`,
    );
    // **必须显式提示被保留覆盖的键**（评审发现）：既有配置优先时，
    // `--redis-url` / `--socket-path` / `--socket-gid` 会被静默丢弃，
    // 用户以为改了实际没改。静默忽略与"旗标被吞"属同一类缺陷。
    const ignoredKeys = Object.keys(written.ignored);
    if (ignoredKeys.length > 0) {
      log(
        `! 以下旗标未生效（既有配置优先，需手工修改 ${paths.envFile}）：` +
          ignoredKeys.join("、"),
      );
    }
  } catch (err) {
    return fail(paths, isUsage(err) ? 2 : 1, (err as Error).message);
  }

  // ---- 安全复核：socket 必须可用（共享 socket 已在写配置前被拒）----
  const socket = await checkStandaloneJudgeSocket(env, {
    runner: opts.runner,
    dockerBin: opts.dockerBin,
    socketGid: opts.probeSocketGid,
    socketMode: opts.probeSocketMode,
    isSocket: opts.probeIsSocket,
    isReadWritable: opts.probeReadWritable,
  });
  if (!socket.ok) {
    return fail(paths, 2, socket.error ?? "专用 Docker socket 校验失败");
  }
  if (socket.detail !== null) log(`✓ ${socket.detail}`);

  // ---- 渲染 Compose（纯函数）+ 落盘 600 ----
  try {
    const yaml = renderJudgeCompose(env);
    await Deno.writeTextFile(paths.composeFile, yaml);
    await Deno.chmod(paths.composeFile, JUDGE_COMPOSE_MODE);
    log(`✓ 已生成 Compose 配置：${paths.composeFile}`);
  } catch (err) {
    return fail(paths, isUsage(err) ? 2 : 1, (err as Error).message);
  }

  // ---- compose config --quiet（只读解析）----
  const configCode = await runCompose(
    opts,
    paths,
    ["config", "--quiet"],
  );
  if (configCode !== 0) {
    return fail(paths, 1, "独立 Judge Compose 配置无效");
  }

  // ---- 拉镜像 + 启动 ----
  const pullCode = await runCompose(opts, paths, ["pull"]);
  if (pullCode !== 0) {
    return fail(paths, 1, "拉取 Judge 镜像失败");
  }
  const upCode = await runCompose(opts, paths, ["up", "-d"]);
  if (upCode !== 0) {
    return fail(paths, 1, "启动 Judge 失败");
  }
  log("✓ Judge 已启动");
  return { exitCode: 0, message: "Judge 安装完成并已启动", paths };
}

/**
 * socket 探针的注入点（供测试复用；生产用缺省实现读真实文件系统）。
 *
 * 抽成独立类型是因为 `install` 与 `check` 都要透传它——测试无法在 CI 里建真实
 * 的 Unix socket 与对应 GID，只能注入。
 */
export interface JudgeSocketProbes {
  /** 探针：读 socket 的实际 GID（**不是**配置值 `socketGid`，后者是字符串）。 */
  probeSocketGid?: (path: string) => Promise<number | null>;
  /** 探针：读 socket 权限串。 */
  probeSocketMode?: (path: string) => Promise<string | null>;
  /** 探针：判定是否为 Unix socket。 */
  probeIsSocket?: (path: string) => Promise<boolean>;
  /** 探针：判定当前用户可读写。 */
  probeReadWritable?: (path: string) => Promise<boolean>;
}

/** `check` 的注入点。 */
export interface JudgeCheckOptions
  extends JudgeActionOptions, JudgeSocketProbes {
  /** `redis-cli` 是否可用（缺省按不可用处理 → 走容器回退）。 */
  redisCliAvailable?: boolean;
  /** 宿主机架构探测（`uname -m`）。 */
  hostArch?: () => Promise<string>;
}

/**
 * `check`（bash `check_configuration` :790-809 的等价）。
 *
 * 逐条：文件存在 → 权限 600/400 → 配置值 → **专用 socket** → Redis → 镜像架构 →
 * `compose config --quiet`。前四条**零 docker 调用**（除 socket 的连通性探测），
 * 因此配置问题能在"拉镜像"之前被发现。
 */
export async function judgeCheck(
  opts: JudgeCheckOptions,
): Promise<JudgeActionResult> {
  const log = opts.log ?? (() => {});
  const paths = judgePaths(opts.dir, opts.envFile, opts.composeFile);

  let env: Record<string, string>;
  try {
    await assertJudgeEnvFileMode(paths.envFile);
    if (!(await isFile(paths.composeFile))) {
      throw new UsageError(
        `找不到 Compose 配置：${paths.composeFile}，请先执行 install`,
      );
    }
    env = await readJudgeEnv(paths.envFile);
    assertJudgeConfigValues(env);
  } catch (err) {
    return fail(paths, isUsage(err) ? 2 : 1, (err as Error).message);
  }

  const socket = await checkStandaloneJudgeSocket(env, {
    runner: opts.runner,
    dockerBin: opts.dockerBin,
    socketGid: opts.probeSocketGid,
    socketMode: opts.probeSocketMode,
    isSocket: opts.probeIsSocket,
    isReadWritable: opts.probeReadWritable,
  });
  if (!socket.ok) {
    return fail(paths, 2, socket.error ?? "专用 Docker socket 校验失败");
  }
  log(`✓ ${socket.detail ?? "专用 socket 可用"}`);

  if (opts.dryRun === true) {
    log("[dry-run] 跳过 Redis、镜像和 Compose 实际连接检查");
    return { exitCode: 0, message: "[dry-run] Judge 配置检查通过", paths };
  }

  const redis = await checkJudgeRedis(env, {
    runner: opts.runner,
    dockerBin: opts.dockerBin,
    redisCliAvailable: opts.redisCliAvailable,
  });
  if (!redis.ok) {
    return fail(paths, 2, redis.error ?? "Redis 校验失败");
  }
  log(`✓ Redis 可连接：${redis.host}`);

  const arch = await checkJudgeImageArchitecture(env, {
    runner: opts.runner,
    dockerBin: opts.dockerBin,
    hostArch: opts.hostArch ?? (() => Promise.resolve(hostArchDefault())),
  });
  if (!arch.ok) {
    return fail(paths, 2, arch.error ?? "镜像架构校验失败");
  }

  const code = await runCompose(opts, paths, ["config", "--quiet"]);
  if (code !== 0) {
    return fail(paths, 1, "独立 Judge Compose 配置无效");
  }
  log("✓ Judge 配置检查通过");
  return { exitCode: 0, message: "Judge 配置检查通过", paths };
}

/** `start` / `stop` / `upgrade` 的公共前置。 */
async function prepareExisting(
  opts: JudgeActionOptions,
): Promise<
  | { ok: true; paths: JudgePaths; env: Record<string, string> }
  | { ok: false; result: JudgeActionResult }
> {
  const paths = judgePaths(opts.dir, opts.envFile, opts.composeFile);
  try {
    await assertJudgeEnvFileMode(paths.envFile);
    if (!(await isFile(paths.composeFile))) {
      throw new UsageError(
        `找不到 Compose 配置：${paths.composeFile}，请先执行 install`,
      );
    }
    const env = await readJudgeEnv(paths.envFile);
    assertJudgeConfigValues(env);
    // **配置文件本身也必须过共享 socket 守卫**（评审发现 Important）：
    // 此前只有 `check`/`install` 会调 `assertDedicatedSocket`，而
    // `start`/`stop`/`status`/`logs`/`upgrade` 走 `prepareExisting`——
    // 于是**手工把 `JUDGE_DOCKER_SOCKET` 改成宿主 socket 后，
    // `judge start` 会照常启动**（实测：`judge check` 正确拒绝，
    // `judge start` 却继续拉起容器）。守卫必须是"加载既有配置"的固有一步，
    // 而不是某几个子命令各自记得调用。
    assertDedicatedSocket(env["JUDGE_DOCKER_SOCKET"] ?? "");
    return { ok: true, paths, env };
  } catch (err) {
    return {
      ok: false,
      result: fail(paths, isUsage(err) ? 2 : 1, (err as Error).message),
    };
  }
}

/**
 * `start`（bash `start`）：`compose up -d`，**保留现有容器与配置**。
 *
 * 与 `install` 的区别：不写配置、不渲染 Compose（那些是 install 的职责），
 * 只做前置 + 启动。这样"重新启动"不会意外覆盖用户改过的文件。
 */
export async function judgeStart(
  opts: JudgeActionOptions,
): Promise<JudgeActionResult> {
  const log = opts.log ?? (() => {});
  const prepared = await prepareExisting(opts);
  if (!prepared.ok) return prepared.result;
  const { paths } = prepared;

  if (opts.dryRun === true) {
    log("[dry-run] 将启动 Judge 容器（compose up -d）");
    return { exitCode: 0, message: "[dry-run] 未启动任何容器", paths };
  }
  const code = await runCompose(opts, paths, ["up", "-d"]);
  if (code !== 0) return fail(paths, 1, "启动 Judge 失败");
  log("✓ Judge 已启动");
  return { exitCode: 0, message: "Judge 已启动", paths };
}

/**
 * `stop`（bash `stop`）：`compose stop`，**保留配置、缓存与 Redis 任务**。
 *
 * **不使用 `down`**：`down` 会删容器与网络（`-v` 还会删卷）。停止评测服务不该
 * 丢掉缓存卷里的内容——重启后重新拉取会浪费时间，而 `stop` 完全够用。
 */
export async function judgeStop(
  opts: JudgeActionOptions,
): Promise<JudgeActionResult> {
  const log = opts.log ?? (() => {});
  const prepared = await prepareExisting(opts);
  if (!prepared.ok) return prepared.result;
  const { paths } = prepared;

  if (opts.dryRun === true) {
    log("[dry-run] 将停止 Judge 容器（compose stop）");
    return { exitCode: 0, message: "[dry-run] 未停止任何容器", paths };
  }
  const code = await runCompose(opts, paths, ["stop"]);
  if (code !== 0) return fail(paths, 1, "停止 Judge 失败");
  log("✓ Judge 已停止（配置、缓存与 Redis 任务均已保留）");
  return { exitCode: 0, message: "Judge 已停止（数据已保留）", paths };
}

/** `status` 的结果（在公共形状上追加脱敏摘要）。 */
export interface JudgeStatusResult extends JudgeActionResult {
  /** 脱敏后的配置摘要（**绝不含口令/token**）。 */
  summary: string[];
  /** `compose ps` 的原始输出。 */
  psOutput: string;
}

/**
 * `status`（bash `status`）：`compose ps` + **脱敏**配置摘要。
 *
 * 脱敏不是可选项：`REDIS_URL` 里嵌着 Redis 口令，`status` 的输出常被贴进
 * issue / 聊天窗口 / 工单。因此摘要只展示**白名单键**，而 URL 类值再经
 * `redactUrl` 处理；测试对"输出不含配置里的口令"有直接断言。
 */
export async function judgeStatus(
  opts: JudgeActionOptions,
): Promise<JudgeStatusResult> {
  const log = opts.log ?? (() => {});
  const prepared = await prepareExisting(opts);
  if (!prepared.ok) {
    return { ...prepared.result, summary: [], psOutput: "" };
  }
  const { paths, env } = prepared;
  const summary = renderStatusSummary(env);

  if (opts.dryRun === true) {
    log("[dry-run] 将查询 Judge 状态");
    for (const line of summary) log(line);
    return {
      exitCode: 0,
      message: "[dry-run] 未查询容器状态",
      paths,
      summary,
      psOutput: "",
    };
  }

  const res = await runComposeCapture(opts, paths, ["ps"]);
  if (res.code !== 0) {
    return {
      ...fail(paths, 1, "查询 Judge 状态失败"),
      summary,
      psOutput: "",
    };
  }
  for (const line of summary) log(line);
  if (res.stdout !== "") log(res.stdout);
  return {
    exitCode: 0,
    message: "已输出 Judge 状态",
    paths,
    summary,
    psOutput: res.stdout,
  };
}

/**
 * 渲染脱敏的配置摘要（`status` 与 `--json` 共用）。
 *
 * **白名单**而非黑名单：只列出显式允许展示的键。黑名单（"排除含 password 的键"）
 * 会随着新键的加入而悄悄漏掉——例如 `NOJ_LLM_SERVICE_TOKEN` 里并没有
 * "password" 字样。
 */
export function renderStatusSummary(env: Record<string, string>): string[] {
  const safeKeys = [
    "NOJ_VERSION",
    "JUDGE_QUEUE",
    "RESULT_QUEUE",
    "WORK_DIR",
    "JUDGE_MAX_CONCURRENT_JUDGES",
    "JUDGE_IMAGE_PREFIX",
    "JUDGE_IMAGE_REGISTRY",
    "JUDGE_DOCKER_SOCKET",
    "JUDGE_DOCKER_SOCKET_GID",
    "JUDGE_DOCKER_HOST",
    "JUDGE_REQUIRE_ISOLATED_DOCKER",
    "JUDGE_UID",
    "JUDGE_GID",
  ];
  const lines = safeKeys
    .filter((key) => (env[key] ?? "") !== "")
    .map((key) => `${key}=${env[key]}`);
  // URL 类值再脱敏一层：即便 REDIS_URL 将来被加进白名单，口令也不会泄露。
  const urlKeys = ["REDIS_URL", "REDIS_CHECK_URL"];
  for (const key of urlKeys) {
    const value = env[key] ?? "";
    if (value !== "") lines.push(`${key}=${redactUrl(value)}`);
  }
  return lines;
}

/** `logs` 的注入点。 */
export interface JudgeLogsOptions extends JudgeActionOptions {
  /** 是否 `--follow`。 */
  follow?: boolean;
  /** 尾部行数（缺省 200，与 T14 同一默认）。 */
  tail?: number;
}

/**
 * `logs`：`compose logs --tail=<n> [--follow]`。
 *
 * `--follow` 必须走 `runner.stream`（与 T14 的同一结论）：缓冲的 `run` 会一直
 * 不返回、用户看不到任何输出。runner 不支持 `stream` 时**明确报错**，
 * 不静默退化成"看起来卡住"的缓冲调用。
 */
export async function judgeLogs(
  opts: JudgeLogsOptions,
): Promise<JudgeActionResult> {
  const log = opts.log ?? (() => {});
  const prepared = await prepareExisting(opts);
  if (!prepared.ok) return prepared.result;
  const { paths } = prepared;

  const command = ["logs", `--tail=${opts.tail ?? 200}`];
  if (opts.follow === true) command.push("--follow");
  const args = judgeComposeArgs(paths, command);

  if (opts.dryRun === true) {
    log(`[dry-run] 将执行：docker ${args.join(" ")}`);
    return { exitCode: 0, message: "[dry-run] 未读取日志", paths };
  }

  if (opts.follow === true) {
    if (opts.runner.stream === undefined) {
      return fail(
        paths,
        1,
        "当前运行时不支持实时日志（CommandRunner.stream 缺失）",
      );
    }
    const code = await opts.runner.stream(
      opts.dockerBin ?? "docker",
      args,
      (line) => log(line),
    );
    if (code !== 0) {
      return fail(paths, 1, `查看 Judge 日志失败（退出码 ${code}）`);
    }
    return { exitCode: 0, message: "已跟随 Judge 日志", paths };
  }

  const res = await runComposeCapture(opts, paths, command);
  if (res.stdout !== "") log(res.stdout);
  if (res.code !== 0) {
    return fail(
      paths,
      1,
      `查看 Judge 日志失败（docker compose 退出码 ${res.code}）`,
    );
  }
  return { exitCode: 0, message: "已输出 Judge 日志", paths };
}

/**
 * `upgrade`：拉取配置里的版本并重建（bash `upgrade` 的等价）。
 *
 * 版本来源是**配置里的 `NOJ_VERSION`**（用户先改配置再升级），与
 * T16 的 `update` 取舍一致——自动选最新版本需要网络查询与额外的可信源，
 * 而那属于生产侧 `update --latest` 的职责。
 */
export async function judgeUpgrade(
  opts: JudgeActionOptions,
): Promise<JudgeActionResult> {
  const log = opts.log ?? (() => {});
  const prepared = await prepareExisting(opts);
  if (!prepared.ok) return prepared.result;
  const { paths, env } = prepared;

  const version = env["NOJ_VERSION"] ?? "";
  if (version === "") {
    return fail(paths, 2, "配置缺少 NOJ_VERSION，无法升级");
  }
  log(`✓ 目标版本：${version}`);

  if (opts.dryRun === true) {
    log("[dry-run] 将重渲染 Compose（写入目标版本）并重建 Judge 容器");
    return { exitCode: 0, message: `[dry-run] 将升级到 ${version}`, paths };
  }

  // ---- write_compose（bash `upgrade_worker`:890）----
  // **必须先重渲染**：`renderJudgeCompose` 把版本**烘成字面量**
  // （`image: "…/noj-judge:${version}"`，compose.ts:114），不像
  // `docker-compose.prod.yml` 用 `${NOJ_VERSION}` 插值。因此只改
  // `NOJ_VERSION` 再 pull/up，拉到的仍是**旧 tag** 的镜像——
  // 结果是"报成功但版本没变"的空升级（评审用真实 compose 复现）。
  // bash 的 `upgrade_worker` 正是靠这行 `write_compose` 避免该问题。
  try {
    const yaml = renderJudgeCompose(env);
    await Deno.writeTextFile(paths.composeFile, yaml);
    await Deno.chmod(paths.composeFile, JUDGE_COMPOSE_MODE);
    log(`✓ 已重渲染 Compose 配置：${paths.composeFile}`);
  } catch (err) {
    return fail(paths, 1, `重渲染 Compose 配置失败：${(err as Error).message}`);
  }

  if (await runCompose(opts, paths, ["pull"]) !== 0) {
    return fail(paths, 1, "拉取 Judge 镜像失败");
  }
  if (await runCompose(opts, paths, ["up", "-d", "--force-recreate"]) !== 0) {
    return fail(paths, 1, "重建 Judge 容器失败");
  }
  log(`✓ Judge 已升级到 ${version}`);
  return { exitCode: 0, message: `Judge 已升级到 ${version}`, paths };
}

// ---------------- 内部辅助 ----------------

/** 执行一条 compose 子命令，返回退出码（dry-run 时**不调用** runner）。 */
async function runCompose(
  opts: JudgeActionOptions,
  paths: JudgePaths,
  command: string[],
): Promise<number> {
  if (opts.dryRun === true) return 0;
  const args = judgeComposeArgs(paths, command);
  try {
    return (await opts.runner.run(opts.dockerBin ?? "docker", args)).code;
  } catch {
    return 1;
  }
}

/** 执行一条 compose 子命令并捕获输出（仅用于文本查询）。 */
async function runComposeCapture(
  opts: JudgeActionOptions,
  paths: JudgePaths,
  command: string[],
): Promise<{ code: number; stdout: string }> {
  if (opts.dryRun === true) return { code: 0, stdout: "" };
  const args = judgeComposeArgs(paths, command);
  try {
    const res = await opts.runner.run(opts.dockerBin ?? "docker", args);
    return { code: res.code, stdout: res.stdout };
  } catch {
    return { code: 1, stdout: "" };
  }
}

/** 构造失败结果并写人类日志。 */
function fail(
  paths: JudgePaths,
  exitCode: number,
  message: string,
): JudgeActionResult {
  return { exitCode, message, paths };
}

/** 是否属于"用法/前置错误"（退出码 2）。 */
function isUsage(err: unknown): boolean {
  return err instanceof UsageError;
}

/** `-f` 语义。 */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/** `uname -m` 的缺省实现。 */
function hostArchDefault(): string {
  switch (Deno.build.arch) {
    case "x86_64":
      return "x86_64";
    case "aarch64":
      return "aarch64";
    default:
      return Deno.build.arch;
  }
}

/** dry-run 首装时用于校验的默认值集合（不落盘）。 */
function defaultsForDryRun(): Record<string, string> {
  return {
    NOJ_VERSION: "v0.9.5",
    REDIS_URL: "redis://127.0.0.1:6379/0",
    REDIS_CHECK_URL: "redis://127.0.0.1:6379/0",
    JUDGE_DOCKER_SOCKET: "/run/noj-judge/docker.sock",
    JUDGE_DOCKER_SOCKET_GID: "10001",
    JUDGE_QUEUE: "noj:judge:queue",
    RESULT_QUEUE: "noj:judge:results",
    WORK_DIR: "/tmp/noj-judge",
    JUDGE_MAX_CONCURRENT_JUDGES: "2",
    JUDGE_IMAGE_PREFIX: "noj-",
    JUDGE_IMAGE_REGISTRY: "ghcr.io/neuro-oj",
    JUDGE_DOCKER_HOST: "unix:///run/noj-judge/docker.sock",
    JUDGE_REQUIRE_ISOLATED_DOCKER: "true",
    JUDGE_UID: "10001",
    JUDGE_GID: "10001",
  };
}
