import { resolveDomainExecution } from "./workspace-execution.ts";
import { createSubmission } from "./submissions/submissions-crud.ts";
import type { SubmissionInput } from "./submissions/submissions-types.ts";

/** 显式使用域代码提交，源题内部身份从引用解析，继续复用唯一提交与评测链。 */
export async function createDomainSubmission(
  slug: string,
  reference: string,
  userId: string,
  input: Omit<SubmissionInput, "problem_id" | "contest_id">,
) {
  const request = { slug, reference };
  const resolved = await resolveDomainExecution(
    request,
    userId,
    input.version_id,
  );
  const result = await createSubmission(
    userId,
    {
      language: input.language,
      code: input.code,
      file_name: input.file_name,
      version_id: input.version_id,
      problem_id: resolved.problem.id,
    },
    undefined,
    false,
    request,
  );
  return {
    ...result,
    domain_id: resolved.domain.id,
    domain_problem_binding_id: resolved.binding.id,
    reference: resolved.reference,
  };
}
