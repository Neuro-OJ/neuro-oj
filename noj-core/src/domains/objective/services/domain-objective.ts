import { resolveDomainExecution } from "../../submission/index.ts";
import type { SubmitObjectiveInput } from "../../../modules/problems/types/objective.ts";
import { submitObjectivePaper } from "./objective-submissions.ts";
import type { AssignmentSubmissionOrigin } from "../../../shared/education-types.ts";

/** 使用域客观题练习交卷，版本与学校绑定由服务端解析。 */
export async function submitDomainObjectivePaper(
  slug: string,
  reference: string,
  userId: string,
  input: Omit<SubmitObjectiveInput, "contest_id"> & {
    assignment?: AssignmentSubmissionOrigin;
  },
  contestId?: string,
) {
  const request = { slug, reference, contestId, assignment: input.assignment };
  const resolved = await resolveDomainExecution(
    request,
    userId,
    input.version_id,
  );
  const result = await submitObjectivePaper(
    resolved.problem.id,
    {
      answers: input.answers,
      version_id: input.version_id,
      contest_id: resolved.contestId,
    },
    userId,
    false,
    request,
  );
  return {
    ...result,
    domain_id: resolved.domain.id,
    domain_problem_binding_id: resolved.binding.id,
    reference: resolved.reference,
    assignment_origin: input.assignment ?? null,
  };
}
