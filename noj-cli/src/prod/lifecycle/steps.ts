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
 *
 * 本模块不持有任何模块级可变状态（AGENTS.md §8.2 多副本约束）：只有常量与纯函数。
 */

import { join } from "@std/path";
import {
  checkEnvFileMode,
  judgeEnabledError,
  validateEnv,
} from "../../core/config-schema.ts";
import { readEnvFile } from "../../core/env-file.ts";
import type { CommandRunner } from "../../runtime/command.ts";
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
