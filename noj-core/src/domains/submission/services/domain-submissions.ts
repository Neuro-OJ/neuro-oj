import { resolveDomainExecution } from "./workspace-execution.ts";
import { createSubmission } from "./submissions/submissions-crud.ts";
import { createArtifactSubmission } from "./submissions/artifact-submissions.ts";
import { createSelfTest } from "./self-tests.ts";
import type { SelfTestInput } from "../types/self-tests.ts";
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

/** 使用域流式产物提交，仍使用原 ZIP、大小限制、存储守卫及失败补偿。 */
export async function createDomainArtifactSubmission(
  slug: string,
  reference: string,
  userId: string,
  input: Omit<
    Parameters<typeof createArtifactSubmission>[1],
    "problem_id" | "contest_id"
  >,
) {
  const request = { slug, reference };
  const resolved = await resolveDomainExecution(
    request,
    userId,
    input.version_id,
  );
  const result = await createArtifactSubmission(
    userId,
    {
      file_name: input.file_name,
      file_stream: input.file_stream,
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

/** 使用域自测采用独立运行记录，不计入作业或正式成绩。 */
export async function createDomainSelfTest(
  slug: string,
  reference: string,
  userId: string,
  input: SelfTestInput,
) {
  const request = { slug, reference };
  const resolved = await resolveDomainExecution(
    request,
    userId,
    input.version_id,
  );
  const result = await createSelfTest(
    userId,
    resolved.problem.id,
    input,
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
