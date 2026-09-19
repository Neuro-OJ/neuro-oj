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
import { checkRequiredValues } from "../config.ts";
import type { EnvValues, RequiredValuesReport } from "../config.ts";
import { composeArgs, PROD_COMPOSE_FILE, PROD_ENV_FILE } from "../compose.ts";
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

/**
 * 迁移 `prepare_and_check`（:994-997）的**配置侧**。
 *
 * bash 的 `prepare_and_check = check_dependencies + check_configuration`。
 * `check_dependencies`（docker 存在性 / daemon / buildx）属环境探测面，
 * 不在本任务接线（T12 报告 §6.4 已登记）；本函数迁移 `check_configuration`
 * （:893-913）中**不依赖真实机器**的部分，顺序逐条对齐：
 *
 * 1. `[[ -f "$ENV_FILE" ]] || fail "找不到生产配置：${ENV_FILE}，请先执行 install"`
 * 2. `check_file_permissions`：`.env.prod` 权限必须是 600/400（T11）
 * 3. `[[ -f "$COMPOSE_FILE" ]] || fail "找不到生产 Compose 文件"`
 * 4. `check_required_values`（T11）：先 judge 枚举、再缺失/占位/取值约束
 *
 * 任一失败都**在调用任何 docker 之前**返回错误（零副作用），由命令入口转成退出码 1。
 */
export async function prepareAndCheck(dir: string): Promise<PrepareResult> {
  const envFile = join(dir, PROD_ENV_FILE);
  const composeFile = join(dir, PROD_COMPOSE_FILE);

  if (!(await isFile(envFile))) {
    return { ok: false, error: `找不到生产配置：${envFile}，请先执行 install` };
  }

  const { mode } = await statMode(envFile);
  const verdict = checkEnvFileMode(mode, envFile);
  if (verdict.kind !== "ok") return { ok: false, error: verdict.message };

  if (!(await isFile(composeFile))) {
    return {
      ok: false,
      error: `找不到生产 Compose 文件：${composeFile}，请先执行 install`,
    };
  }

  const env = await readEnvValues(envFile);
  let report: RequiredValuesReport;
  try {
    report = assertConfiguration(env);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
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
 * 生命周期命令返回 1），错误文本与 bash `fail` 逐字一致。
 */
export async function waitForStack(
  runner: CommandRunner,
  options: ComposeOptions,
  write: StepSink,
): Promise<{ ok: boolean; error: string | null }> {
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
    return { ok: false, error: WAIT_FAILURE_HINT };
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
    return { ok: false, error: NGINX_REFRESH_FAILURE_HINT };
  }

  write("✓ 生产服务已通过 Compose 健康检查\n");
  return { ok: true, error: null };
}

/** `--wait-timeout` 的秒数（deploy.sh:987）。 */
export const WAIT_TIMEOUT_SECONDS = "180";

/** 健康等待失败文案（deploy.sh:988 的 `fail` 逐字）。 */
export const WAIT_FAILURE_HINT =
  "服务启动或健康检查失败，请执行 status 和 logs 排查";

/** 反向代理刷新失败文案（deploy.sh:990 的 `fail` 逐字）。 */
export const NGINX_REFRESH_FAILURE_HINT =
  "反向代理刷新失败，请执行 status 和 logs 排查";
