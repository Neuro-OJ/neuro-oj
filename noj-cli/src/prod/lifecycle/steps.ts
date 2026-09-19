/**
 * 生产生命周期的共享步骤（T13）：compose 编排 + 前置校验。
 *
 * 从 `lifecycle.ts`（T12 时 715 行仅 `install`）抽出的可复用编排段；
 * **命令入口仍留在 `lifecycle.ts`**，本模块只放被多个动作共享的"步骤"。
 * T14–T16（logs / uninstall / update）在此追加步骤，不再堆进 `lifecycle.ts`。
 *
 * ## 边界（不得越界）
 *
 * 1. **不改 T10 公开契约**：`up` 走 `prod/compose.ts` 的既有命名封装；
 *    `stop`/`pull` 这类 T10 没有命名封装的裸子命令，经 {@link runComposeSub}
 *    用 T10 的 `composeArgs` 组装纯参数数组再交给 runner，绝不拼 shell 字符串。
 * 2. **runner 不替调用方打印**（T10 carry-forward）：compose 输出经
 *    {@link composeOutputText} 交回调用方，由其写往 stderr / 注入的 io。
 * 3. **一切外部命令经注入的 {@link CommandRunner}**；文件系统访问只有 stat/read，
 *    测试用临时目录（不碰真实部署目录）。
 * 4. **前置校验复用 T11/T12 的既有判定**（`checkEnvFileMode` /
 *    `checkRequiredValues` / `judgeEnabledError`），本模块不重写一套。
 * 5. **T15**：`uninstall` 的 docker/daemon/compose 前置（bash
 *    `check_uninstall_dependencies`）与 `--all` 的安装目录守卫
 *    （`remove_install_directory`/`validate_install_directory`）也进本模块——
 *    它们与 `prepareAndCheck` 同属「命令变更任何东西之前必须通过」的判定。
 *    安装目录特征文件消费 `profile.ts` 的 {@link PRODUCTION_MARKERS} 单一事实源，
 *    不新增第二份标记清单（T5/T12 carry-forward）。
 *
 * 本模块不持有任何模块级可变状态（AGENTS.md §8.2 多副本约束）：只有常量与纯函数。
 */

import { join } from "@std/path";
import { PRODUCTION_MARKERS } from "../../profile.ts";
import {
  checkEnvFileMode,
  judgeEnabledError,
  validateEnv,
} from "../../core/config-schema.ts";
import { readEnvFile } from "../../core/env-file.ts";
import type { CommandRunner } from "../../runtime/command.ts";
import { type ColorMode, resolveColor } from "../../util/color.ts";
import {
  checkJudgeSocket,
  checkPortValue,
  checkRequiredValues,
} from "../config.ts";
import type { EnvValues, RequiredValuesReport } from "../config.ts";
import {
  composeArgs,
  composeConfig,
  PROD_COMPOSE_FILE,
  PROD_ENV_FILE,
} from "../compose.ts";
import type { ComposeOptions, ComposeResult } from "../compose.ts";

// ---------------- 共享文件原语 ----------------

/** `-f` 语义的普通文件判定。 */
export async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/**
 * 读文件的八进制权限串（`stat -c %a` 的等价）。
 *
 * 返回 `{ isFile, mode }`：`mode` 读不出时为 null，交由 T11
 * {@link checkEnvFileMode} 产出与 bash :658-665 一致的报错。
 */
export async function statMode(path: string): Promise<{
  isFile: boolean;
  mode: string | null;
}> {
  try {
    const st = await Deno.stat(path);
    return {
      isFile: st.isFile,
      mode: ((st.mode ?? 0) & 0o777).toString(8).padStart(3, "0"),
    };
  } catch {
    return { isFile: false, mode: null };
  }
}

/** 读取 `.env.prod` 为 {@link EnvValues}。 */
export async function readEnvValues(path: string): Promise<EnvValues> {
  const map = await readEnvFile(path);
  const out: EnvValues = {};
  for (const [key, value] of map) out[key] = value;
  return out;
}

/**
 * judge 是否启用：**镜像 T2 `validateEnv` 的真值表**，不新增第三份字面集合。
 *
 * 在"仅含 JUDGE_ENABLED 的探针输入"上跑 T2 的 `validateEnv`，看它是否要求
 * `JUDGE_KEYS[0]`：要求即启用。空串/未设置 → 按启用处理（deploy.sh:679）。
 *
 * T12 时该判定在 `config.ts` 与 `lifecycle.ts` 各有一份；本模块收敛
 * `lifecycle` 侧的唯一实现，`install` 与四个生命周期命令共用。
 * （`config.ts` 的私有同名函数仍服务于 T11 向导，见 task-12 报告 Minor 3。）
 */
export function judgeEnabledFrom(env: EnvValues): boolean {
  const probe = validateEnv({ JUDGE_ENABLED: env["JUDGE_ENABLED"] ?? "" });
  return probe.missing.includes("JUDGE_DOCKER_SOCKET");
}

/**
 * T11 配置校验入口：**先** `judgeEnabledError` → **再** `checkRequiredValues`。
 *
 * 顺序是 T11 carry-forward 的硬要求：`validateEnv`（`checkRequiredValues` 的
 * 第一步）装不下 `JUDGE_ENABLED` 的枚举错误，非法值必须先被 `judgeEnabledError`
 * 拒绝。judge **未设置/空串 = 启用**（deploy.sh:679）。
 */
export function assertConfiguration(env: EnvValues): RequiredValuesReport {
  const judgeError = judgeEnabledError(env["JUDGE_ENABLED"]);
  if (judgeError !== null) throw new Error(judgeError);
  const report = checkRequiredValues(env);
  if (!report.ok) {
    throw new Error("生产配置校验失败：\n" + report.errors.join("\n"));
  }
  return report;
}

// ---------------- prepare_and_check（deploy.sh:994-997） ----------------

/** {@link prepareAndCheck} 的成功分支：已定位并校验的安装环境。 */
export interface PreparedEnvironment {
  ok: true;
  /** 归一化安装目录（无尾斜杠）。 */
  dir: string;
  envFile: string;
  composeFile: string;
  /** `.env.prod` 的键值（含未设置键的 undefined）。 */
  env: EnvValues;
  /** judge 是否启用（决定 compose 是否带 `--profile judge`）。 */
  judge: boolean;
}

/** {@link prepareAndCheck} 的失败分支：面向用户的错误文本。 */
export interface PrepareFailure {
  ok: false;
  error: string;
}

/** {@link prepareAndCheck} 的结果。 */
export type PrepareResult = PreparedEnvironment | PrepareFailure;

/** compose 配置无效的报错前缀（deploy.sh:906 的 `fail` 逐字）。 */
export const COMPOSE_CONFIG_INVALID_HINT =
  "Docker Compose 配置无效，请检查环境变量和生产 Compose 文件";

/**
 * {@link prepareAndCheck} 的注入点。
 *
 * `runner` 必填：步骤 6（`compose config --quiet`）必须真实执行 compose 解析。
 * 步骤 4/5 的**环境探测**（socket / 端口占用）各留一个注入点，缺省即为 bash 的
 * "已跳过"/"无 lsof"分支，测试与无真实机器场景都不会误触。
 */
export interface PrepareOptions {
  /** 生产安装目录（已归一化）。 */
  dir: string;
  /** 外部命令注入点（docker，步骤 6）。 */
  runner: CommandRunner;
  /**
   * 步骤 4：judge socket 存在性探测（T11 {@link checkJudgeSocket} 的注入点）。
   *
   * 仅在 judge 启用时被调用；judge 关闭走 bash 的「已跳过」分支，**不探测**。
   */
  socketExists?: (path: string) => Promise<boolean>;
  /**
   * 步骤 5：端口占用探测（`lsof -nP -iTCP:<port> -sTCP:LISTEN` 的注入点）。
   *
   * 缺省不探测：`checkPortValue` 的端口*取值*校验（纯计算）始终执行，只有
   * `lsof` 这类真实环境探测被延后到注入方（bash 的 `command -v lsof`）。
   */
  probePort?: (port: number) => Promise<boolean>;
  /** 步骤 5 端口冲突告警的写出点；缺省丢弃（调用方决定 stdout/stderr）。 */
  write?: StepSink;
}

/**
 * 迁移 `prepare_and_check`（deploy.sh:994-997）：`check_dependencies` 的
 * **文件判定** + `check_configuration`（:893-913）的**全六步**。
 *
 * bash 的 `prepare_and_check = check_dependencies + check_configuration`。
 * `check_dependencies`（:820-836）里的 docker 存在性 / daemon / buildx 三条
 * 属环境探测面，未接线（T12 报告 §6.4 登记）；其余按 bash 同序迁移：
 *
 * | # | bash（源行） | 本函数 | 环境探测的注入点 |
 * | --- | --- | --- | --- |
 * | — | `check_dependencies`: `[[ -f "$COMPOSE_FILE" ]]`（:833） | {@link isFile} | 无（纯文件判定） |
 * | 1 | `check_configuration`: `[[ -f "$ENV_FILE" ]]`（:894） | {@link isFile} | 无 |
 * | 2 | `check_file_permissions`（:658，600/400） | {@link statMode} + `checkEnvFileMode`（T11） | 无 |
 * | 3 | `check_required_values`（:684） | {@link assertConfiguration}（T11） | 无 |
 * | 4 | `check_judge_socket`（:768）；judge 关闭时 `ok "已跳过…"` | {@link checkJudgeSocket}（T11） | `socketExists`（缺省不探测） |
 * | 5 | `check_port_value`（:780） | {@link checkPortValue}（T11）：取值校验恒跑；`lsof` 占用告警 | `probePort`（缺省不探测） |
 * | 6 | `run_compose config --quiet`（:904） | {@link composeConfig}（T10） | `runner`（必填） |
 *
 * 六步全部迁移（T13 评审 Important）：步骤 4 复用 T11 `checkJudgeSocket`、
 * 步骤 6 复用 T10 `composeConfig`，**不重写判定**。第 4/5 步的"真实环境探测"
 * 通过注入点表达——测试注入 fake，生产注入真实实现；不注入即对应 bash 的
 * 「已跳过」「`command -v lsof` 不命中」分支。
 *
 * **零副作用**：步骤 1–5 不调用任何 docker；唯一的 docker 调用是第 6 步的
 * `compose config`（**只读解析**，非变更命令）。任一失败都在任何 `up`/`stop`/
 * `down` 之前返回错误，由命令入口转成退出码 1。
 */
export async function prepareAndCheck(
  opts: PrepareOptions,
): Promise<PrepareResult> {
  const dir = opts.dir;
  const envFile = join(dir, PROD_ENV_FILE);
  const composeFile = join(dir, PROD_COMPOSE_FILE);

  // ---- check_dependencies 的文件判定（bash :833，先于 check_configuration）----
  if (!(await isFile(composeFile))) {
    return {
      ok: false,
      error: `找不到生产 Compose 文件：${composeFile}，请先执行 install`,
    };
  }

  // ---- 1. [[ -f "$ENV_FILE" ]]（:894）----
  if (!(await isFile(envFile))) {
    return { ok: false, error: `找不到生产配置：${envFile}，请先执行 install` };
  }

  // ---- 2. check_file_permissions（:658）----
  const { mode } = await statMode(envFile);
  const verdict = checkEnvFileMode(mode, envFile);
  if (verdict.kind !== "ok") return { ok: false, error: verdict.message };

  // ---- 3. check_required_values（:684）----
  const env = await readEnvValues(envFile);
  let report: RequiredValuesReport;
  try {
    report = assertConfiguration(env);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  // ---- 4. check_judge_socket（:768）；judge 关闭 → bash 的「已跳过」分支 ----
  if (report.judgeEnabled) {
    const socket = await checkJudgeSocket(env, {
      socketExists: opts.socketExists,
    });
    if (!socket.ok) {
      return {
        ok: false,
        error: socket.error ?? "Judge Docker socket 校验失败",
      };
    }
  }

  // ---- 5. check_port_value（:780）：取值恒校验，占用探测经注入点 ----
  const port = await checkPortValue(env);
  if (port.error !== null) return { ok: false, error: port.error };
  if (opts.probePort !== undefined && (await opts.probePort(port.port))) {
    opts.write?.(port.warning ?? PORT_CONFLICT_HINT(port.port));
  }

  // ---- 6. run_compose config --quiet（:904，只读解析）----
  const composeOptions: ComposeOptions = {
    composeFile,
    envFile,
    judge: report.judgeEnabled,
  };
  const configCheck = await composeConfig(opts.runner, composeOptions);
  if (!Array.isArray(configCheck) && configCheck.code !== 0) {
    const detail = configCheck.stderr.trim();
    return {
      ok: false,
      error: detail === ""
        ? COMPOSE_CONFIG_INVALID_HINT
        : `${COMPOSE_CONFIG_INVALID_HINT}：${detail}`,
    };
  }

  return {
    ok: true,
    dir,
    envFile,
    composeFile,
    env,
    judge: report.judgeEnabled,
  };
}

// ---------------- compose 编排 ----------------

/**
 * 执行一条裸 compose 子命令（T10 未提供命名封装的 `stop` / `pull` 等）。
 *
 * 必须在调用点用 `Array.isArray` 收窄 `ComposeResult`（T10 carry-forward）。
 */
export function runComposeSub(
  runner: CommandRunner,
  options: ComposeOptions,
  command: string[],
): Promise<ComposeResult> {
  return runner.run("docker", composeArgs({ ...options, command }));
}

/**
 * 把 compose 输出转成待写文本（T10 carry-forward：runner 不打印）。
 *
 * `dryRun` 的参数数组无输出，返回空串；否则 stdout 在前、stderr 在后，
 * 由调用方决定写往 stdout 还是 stderr。
 */
export function composeOutputText(result: ComposeResult): string {
  if (Array.isArray(result)) return "";
  return result.stdout + result.stderr;
}

/** 步骤输出的汇聚点：人类可读诊断，调用方决定去 stdout / stderr。 */
export type StepSink = (text: string) => void;

// ---------------- logs 着色契约（T14，deploy.sh:1117-1158） ----------------
//
// bash `logs()` 有一套**明确**的着色优先级，且有评审修复历史：早先无条件透传，
// 导致 `noj-cli logs core > out.txt` 把 docker compose 的 ANSI 转义码写进重定向
// 文件。本节把该契约收敛为三个纯函数，**不新增第二套** `NO_COLOR`/`LOG_COLOR`
// 解析：取值合并在上层，最终开/关判定仍交回 `util/color.ts:resolveColor`。

/**
 * 合并着色来源：**进程环境优先（非空即胜出），否则回退 `.env.prod`**。
 *
 * 对照 bash（deploy.sh:1137-1144）：
 * ```bash
 * log_color="${LOG_COLOR-}"
 * if [[ -z "$log_color" ]]; then log_color="$(env_value LOG_COLOR ...)"; fi
 * ```
 *
 * 注意判定用的是**未 trim** 的原始值：bash 的 `-z` 也发生在 trim 之前，
 * 因此进程环境里的纯空白值会「占位」而不回退到 `.env.prod`（本函数逐字保持）。
 *
 * @param processValue 进程环境值（`undefined` = 未设置）
 * @param fileValue `.env.prod` 的值（`undefined` = 未设置）
 */
export function mergeColorSource(
  processValue: string | undefined,
  fileValue: string | undefined,
): string {
  if (processValue !== undefined && processValue !== "") return processValue;
  return fileValue ?? "";
}

/**
 * logs 的着色决策（bash :1136-1154 三分支的等价枚举）。
 *
 * - `"no-color"`：传 `--no-color`（`NO_COLOR` 非空 **或** `LOG_COLOR=never`，
 *   或回退分支判定为关）；
 * - `"force"`：传**全局** `--ansi always`（`LOG_COLOR=always`）；
 * - `"inherit"`：既不加 `--no-color` 也不强制——把着色交回 compose 自身探测
 *   （**不是**「开」：`docker compose logs` 没有单命令的强制开开关，见下）。
 */
export type LogsColorDecision = "no-color" | "force" | "inherit";

/**
 * {@link decideLogsColor} 的输入：两个已由 {@link mergeColorSource} 合并的原始值。
 *
 * **刻意不含 `--color`**：bash `logs()` 的着色契约（T14 brief 规则 3）只有
 * `LOG_COLOR` / `NO_COLOR` / stdout TTY 三个输入；`--color` 只作用于本进程的
 * 人类输出主题（`lifecycleContext`），不参与 compose 色旗的推导。把 `--color`
 * 混进来会让 `--color=never` 压过 `LOG_COLOR=always`，与 bash 不一致。
 */
export interface LogsColorOptions {
  /** 已合并的 `LOG_COLOR` 原始值（未 trim）。 */
  logColor?: string;
  /** 已合并的 `NO_COLOR` 原始值（未 trim）。 */
  noColor?: string;
  /** `resolveColor` 探测的流；缺省 stdout（对应 bash `[[ -t 1 ]]`）。 */
  stream?: "stdout" | "stderr";
}

/**
 * 判定 logs 的着色决策——**分支顺序逐字对照** deploy.sh:1145-1154。
 *
 * ```bash
 * if [[ -n "$no_color" ]] || [[ "$log_color" == "never" ]]; then
 *   args+=(--no-color)
 * elif [[ "$log_color" == "always" ]]; then
 *   COMPOSE_FORCE_ANSI=1 # 由 run_compose 转成全局 `--ansi always`
 * elif [[ ! -t 1 ]]; then
 *   args+=(--no-color)
 * fi
 * ```
 *
 * **分支 1 在前**：`NO_COLOR` 非空时即使 `LOG_COLOR=always` 也关色。`LOG_COLOR`
 * 大小写不敏感、首尾空白被归一（与 TS 侧既有的 trim+toLowerCase 一致）。
 *
 * 前两个分支是 bash 的显式判定，命中即短路；**其余情况**（含 `LOG_COLOR` 未设置、
 * 取值无法识别）一律回退到 `resolveColor`——着色开/关的**唯一**判定源。因此
 * `--color=never` / `NO_COLOR` / 非 TTY 这三条既有规则不会在此漂移。
 */
export function decideLogsColor(
  options: LogsColorOptions = {},
): LogsColorDecision {
  const logColor = (options.logColor ?? "").trim().toLowerCase();

  // 把「合并后的有效 LOG_COLOR / NO_COLOR」翻译成 resolveColor 接受的 mode 入参：
  // - NO_COLOR 非空 **或** LOG_COLOR=never → `never`（bash 分支 1；NO_COLOR 在前，
  //   即使 LOG_COLOR=always 也关）；
  // - LOG_COLOR=always → `always`（bash 分支 2，强制）；
  // - 其余 → `auto`（bash 分支 3 的 TTY 探测；resolveColor 内部再读进程 LOG_COLOR
  //   时与合并值一致，因为此时合并值本就来自进程环境或无法识别）。
  let mode: ColorMode = "auto";
  if ((options.noColor ?? "") !== "") mode = "never";
  else if (logColor === "never") mode = "never";
  else if (logColor === "always") mode = "always";

  // **唯一着色判定源**：stdout 非 TTY（重定向）→ false → --no-color，这正是
  // 「重定向不写 ANSI」的落点。
  if (!resolveColor(mode, options.stream ?? "stdout")) return "no-color";
  // 判为「开」时再区分语义：模式为 always（来自 LOG_COLOR=always）才是**强制**
  // （全局 --ansi always）；auto + TTY 只是把决定权交回 compose 自身探测。
  return mode === "always" ? "force" : "inherit";
}

/**
 * 把着色决策落到 T10 `composeLogs` 产出的参数数组上。
 *
 * **强制着色必须用子命令之前的全局 `--ansi always`**：`docker compose logs`
 * 只有 `--no-color`，**没有**单命令的「强制开」开关——省略 `--no-color` 只是把
 * 决定权交回 compose 自己的 TTY 探测，并不等于「开」（deploy.sh:1128-1134 的
 * 评审注释明确记录此坑）。`--ansi` 是全局旗标，必须排在子命令之前，故在
 * `logs` 之前插入，而不是追加到数组末尾。
 *
 * `no-color` 则插在 `--tail=200` / `--follow` 之后、位置参数（服务名）之前，
 * 与 bash `args+=(--no-color)` 早于 `args+=("${POSITIONAL[@]}")` 的顺序一致。
 *
 * 输入是 T10 的参数形状（`composeLogs` 的 dryRun 结果），因此 tail / follow /
 * services 的相对顺序由 T10 保证，这里只做两处插入，不重排任何既有元素。
 */
export function applyLogsColor(
  args: string[],
  decision: LogsColorDecision,
): string[] {
  const out = [...args];
  const sub = out.indexOf("logs");
  if (sub === -1) {
    throw new Error("compose 参数缺少 logs 子命令：" + args.join(" "));
  }
  if (decision === "force") {
    out.splice(sub, 0, "--ansi", "always");
    return out;
  }
  if (decision === "no-color") {
    // 跳过 logs 之后的旗标（--tail=200 / --follow），插在首个位置参数之前。
    let at = sub + 1;
    while (at < out.length && out[at]!.startsWith("--")) at++;
    out.splice(at, 0, "--no-color");
  }
  return out;
}

/**
 * `wait_for_stack`（:981-993）：健康等待 + 反向代理刷新，逐字对齐两段 compose。
 *
 * ```bash
 * run_compose up -d --wait --wait-timeout 180 --remove-orphans ||
 *   fail "服务启动或健康检查失败，请执行 status 和 logs 排查"
 * run_compose up -d --force-recreate --no-deps nginx ||
 *   fail "反向代理刷新失败，请执行 status 和 logs 排查"
 * ```
 *
 * **T12 的缺口在本任务闭合**：`install` 此前只跑 `up -d --wait`，缺
 * `--wait-timeout 180 --remove-orphans` 与第二段 nginx 刷新（task-12 报告 §6.2）。
 * 现在 install 与 start 共用本函数——bash 的 `install()`(:1006) 同样调用
 * `wait_for_stack`。
 *
 * 失败**不抛错**：返回 `{ ok:false, error }`，由命令入口决定退出码（install 抛错、
 * 生命周期命令返回 1），错误文本与 bash `fail` 逐字一致。返回值同时带第一段
 * `code`（成功真值），供 install 结果如实记录 `composeUpCode`——不再硬编码 0。
 */
export async function waitForStack(
  runner: CommandRunner,
  options: ComposeOptions,
  write: StepSink,
): Promise<WaitForStackResult> {
  write("\n== 等待服务健康 ==\n");

  const healthy = await runComposeSub(runner, options, [
    "up",
    "-d",
    "--wait",
    "--wait-timeout",
    WAIT_TIMEOUT_SECONDS,
    "--remove-orphans",
  ]);
  write(composeOutputText(healthy));
  if (!Array.isArray(healthy) && healthy.code !== 0) {
    return { ok: false, error: WAIT_FAILURE_HINT, code: healthy.code };
  }

  const nginx = await runComposeSub(runner, options, [
    "up",
    "-d",
    "--force-recreate",
    "--no-deps",
    "nginx",
  ]);
  write(composeOutputText(nginx));
  if (!Array.isArray(nginx) && nginx.code !== 0) {
    return { ok: false, error: NGINX_REFRESH_FAILURE_HINT, code: nginx.code };
  }

  write("✓ 生产服务已通过 Compose 健康检查\n");
  return { ok: true, error: null, code: 0 };
}

/**
 * {@link waitForStack} 的结果。
 *
 * `code` 是**第一段** `up -d --wait --wait-timeout 180 --remove-orphans` 的
 * compose 退出码：成功恒为 0；失败时即真实非零码（同时 `ok=false` 且 `error`
 * 为 bash `fail` 文案）。调用方据此填写 `InstallResult.composeUpCode`，
 * 而不是硬编码 `0`——bash 的 `wait_for_stack` 失败即 `fail` 退出，
 * 因此本模块的`ok=true` 分支也必然是真 0。
 */
export interface WaitForStackResult {
  ok: boolean;
  error: string | null;
  /** 第一段 `up` 的 compose 退出码（成功即 0）。 */
  code: number;
}

/** `--wait-timeout` 的秒数（deploy.sh:987）。 */
export const WAIT_TIMEOUT_SECONDS = "180";

/** 健康等待失败文案（deploy.sh:988 的 `fail` 逐字）。 */
export const WAIT_FAILURE_HINT =
  "服务启动或健康检查失败，请执行 status 和 logs 排查";

/** 反向代理刷新失败文案（deploy.sh:990 的 `fail` 逐字）。 */
export const NGINX_REFRESH_FAILURE_HINT =
  "反向代理刷新失败，请执行 status 和 logs 排查";

/**
 * 端口占用告警文案（deploy.sh:784 的 `warn` 逐字，仅端口号参数化）。
 *
 * 缺省探测关闭时不会用到；`checkPortValue` 自身也产出同形文案，此处供
 * {@link prepareAndCheck} 在**注入** `probePort` 时统一措辞。
 */
export function PORT_CONFLICT_HINT(port: number): string {
  return `NGINX_PORT=${port} 已被其他进程监听；启动时可能发生端口冲突`;
}

// ---------------- uninstall 前置与安装目录守卫（T15） ----------------
//
// 两段 bash 被收敛到这里：
// 1. `check_uninstall_dependencies`（deploy.sh:1085-1096）：docker CLI / daemon /
//    compose v2 / `.env.prod` / compose 文件五条前置，**任一缺失即拒绝**；
// 2. `validate_install_directory` + `remove_install_directory`
//    （production.sh:167-182）：`--all` 直接 `rm -rf` 安装目录前的守卫
//    （目录形态 → 安装完整性 → **Git 工作区拒绝** → 危险路径拒绝）。
//
// 为什么放在共享步骤模块：两者与 `prepareAndCheck` 同类——都是「命令变更任何东西
// 之前必须通过」的判定，且被 `uninstall` 与（后续）`update` 复用。

/** docker CLI 缺失文案（deploy.sh:1088 逐字，仅二进制名参数化）。 */
export function dockerMissingHint(dockerBin: string): string {
  return `找不到 Docker CLI：${dockerBin}`;
}

/** daemon 不可用文案（deploy.sh:1089 逐字）。 */
export const UNINSTALL_DAEMON_HINT = "Docker daemon 未运行或当前用户无权限";

/** Compose v2 不可用文案（deploy.sh:1091 逐字）。 */
export const UNINSTALL_COMPOSE_HINT = "Docker Compose v2 不可用";

/** `.env.prod` 缺失文案（deploy.sh:1092 逐字）。 */
export function uninstallEnvMissingHint(envFile: string): string {
  return `找不到生产配置：${envFile}；无法安全定位生产 Compose 栈`;
}

/** compose 文件缺失文案（deploy.sh:1093 逐字）。 */
export function uninstallComposeMissingHint(composeFile: string): string {
  return `找不到生产 Compose 文件：${composeFile}`;
}

/** 工作区拒绝文案（production.sh:173 逐字）。 */
export const UNINSTALL_WORKSPACE_HINT =
  "检测到 Git 工作区，拒绝删除源码目录；请在生产安装目录执行 uninstall --all";

/** 危险路径拒绝文案（production.sh:175 逐字）。 */
export function uninstallUnsafePathHint(dir: string): string {
  return `拒绝删除危险安装路径：${dir}`;
}

/** 安装目录形态不符文案（production.sh:169 逐字）。 */
export function uninstallNotADirHint(dir: string): string {
  return `当前安装目录不存在或不是普通目录：${dir}`;
}

/** 安装目录不完整文案（production.sh:171 逐字）。 */
export function uninstallIncompleteDirHint(dir: string): string {
  return `当前目录不是完整的 NOJ 安装目录，拒绝完全删除：${dir}`;
}

/**
 * `check_uninstall_dependencies`（deploy.sh:1085-1096）：卸载前的五条前置。
 *
 * 逐条顺序：`docker --version` → `docker info` → `docker compose version` →
 * `.env.prod` 存在 → compose 文件存在；**任一失败立即返回错误**，由调用方转成
 * 退出码 1 且**零 compose down**。
 *
 * 返回 {@link PreparedEnvironment} 的原因：compose down **必须覆盖全部 profile**
 * （bash `INCLUDE_ALL_PROFILES=1`，见 `uninstall()` :1101），因此这里顺带解析
 * `.env.prod` 得出 `judge` 旗标；但解析失败**不阻断卸载**（配置不完整恰恰是
 * 卸载的常见场景）——失败时按 judge 启用处理，宁可多带一个 profile 也不漏删。
 */
export async function checkUninstallDependencies(opts: {
  dir: string;
  runner: CommandRunner;
  /** docker 可执行名（`NOJ_DEPLOY_DOCKER_BIN` 的等价）。 */
  dockerBin?: string;
}): Promise<PrepareResult> {
  const dockerBin = opts.dockerBin ?? "docker";
  const envFile = join(opts.dir, PROD_ENV_FILE);
  const composeFile = join(opts.dir, PROD_COMPOSE_FILE);

  if ((await opts.runner.run(dockerBin, ["--version"])).code !== 0) {
    return { ok: false, error: dockerMissingHint(dockerBin) };
  }
  if ((await opts.runner.run(dockerBin, ["info"])).code !== 0) {
    return { ok: false, error: UNINSTALL_DAEMON_HINT };
  }
  if ((await opts.runner.run(dockerBin, ["compose", "version"])).code !== 0) {
    return { ok: false, error: UNINSTALL_COMPOSE_HINT };
  }
  if (!(await isFile(envFile))) {
    return { ok: false, error: uninstallEnvMissingHint(envFile) };
  }
  if (!(await isFile(composeFile))) {
    return { ok: false, error: uninstallComposeMissingHint(composeFile) };
  }

  let env: EnvValues = {};
  let judge = true;
  try {
    env = await readEnvValues(envFile);
    judge = assertConfiguration(env).judgeEnabled;
  } catch {
    // 配置不完整/非法：卸载不能因此被卡住，按 judge 启用处理（多 profile 无害）。
    judge = true;
  }

  return { ok: true, dir: opts.dir, envFile, composeFile, env, judge };
}

/** `-e` 语义（含悬空软链）的存在性判定。 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * `--all` 的安装目录守卫（`validate_install_directory`, production.sh:167-182）。
 *
 * 四条检查逐条对照：
 * 1. `[[ -d && ! -L ]] || fail "当前安装目录不存在或不是普通目录"`；
 * 2. `[[ -f bin/noj-cli && -f "$DEPLOY_SCRIPT" && -f docker-compose.prod.yml ]]`——
 *    `DEPLOY_SCRIPT` 在 TS 侧仍是安装目录内的 `scripts/deploy/deploy.sh`
 *    （T24 才删除 bash；二进制保持同形文件系统契约）。特征文件消费
 *    {@link PRODUCTION_MARKERS}（T5/T12 单一事实源），不新写标记清单；
 * 3. `[[ ! -e .git && ! -e .jj ]]` → 拒绝；**本实现有意比 bash 多查 `.jj`**：
 *    本仓 colocated 的 jj 工作区里 `.jj` 是**文件**而 `.git` 是目录，只查 `.git`
 *    会漏判纯 jj 检出（T15 brief 明写 "Git/jj 工作区"）；
 * 4. `[[ "$SCRIPT_DIR" != / && != . && != .. && != "$HOME" ]]`。
 *
 * **抛错而非返回结果**：守卫失败必须终止整个命令，返回布尔容易被调用方误当成
 * 可继续的信号；`remove_install_directory` 也是 `fail` 语义。
 */
export async function assertRemovableInstallDir(
  dir: string,
  processEnv: Record<string, string | undefined> = Deno.env.toObject(),
  opts: {
    /** 安装版 CLI 路径；缺省 `<dir>/bin/noj-cli`。 */
    cliBinary?: string;
    /** 生产部署脚本路径；缺省 `<dir>/scripts/deploy/deploy.sh`。 */
    deployScript?: string;
  } = {},
): Promise<void> {
  let st: Deno.FileInfo | null = null;
  try {
    st = await Deno.lstat(dir);
  } catch {
    st = null;
  }
  if (st === null || !st.isDirectory || st.isSymlink) {
    throw new Error(uninstallNotADirHint(dir));
  }

  const cliBinary = opts.cliBinary ?? join(dir, "bin/noj-cli");
  const deployScript = opts.deployScript ??
    join(dir, "scripts/deploy/deploy.sh");
  if (!(await isFile(cliBinary))) {
    throw new Error(`找不到生产 CLI 二进制：${cliBinary}`);
  }
  if (!(await isFile(deployScript))) {
    throw new Error(`找不到生产部署脚本：${deployScript}`);
  }
  for (const marker of PRODUCTION_MARKERS) {
    if (!(await isFile(join(dir, marker)))) {
      throw new Error(uninstallIncompleteDirHint(dir));
    }
  }

  if (
    await pathExists(join(dir, ".git")) || await pathExists(join(dir, ".jj"))
  ) {
    throw new Error(UNINSTALL_WORKSPACE_HINT);
  }

  const normalized = dir.replace(/\/+$/, "");
  const home = (processEnv["HOME"] ?? "").replace(/\/+$/, "");
  if (
    normalized === "" || normalized === "/" || normalized === "." ||
    normalized === ".." || (home !== "" && normalized === home)
  ) {
    throw new Error(uninstallUnsafePathHint(dir));
  }
}

/**
 * `remove_install_directory`（production.sh:178-182）：先守卫、再 `rm -rf`。
 *
 * 删除失败即抛错（bash `rm -rf ... || fail "无法删除 NOJ 安装目录"`）。
 */
export async function removeInstallDirectory(
  dir: string,
  processEnv: Record<string, string | undefined> = Deno.env.toObject(),
  opts: {
    cliBinary?: string;
    deployScript?: string;
  } = {},
): Promise<void> {
  await assertRemovableInstallDir(dir, processEnv, opts);
  try {
    await Deno.remove(dir, { recursive: true });
  } catch {
    throw new Error(`无法删除 NOJ 安装目录：${dir}`);
  }
}
