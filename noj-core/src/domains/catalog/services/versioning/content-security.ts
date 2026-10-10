/** 草稿与发布共用运行配置的权限、资源与 LLM 准入规则。 */
import type { Context } from "hono";
import {
  BadRequestError,
  ForbiddenError,
} from "../../../../shared/base/errors.ts";
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
import { assertLlmLimitsWithinDefault } from "../../../gateway/index.ts";
import { validateJudgeImageWithKind } from "../../../system/index.ts";

/** 草稿可不完整，但显式修改敏感字段始终受权限和平台上限约束。 */
export async function assertDraftContentSecurity(
  identity: ProblemIdentityRow,
  content: ProblemDraftContent,
  actorId?: string | null,
  context?: Context,
): Promise<void> {
  const runtime = content.runtime_config as ProblemRuntimeConfig | undefined;
  if (runtime) {
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
    if (identity.type !== "P") {
      throw new ForbiddenError("仅 P 型/官方题可启用 LLM");
    }
    assertLlmLimitsWithinDefault(content.llm_config);
    if (
      !runtime || !("evaluator" in runtime) ||
      !runtime.evaluator.network?.enabled
    ) throw new BadRequestError("启用 LLM 必须开启 evaluator 网络");
  }
}

/** 发布预检还验证当前平台是否允许使用所声明的双容器镜像。 */
export async function assertPublishedRuntimeSafety(
  content: ProblemDraftContent | ProblemContentV1,
): Promise<void> {
  if (content.kind !== "ai" || !content.runtime_config) return;
  const runtime = content.runtime_config as RuntimeConfig;
  await validateJudgeImageWithKind(runtime.evaluator.image, "evaluator");
  await validateJudgeImageWithKind(runtime.solution.image, "solution");
  enforceResourceLimits(runtime);
}
