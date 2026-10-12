import { resolveDomainExecution } from "../../submission/index.ts";
import type { SubmitObjectiveInput } from "../types/objective.ts";
import { submitObjectivePaper } from "./objective-submissions.ts";

/** 使用域客观题练习交卷，版本与学校绑定由服务端解析。 */
export async function submitDomainObjectivePaper(
  slug: string,
  reference: string,
  userId: string,
  input: Omit<SubmitObjectiveInput, "contest_id">,
) {
  const request = { slug, reference };
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
  };
}
