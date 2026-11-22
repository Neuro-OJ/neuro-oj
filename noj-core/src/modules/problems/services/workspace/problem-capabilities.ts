import { NotFoundError } from "../../../../shared/base/errors.ts";
import {
  assertWorkspacePermission,
  loadWorkspace,
} from "../../../access/contracts/cross-module/workspace_services_access.ts";
import { listLlmGatewayModelCapabilities } from "../../../platform/contracts/cross-module/gateway_services_llm.ts";
import { resolveDomainProblem } from "./problem-binding-access.ts";
import { resolveProblemUiHtml } from "../support-package.ts";
import type { ProblemContentV1 } from "../../types/problem-content.ts";

/** 作者仅获取使用域能力名称，不读取 Provider、密钥或实际模型映射。 */
export async function readDomainModelCapabilities(
  slug: string,
  actorId: string,
) {
  const workspace = await loadWorkspace(slug, actorId);
  assertWorkspacePermission(workspace.context, "problem:create");
  return await listLlmGatewayModelCapabilities(workspace.domain.id);
}

/** 界面文件和题面使用同一授权绑定与作答版本，源共享撤销即时生效。 */
export async function readDomainProblemUi(
  slug: string,
  reference: string,
  actorId: string,
  requestedVersionId?: string,
) {
  const resource = await resolveDomainProblem(slug, reference, actorId, {
    versionId: requestedVersionId,
  });
  const content = resource.version.content as ProblemContentV1;
  if (content.kind !== "ai" || content.submission_mode !== "ui") {
    throw new NotFoundError("题目不存在");
  }
  const html = await resolveProblemUiHtml(resource.problem.id, {
    versionId: resource.version.id,
  });
  if (html === null) throw new NotFoundError("该题目没有界面文件");
  return { html };
}
