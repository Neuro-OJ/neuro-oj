import { AppError, NotFoundError } from "../../../../shared/base/errors.ts";
import {
  assertWorkspacePermission,
  loadWorkspace,
} from "../../../../domains/workspace/index.ts";
import { listLlmModelAliasCapabilities } from "../../../../domains/gateway/index.ts";
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
  return await listLlmModelAliasCapabilities(workspace.domain.id);
}

/** 界面文件和题面使用同一授权绑定与作答版本，源共享撤销即时生效。 */
export async function readDomainProblemUi(
  slug: string,
  reference: string,
  actorId: string,
  requestedVersionId?: string,
) {
  const resource = await resolveDomainProblem(slug, reference, actorId);
  if (requestedVersionId && requestedVersionId !== resource.version.id) {
    throw new AppError(
      "作答版本已变化，请重新确认",
      409,
      "PROBLEM_ANSWER_VERSION_CHANGED",
      {
        expected_version_id: resource.version.id,
        submitted_version_id: requestedVersionId,
      },
    );
  }
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
