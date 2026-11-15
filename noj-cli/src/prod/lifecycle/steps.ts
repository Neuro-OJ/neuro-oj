/**
 * 生产生命周期的共享步骤：compose 编排 + 前置校验。
 *
 * **命令入口留在 `lifecycle.ts`**，本模块只放被多个动作（install / start /
 * stop / logs / uninstall / update）共享的"步骤"。
 *
 * ## 边界
 *
 * 1. `up` 走 `prod/compose.ts` 的命名封装；`stop`/`pull` 等裸子命令经
 *    {@link runComposeSub} 用 `composeArgs` 组装纯参数数组再交给 runner，
 *    绝不拼 shell 字符串。
 * 2. **runner 不替调用方打印**：compose 输出经
 *    {@link composeOutputText} 交回调用方，由其写往 stderr / 注入的 io。
 * 3. **一切外部命令经注入的 {@link CommandRunner}**；文件系统访问只有 stat/read，
 *    测试用临时目录（不碰真实部署目录）。
 * 4. 前置校验复用 `checkEnvFileMode` / `checkRequiredValues` /
 *    `judgeEnabledError`，本模块不重写一套。
 * 5. `uninstall` 的 docker/daemon/compose 前置与 `--all` 的安装目录守卫也在本模块——
 *    它们与 `prepareAndCheck` 同属「命令变更任何东西之前必须通过」的判定。
 *    安装目录特征文件消费 `install-dir.ts` 的 {@link PRODUCTION_MARKERS}。
 *
 * 本模块不持有任何模块级可变状态（AGENTS.md §8.2 多副本约束）：只有常量与纯函数。
 */

import { join } from "@std/path";
import { PRODUCTION_MARKERS } from "../install-dir.ts";
import {
  checkEnvFileMode,
  judgeEnabledError,
} from "../../core/config-schema.ts";
import { writeEnvFileAtomic } from "../../core/env-file.ts";
import type { CommandRunner } from "../../runtime/command.ts";
import { type ColorMode, resolveColor } from "../../util/color.ts";
import {
  backupPassphrasePath,
  checkJudgeSocket,
  checkPortValue,
  checkRequiredValues,
  ensureBackupPassphrase,
  toEntries,
} from "../config.ts";
import type { EnvValues, RequiredValuesReport } from "../config.ts";
import {
  composeArgs,
  composeConfig,
  PROD_COMPOSE_FILE,
  PROD_ENV_FILE,
} from "../compose.ts";
import type { ComposeOptions, ComposeResult } from "../compose.ts";
import { isFile, pathExists } from "../../util/fs.ts";
import { readEnvValues } from "../../core/env-file.ts";

// ---------------- 共享文件原语 ----------------

/**
 * 读文件的八进制权限串（`stat -c %a` 的等价）。
 *
 * 返回 `{ isFile, mode }`：`mode` 读不出时为 null，交由
 * {@link checkEnvFileMode} 产出报错。
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

/**
 * 配置校验入口：**先** `judgeEnabledError` → **再** `checkRequiredValues`。
 *
 * 顺序是硬要求：`validateEnv`（`checkRequiredValues` 的
 * 第一步）装不下 `JUDGE_ENABLED` 的枚举错误，非法值必须先被 `judgeEnabledError`
 * 拒绝。judge **未设置/空串 = 启用**。
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

// ---------------- prepare_and_check ----------------

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

/** compose 配置无效的报错前缀。 */
export const COMPOSE_CONFIG_INVALID_HINT =
  "Docker Compose 配置无效，请检查环境变量和生产 Compose 文件";

/**
 * {@link prepareAndCheck} 的注入点。
 *
 * `runner` 必填：步骤 6（`compose config --quiet`）必须真实执行 compose 解析。
 * 步骤 4/5 的**环境探测**（socket / 端口占用）各留一个注入点，缺省即
 * "已跳过"/"无 lsof"，测试与无真实机器场景都不会误触。
 */
export interface PrepareOptions {
  /** 生产安装目录（已归一化）。 */
  dir: string;
  /** 外部命令注入点（docker，步骤 6）。 */
  runner: CommandRunner;
  /**
   * 步骤 4：judge socket 存在性探测（{@link checkJudgeSocket} 的注入点）。
   *
   * 仅在 judge 启用时被调用；judge 关闭即「已跳过」，**不探测**。
   */
  socketExists?: (path: string) => Promise<boolean>;
  /**
   * 步骤 5：端口占用探测（`lsof -nP -iTCP:<port> -sTCP:LISTEN` 的注入点）。
   *
   * 缺省不探测：`checkPortValue` 的端口*取值*校验（纯计算）始终执行，只有
   * `lsof` 这类真实环境探测被延后到注入方。
   */
  probePort?: (port: number) => Promise<boolean>;
  /** 步骤 5 端口冲突告警的写出点；缺省丢弃（调用方决定 stdout/stderr）。 */
  write?: StepSink;
}

/**
 * 生产命令的前置校验：compose 文件存在 + 配置六步。
 *
 * docker 存在性 / daemon / buildx 属环境探测，不在此检查。
 *
 * | # | 检查 | 实现 | 环境探测的注入点 |
 * | --- | --- | --- | --- |
 * | — | compose 文件存在 | {@link isFile} | 无 |
 * | 1 | `.env.prod` 存在 | {@link isFile} | 无 |
 * | 2 | `.env.prod` 权限 600/400 | {@link statMode} + `checkEnvFileMode` | 无 |
 * | 3 | 必需键 | {@link assertConfiguration} | 无 |
 * | 4 | judge socket（judge 关闭时跳过） | {@link checkJudgeSocket} | `socketExists`（缺省不探测） |
 * | 5 | 端口取值；`lsof` 占用告警 | {@link checkPortValue} | `probePort`（缺省不探测） |
 * | 6 | `compose config --quiet` | {@link composeConfig} | `runner`（必填） |
 *
 * 第 4/5 步的真实环境探测通过注入点表达——测试注入 fake，生产注入真实实现；
 * 不注入即跳过探测。
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

  // ---- compose 文件存在（先于配置校验）----
  if (!(await isFile(composeFile))) {
    return {
      ok: false,
      error: `找不到生产 Compose 文件：${composeFile}，请先执行 install`,
    };
  }

  // ---- 1. [[ -f "$ENV_FILE" ]]----
  if (!(await isFile(envFile))) {
    return { ok: false, error: `找不到生产配置：${envFile}，请先执行 install` };
  }

  // ---- 2. check_file_permissions----
  const { mode } = await statMode(envFile);
  const verdict = checkEnvFileMode(mode, envFile);
  if (verdict.kind !== "ok") return { ok: false, error: verdict.message };

  // ---- 3. check_required_values----
  const env = await readEnvValues(envFile);
  let report: RequiredValuesReport;
  try {
    report = assertConfiguration(env);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  // ---- 4. judge socket；judge 关闭即跳过 ----
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

  // ---- 5. check_port_value：取值恒校验，占用探测经注入点 ----
  const port = await checkPortValue(env);
  if (port.error !== null) return { ok: false, error: port.error };
  if (opts.probePort !== undefined && (await opts.probePort(port.port))) {
    opts.write?.(port.warning ?? PORT_CONFLICT_HINT(port.port));
  }

  // ---- 6. compose config --quiet（只读解析）----
  // `--quiet`：只判定可解析性，不把渲染结果写进 stdout。
  const composeOptions: ComposeOptions = {
    composeFile,
    // 项目目录固定为安装目录：相对挂载不随调用时的工作目录变化。
    projectDirectory: dir,
    envFile,
    judge: report.judgeEnabled,
  };
  const configCheck = await composeConfig(opts.runner, {
    ...composeOptions,
    quiet: true,
  });
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
 * 执行一条没有命名封装的裸 compose 子命令（`stop` / `pull` 等）。
 *
 * 必须在调用点用 `Array.isArray` 收窄 `ComposeResult`。
 */
export function runComposeSub(
  runner: CommandRunner,
  options: ComposeOptions,
  command: string[],
): Promise<ComposeResult> {
  return runner.run("docker", composeArgs({ ...options, command }));
}

/**
 * 把 compose 输出转成待写文本（runner 不打印）。
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

// ---------------- 备份口令步骤（install / update 共用） ----------------

/** 口令新生成时的告警文案。 */
export const PASSPHRASE_CARRY_HINT =
  "请将该口令文件安全复制到仓库外的异地位置，否则无法恢复加密快照";

/** {@link ensureCommandPassphrase} 的输入。 */
export interface PassphraseStepOptions {
  /** `.env.prod` 路径（回填目标）。 */
  envFile: string;
  /** 当前 `.env.prod` 键值（`NOJ_BACKUP_PASSPHRASE_FILE` 参与选目标路径）。 */
  env: EnvValues;
  /** 进程环境快照（`NOJ_BACKUP_PASSPHRASE_FILE` 抑制回填且优先选路径）。 */
  processEnv: Record<string, string | undefined>;
  /** `--passphrase-file` 旗标（优先级最高，但**不**抑制回填）。 */
  passphraseFile?: string;
  /** 口令新生成时的告警汇聚点。 */
  warn?: (message: string) => void;
}

/** {@link ensureCommandPassphrase} 的结果。 */
export interface PassphraseStepResult {
  /** 口令文件路径（无论新建还是复用）。 */
  path: string;
  /** 本次是否新生成口令文件。 */
  created: boolean;
  /** 回填后**重新读取**的 env（未回填时为传入的 `env` 原值）。 */
  env: EnvValues;
  /** 面向用户的失败文案；成功为 null。 */
  error: string | null;
}

/**
 * 备份口令的命令级装配，install（第 4 步）与 update（升级序列第 2 步）共用：
 *
 * 1. 目标路径 = `backupPassphrasePath({ flag, explicit: 进程环境, configured: 配置文件 })`
 *    ——四级优先；
 * 2. `configuredFromEnv` **只**看进程环境是否设置了 `NOJ_BACKUP_PASSPHRASE_FILE`；
 *    `--passphrase-file` 旗标不抑制回填（见 `config.ts` 的 JSDoc）；
 * 3. 需要回填时经 `writeEnvFileAtomic` 就地改写（保留注释与顺序）并**重新读取**，
 *    让调用方拿到回填后的真实值；
 * 4. 新生成时转出告警——口令丢失等于备份不可恢复，静默不是选项。
 *
 * 失败以 `error` 返回而非抛错：调用方（install 抛错 / update 转退出码 1）各自决定。
 */
export async function ensureCommandPassphrase(
  opts: PassphraseStepOptions,
): Promise<PassphraseStepResult> {
  const explicit = opts.processEnv["NOJ_BACKUP_PASSPHRASE_FILE"];
  const target = backupPassphrasePath({
    flag: opts.passphraseFile,
    explicit,
    configured: opts.env["NOJ_BACKUP_PASSPHRASE_FILE"],
  });
  const ensured = await ensureBackupPassphrase(opts.env, {
    targetFile: target,
    configuredFromEnv: (explicit ?? "") !== "",
  });
  if (ensured.error !== null) {
    return {
      path: ensured.path,
      created: false,
      env: opts.env,
      error: ensured.error,
    };
  }
  if (ensured.created) opts.warn?.(PASSPHRASE_CARRY_HINT);

  let env = opts.env;
  if (ensured.envUpdate !== null) {
    await writeEnvFileAtomic(opts.envFile, toEntries(ensured.envUpdate));
    env = await readEnvValues(opts.envFile);
  }
  return { path: ensured.path, created: ensured.created, env, error: null };
}

// ---------------- logs 着色契约 ----------------
//
// logs 有一套**明确**的着色优先级：早先无条件透传，导致 `noj-cli logs core > out.txt` 把 docker compose 的 ANSI 转义码写进重定向
// 文件。本节把该契约收敛为三个纯函数，**不新增第二套** `NO_COLOR`/`LOG_COLOR`
// 解析：取值合并在上层，最终开/关判定仍交回 `util/color.ts:resolveColor`。

/**
 * 合并着色来源：**进程环境优先（非空即胜出），否则回退 `.env.prod`**。
 *
 * 注意判定用的是**未 trim** 的原始值：进程环境里的纯空白值会「占位」而不回退到
 * `.env.prod`。
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
 * logs 的着色决策。
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
 * **刻意不含 `--color`**：logs 的着色契约只有
 * `LOG_COLOR` / `NO_COLOR` / stdout TTY 三个输入；`--color` 只作用于本进程的
 * 人类输出主题（`lifecycleContext`），不参与 compose 色旗的推导。把 `--color`
 * 混进来会让 `--color=never` 压过 `LOG_COLOR=always`。
 */
export interface LogsColorOptions {
  /** 已合并的 `LOG_COLOR` 原始值（未 trim）。 */
  logColor?: string;
  /** 已合并的 `NO_COLOR` 原始值（未 trim）。 */
  noColor?: string;
  /** `resolveColor` 探测的流；缺省 stdout。 */
  stream?: "stdout" | "stderr";
}

/**
 * 判定 logs 的着色决策，分支顺序：
 *
 * 1. `NO_COLOR` 非空或 `LOG_COLOR=never` → `--no-color`；
 * 2. `LOG_COLOR=always` → 全局 `--ansi always`；
 * 3. stdout 非 TTY → `--no-color`。
 *
 * **分支 1 在前**：`NO_COLOR` 非空时即使 `LOG_COLOR=always` 也关色。`LOG_COLOR`
 * 大小写不敏感、首尾空白被归一（与 TS 侧既有的 trim+toLowerCase 一致）。
 *
 * 前两个分支是显式判定，命中即短路；**其余情况**（含 `LOG_COLOR` 未设置、
 * 取值无法识别）一律回退到 `resolveColor`——着色开/关的**唯一**判定源。因此
 * `--color=never` / `NO_COLOR` / 非 TTY 这三条既有规则不会在此漂移。
 */
export function decideLogsColor(
  options: LogsColorOptions = {},
): LogsColorDecision {
  const logColor = (options.logColor ?? "").trim().toLowerCase();

  // 把「合并后的有效 LOG_COLOR / NO_COLOR」翻译成 resolveColor 接受的 mode 入参：
  // - NO_COLOR 非空 **或** LOG_COLOR=never → `never`（分支 1；NO_COLOR 在前，
  //   即使 LOG_COLOR=always 也关）；
  // - LOG_COLOR=always → `always`（分支 2，强制）；
  // - 其余 → `auto`（分支 3 的 TTY 探测；resolveColor 内部再读进程 LOG_COLOR
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
 * 把着色决策落到 `composeLogs` 产出的参数数组上。
 *
 * **强制着色必须用子命令之前的全局 `--ansi always`**：`docker compose logs`
 * 只有 `--no-color`，**没有**单命令的「强制开」开关——省略 `--no-color` 只是把
 * 决定权交回 compose 自己的 TTY 探测，并不等于「开」。`--ansi` 是全局旗标，必须排在子命令之前，故在
 * `logs` 之前插入，而不是追加到数组末尾。
 *
 * `no-color` 则插在 `--tail=200` / `--follow` 之后、位置参数（服务名）之前。
 *
 * 输入是 `composeLogs` 的 dryRun 结果，tail / follow / services 的相对顺序
 * 由它保证，这里只做两处插入，不重排任何既有元素。
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
 * 健康等待 + 反向代理刷新，两段 compose：
 *
 * 1. `up -d --wait --wait-timeout 180 --remove-orphans`；
 * 2. `up -d --force-recreate --no-deps nginx`。
 *
 * install 与 start 共用本函数。
 *
 * 失败**不抛错**：返回 `{ ok:false, error }`，由命令入口决定退出码（install 抛错、
 * 生命周期命令返回 1）。返回值同时带第一段
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
 * 为失败文案）。调用方据此填写 `InstallResult.composeUpCode`，
 * 而不是硬编码 `0`。
 */
export interface WaitForStackResult {
  ok: boolean;
  error: string | null;
  /** 第一段 `up` 的 compose 退出码（成功即 0）。 */
  code: number;
}

/** `--wait-timeout` 的秒数。 */
export const WAIT_TIMEOUT_SECONDS = "180";

/** 健康等待失败文案。 */
export const WAIT_FAILURE_HINT =
  "服务启动或健康检查失败，请执行 status 和 logs 排查";

/** 反向代理刷新失败文案。 */
export const NGINX_REFRESH_FAILURE_HINT =
  "反向代理刷新失败，请执行 status 和 logs 排查";

/**
 * 端口占用告警文案。
 *
 * 缺省探测关闭时不会用到；`checkPortValue` 自身也产出同形文案，此处供
 * {@link prepareAndCheck} 在**注入** `probePort` 时统一措辞。
 */
export function PORT_CONFLICT_HINT(port: number): string {
  return `NGINX_PORT=${port} 已被其他进程监听；启动时可能发生端口冲突`;
}

// ---------------- uninstall 前置与安装目录守卫 ----------------
//
// 1. uninstall 前置：docker CLI / daemon / compose v2 / `.env.prod` /
//    compose 文件五条，**任一缺失即拒绝**；
// 2. `--all` 直接 `rm -rf` 安装目录前的守卫
//    （目录形态 → 安装完整性 → **Git 工作区拒绝** → 危险路径拒绝）。
//
// 为什么放在共享步骤模块：两者与 `prepareAndCheck` 同类——都是「命令变更任何东西
// 之前必须通过」的判定，且被 `uninstall` 与（后续）`update` 复用。

/** docker CLI 缺失文案。 */
export function dockerMissingHint(dockerBin: string): string {
  return `找不到 Docker CLI：${dockerBin}`;
}

/** daemon 不可用文案。 */
export const UNINSTALL_DAEMON_HINT = "Docker daemon 未运行或当前用户无权限";

/** Compose v2 不可用文案。 */
export const UNINSTALL_COMPOSE_HINT = "Docker Compose v2 不可用";

/** `.env.prod` 缺失文案。 */
export function uninstallEnvMissingHint(envFile: string): string {
  return `找不到生产配置：${envFile}；无法安全定位生产 Compose 栈`;
}

/** compose 文件缺失文案。 */
export function uninstallComposeMissingHint(composeFile: string): string {
  return `找不到生产 Compose 文件：${composeFile}`;
}

/** 工作区拒绝文案。 */
export const UNINSTALL_WORKSPACE_HINT =
  "检测到 Git 工作区，拒绝删除源码目录；请在生产安装目录执行 uninstall --all";

/** 危险路径拒绝文案。 */
export function uninstallUnsafePathHint(dir: string): string {
  return `拒绝删除危险安装路径：${dir}`;
}

/** 安装目录形态不符文案。 */
export function uninstallNotADirHint(dir: string): string {
  return `当前安装目录不存在或不是普通目录：${dir}`;
}

/** 安装目录不完整文案。 */
export function uninstallIncompleteDirHint(dir: string): string {
  return `当前目录不是完整的 NOJ 安装目录，拒绝完全删除：${dir}`;
}

/**
 * 执行"存在性探测"命令并归一到退出码：**命令无法启动时返回 `null`**。
 *
 * 真实 {@link CommandRunner}（`runtime/command.ts`）用 `Deno.Command`：二进制
 * 不在 PATH 时 `output()` **抛 `Deno.errors.NotFound`**，而不是返回非 0。
 * 存在性探测需要把"找不到"归一成一个失败信号；若直接取 `(await runner.run(...)).code`，
 * 真实主机上缺 docker/cosign 会把可操作文案换成裸异常。
 *
 * @returns 退出码；命令无法启动（不存在/无权限）时为 `null`。
 */
export async function probeCommandCode(
  runner: CommandRunner,
  cmd: string,
  args: string[],
): Promise<number | null> {
  try {
    return (await runner.run(cmd, args)).code;
  } catch {
    return null;
  }
}

/** {@link checkUninstallDependencies} 的成功分支：卸载所需的三个已定位路径。 */
export interface UninstallDependencies {
  ok: true;
  /** 归一化安装目录（无尾斜杠）。 */
  dir: string;
  envFile: string;
  composeFile: string;
}

/** {@link checkUninstallDependencies} 的结果。 */
export type UninstallDependenciesResult =
  | UninstallDependencies
  | PrepareFailure;

/**
 * `check_uninstall_dependencies`：卸载前的五条前置。
 *
 * 逐条顺序：`docker --version` → `docker info` → `docker compose version` →
 * `.env.prod` 存在 → compose 文件存在；**任一失败立即返回错误**，由调用方转成
 * 退出码 1 且**零 compose down**。三条 docker 探测都经 {@link probeCommandCode}：
 * spawn 失败（二进制缺失）与退出码非 0 同样落在"失败"分支。
 *
 * **只判定存在性，不解析 `.env.prod`**：卸载恒带 judge profile（见
 * `uninstall()` 的注释），不需要 `judge` 旗标，成功分支只回填三个路径字段。
 */
export async function checkUninstallDependencies(opts: {
  dir: string;
  runner: CommandRunner;
  /** docker 可执行名（`NOJ_DEPLOY_DOCKER_BIN` 的等价）。 */
  dockerBin?: string;
}): Promise<UninstallDependenciesResult> {
  const dockerBin = opts.dockerBin ?? "docker";
  const envFile = join(opts.dir, PROD_ENV_FILE);
  const composeFile = join(opts.dir, PROD_COMPOSE_FILE);

  if (
    (await probeCommandCode(opts.runner, dockerBin, ["--version"])) !== 0
  ) {
    return { ok: false, error: dockerMissingHint(dockerBin) };
  }
  if ((await probeCommandCode(opts.runner, dockerBin, ["info"])) !== 0) {
    return { ok: false, error: UNINSTALL_DAEMON_HINT };
  }
  if (
    (await probeCommandCode(opts.runner, dockerBin, ["compose", "version"])) !==
      0
  ) {
    return { ok: false, error: UNINSTALL_COMPOSE_HINT };
  }
  if (!(await isFile(envFile))) {
    return { ok: false, error: uninstallEnvMissingHint(envFile) };
  }
  if (!(await isFile(composeFile))) {
    return { ok: false, error: uninstallComposeMissingHint(composeFile) };
  }

  return { ok: true, dir: opts.dir, envFile, composeFile };
}

/**
 * `--all` 的安装目录守卫，四条检查：
 *
 * 1. 是普通目录且不是符号链接；
 * 2. **安装完整性**：`bin/noj-cli` 存在（可执行）**且** {@link PRODUCTION_MARKERS}
 *    两个特征文件存在；各缺失分支共用 {@link uninstallIncompleteDirHint}；
 * 3. 目录含 `.git` 或 `.jj`（像源码工作区）→ 拒绝；
 * 4. 不是 `/`、`.`、`..` 或 `$HOME`。
 *
 * **抛错而非返回结果**：守卫失败必须终止整个命令，返回布尔容易被调用方误当成
 * 可继续的信号。
 */
export async function assertRemovableInstallDir(
  dir: string,
  processEnv: Record<string, string | undefined> = Deno.env.toObject(),
  opts: {
    /** 安装版 CLI 路径；缺省 `<dir>/bin/noj-cli`。 */
    cliBinary?: string;
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
  // 各条 `-f` 用 `&&` 串在一起时失败只有**一句**文案，
  // 无法（也不应）区分是哪一个特征文件缺失。
  if (!(await isFile(cliBinary))) {
    throw new Error(uninstallIncompleteDirHint(dir));
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
 * 删除安装目录：先守卫、再 `rm -rf`；删除失败即抛错。
 */
export async function removeInstallDirectory(
  dir: string,
  processEnv: Record<string, string | undefined> = Deno.env.toObject(),
  opts: {
    cliBinary?: string;
  } = {},
): Promise<void> {
  await assertRemovableInstallDir(dir, processEnv, opts);
  try {
    await Deno.remove(dir, { recursive: true });
  } catch {
    throw new Error(`无法删除 NOJ 安装目录：${dir}`);
  }
}
