/**
 * 「已解析目标发布配置」：升级序列的唯一事实源（P1a 架构整治，2026-10-20）。
 *
 * 背景：`lifecycle.ts` 的 upgrade 序列曾把目标发布集解析成**两份**：
 * - compose pull/up 用暂存 `--env-file`（含目标 `NOJ_VERSION`）；
 * - `verifyImageSignatures` 却读 `prepareAndCheck` 返回的旧 `.env.prod` 键值，
 * 且验签发生在 `waitForStack`（启动目标栈）**之后**。
 *
 * 后者造成两处结构性缺陷：启动的镜像与校验的镜像可能不是同一批；验签失败时
 * 目标栈已经被启动。本模块把「本次要部署的目标发布集」收敛为**一次解析**的
 * {@link ResolvedTargetConfig}——生效 env 文件（升级时优先暂存文件）→ 目标版本、
 * 目标键值、compose 选项。备份、pull、验签、`waitForStack` 与部署元数据都只消费
 * 它，从结构上消除"校验对象 ≠ 启动对象"。
 *
 * 边界：
 * 1. **不重复实现校验**：`.env.prod` 的六步前置仍由 `prepareAndCheck`
 *    （`./steps.ts`）完成，本模块只做「取生效文件 + 解析 + 装配 compose 选项」；
 * 2. **不执行任何命令**：纯文件读取与装配，测试可直接单测、升级序列的零副作用
 *    约定不受影响；
 * 3. **不持有模块级可变状态**（AGENTS.md §8.2 多副本约束）：只有类型与纯函数。
 */

import type { ComposeOptions } from "../compose.ts";
import type { EnvValues } from "../config.ts";
import { judgeEnabledFrom, readEnvValues } from "./steps.ts";

/** 生效环境文件缺失 `NOJ_VERSION` 时的报错文案。 */
export function targetVersionMissingHint(envFile: string): string {
  return `目标发布配置缺少 NOJ_VERSION：${envFile}`;
}

/**
 * 解析目标发布配置所需的**已校验**环境事实（由 `prepareAndCheck` /
 * `prepareLifecycle` 提供）：compose 文件路径、默认生效 env 文件及其键值。
 */
export interface TargetEnvSource {
  /** compose 文件路径（前置校验已确认存在）。 */
  composeFile: string;
  /** 默认生效 env 文件（通常为 `.env.prod`）。 */
  envFile: string;
  /** 该文件的已解析键值。 */
  env: EnvValues;
}

/**
 * 本次部署的「已解析目标发布配置」。
 *
 * 字段全部指向**同一个生效 env 文件**：验签消费 {@link ResolvedTargetConfig.env}，
 * compose 消费 {@link ResolvedTargetConfig.composeOptions}，二者不可能再分叉。
 */
export interface ResolvedTargetConfig {
  /** 生效环境文件：有暂存配置时为其路径，否则为 `.env.prod`。 */
  envFile: string;
  /** 从 {@link ResolvedTargetConfig.envFile} 一次性解析的键值。 */
  env: EnvValues;
  /** 目标版本（`NOJ_VERSION` 原文，保留 `v` 前缀）。 */
  version: string;
  /** judge 是否启用（由目标 env 推导，决定 compose 的 `--profile judge`）。 */
  judge: boolean;
  /** compose 选项：`--env-file` 恒指向 {@link ResolvedTargetConfig.envFile}。 */
  composeOptions: ComposeOptions;
}

/** {@link resolveTargetConfig} 的结果。 */
export type ResolveTargetConfigResult =
  | { ok: true; target: ResolvedTargetConfig }
  | { ok: false; error: string };

/**
 * 解析目标发布配置（升级序列的第 0 步，必须先于备份 / pull / 验签 / up）。
 *
 * 生效文件的选择与 bash `production.sh:419` 一致：**有暂存配置就用暂存配置**
 * （升级本身跑在目标版本上），否则用 `.env.prod`（固定版本升级：版本号没变）。
 * 无暂存文件时直接复用 `prepareAndCheck` 已解析的 `prepared.env`，避免同一份
 * 配置被读两遍；有暂存文件时必须重新解析它，因为 `prepared.env` 来自旧配置。
 *
 * 失败以 `{ ok: false, error }` 返回而非抛错：调用方（update）据此产出退出码 1，
 * 且此函数不产生任何变更命令。
 */
export async function resolveTargetConfig(
  prepared: TargetEnvSource,
  stagedEnvFile?: string,
): Promise<ResolveTargetConfigResult> {
  const envFile = stagedEnvFile ?? prepared.envFile;
  let env: EnvValues;
  if (stagedEnvFile === undefined) {
    env = prepared.env;
  } else {
    try {
      env = await readEnvValues(stagedEnvFile);
    } catch (err) {
      return {
        ok: false,
        error: `无法读取目标发布配置：${stagedEnvFile}（${
          (err as Error).message
        }）`,
      };
    }
  }

  const version = env["NOJ_VERSION"] ?? "";
  if (version === "") {
    return { ok: false, error: targetVersionMissingHint(envFile) };
  }

  const judge = judgeEnabledFrom(env);
  return {
    ok: true,
    target: {
      envFile,
      env,
      version,
      judge,
      composeOptions: {
        composeFile: prepared.composeFile,
        envFile,
        judge,
      },
    },
  };
}
