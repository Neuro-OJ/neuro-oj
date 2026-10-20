/** 草稿与发布共用运行配置的权限、资源与 LLM 准入规则。 */
import type { Context } from "hono";
import { BadRequestError } from "../../../../shared/base/errors.ts";
import type {
  ProblemContentV1,
  ProblemDraftContent,
} from "../../types/problem-content.ts";
import type {
  ProblemRuntimeConfig,
  RuntimeConfig,
} from "../../types/runtime-config.ts";
import type { ProblemIdentityRow } from "./draft.ts";
import {
  assertSensitiveFieldPermissions,
  enforceResourceLimits,
} from "../problems/problem-field-guard.ts";
import { assertLlmLimitsWithinDefault } from "../../../../domains/gateway/index.ts";
import { validateJudgeImageWithKind } from "../../../../domains/system/index.ts";

/** 草稿可不完整，但显式修改敏感字段始终受权限和平台上限约束。 */
export async function assertDraftContentSecurity(
  identity: ProblemIdentityRow,
  content: ProblemDraftContent,
  actorId?: string | null,
  context?: Context,
): Promise<void> {
  const runtime = content.runtime_config as ProblemRuntimeConfig | undefined;
  if (runtime) {
    // 结构校验先于权限/上限检查：非法形状（字符串、数组、缺 evaluator/solution）
    // 不能靠"能解析成对象"混入草稿，否则编辑入口与发布入口的校验强度不一致
    // （tracking #16）。草稿允许**字段缺失**（尚在编辑中），但不允许**类型错误**。
    assertDraftRuntimeConfigShape(runtime);
    await assertSensitiveFieldPermissions(
      context,
      actorId ?? undefined,
      undefined,
      runtime,
      identity.runtime_config as ProblemRuntimeConfig | null,
    );
    enforceResourceLimits(runtime);
  }
  if (content.kind === "ai" && content.llm_config) {
    assertLlmLimitsWithinDefault(content.llm_config);
    if (
      !runtime || !("evaluator" in runtime) ||
      !runtime.evaluator.network?.enabled
    ) throw new BadRequestError("启用 LLM 必须开启 evaluator 网络");
  }
}

/**
 * 草稿运行配置的**结构**校验（允许不完整，不允许类型错误）。
 *
 * 与发布路径 `validateProblemRuntimeConfig` / `validateOiRuntimeConfig` 的完整校验
 * 互补：保存草稿时可以缺字段（编辑中），但一旦出现就必须是正确类型——否则非法
 * 配置会先落草稿、再由发布入口报错，形成"保存成功、发布才失败"的割裂。
 */
function assertDraftRuntimeConfigShape(runtime: unknown): void {
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
    throw new BadRequestError("运行配置必须是对象");
  }
  const config = runtime as Record<string, unknown>;
  if (config.evaluator !== undefined) {
    const evaluator = config.evaluator;
    if (
      !evaluator || typeof evaluator !== "object" || Array.isArray(evaluator)
    ) {
      throw new BadRequestError("运行配置 evaluator 必须是对象");
    }
    const image = (evaluator as Record<string, unknown>).image;
    const command = (evaluator as Record<string, unknown>).command;
    if (image !== undefined && typeof image !== "string") {
      throw new BadRequestError("evaluator.image 必须是字符串");
    }
    if (command !== undefined && typeof command !== "string") {
      throw new BadRequestError("evaluator.command 必须是字符串");
    }
    for (
      const field of [
        "time_limit_ms",
        "memory_limit_mb",
      ]
    ) {
      const value = (evaluator as Record<string, unknown>)[field];
      if (value !== undefined && typeof value !== "number") {
        throw new BadRequestError(`evaluator.${field} 必须是数字`);
      }
    }
  }
  if (config.solution !== undefined) {
    const solution = config.solution;
    if (!solution || typeof solution !== "object" || Array.isArray(solution)) {
      throw new BadRequestError("运行配置 solution 必须是对象");
    }
    const image = (solution as Record<string, unknown>).image;
    if (image !== undefined && typeof image !== "string") {
      throw new BadRequestError("solution.image 必须是字符串");
    }
    for (
      const field of [
        "call_timeout_ms",
        "memory_limit_mb",
      ]
    ) {
      const value = (solution as Record<string, unknown>)[field];
      if (value !== undefined && typeof value !== "number") {
        throw new BadRequestError(`solution.${field} 必须是数字`);
      }
    }
  }
}

/** 发布预检还验证当前平台是否允许使用所声明的双容器镜像。 */
export async function assertPublishedRuntimeSafety(
  content: ProblemDraftContent | ProblemContentV1,
): Promise<void> {
  if (content.kind !== "ai" || !content.runtime_config) return;
  const runtime = content.runtime_config as RuntimeConfig;
  await validateJudgeImageWithKind(runtime.evaluator.image, "evaluator");
  // prediction 版本没有 Solution 容器。
  if (runtime.solution) {
    await validateJudgeImageWithKind(runtime.solution.image, "solution");
  }
  enforceResourceLimits(runtime);
}
