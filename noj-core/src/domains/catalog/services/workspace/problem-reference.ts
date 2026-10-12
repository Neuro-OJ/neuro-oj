import { BadRequestError } from "../../../../shared/base/errors.ts";
import type { ProblemReference } from "../../../../shared/workspace/types.ts";

/** 显式域入口只接受数字或来源域数字，不将数字解释为内部 ID。 */
export function parseDomainProblemReference(
  value: string,
): { sourceSlug: string | null; number: number } {
  const match = /^(?:([a-z][a-z0-9-]{1,30}[a-z0-9]):)?([1-9][0-9]{0,9})$/.exec(
    value,
  );
  const number = match ? Number(match[2]) : NaN;
  if (!match || !Number.isSafeInteger(number) || number > 2147483647) {
    throw new BadRequestError(
      "题号须为正整数或 domain:number",
      "INVALID_PROBLEM_REFERENCE",
    );
  }
  return { sourceSlug: match[1] ?? null, number };
}

/** 来源身份稳定，跨域引用不会分配目标域数字题号。 */
export function domainProblemReference(
  problem: { id: string; domain_id: string; number: number },
  sourceSlug: string,
  consumingDomainId: string,
): ProblemReference {
  const qualified = `${sourceSlug}:${problem.number}`;
  const shared = problem.domain_id !== consumingDomainId;
  return {
    problem_id: problem.id,
    source_domain_id: problem.domain_id,
    source_domain_slug: sourceSlug,
    number: problem.number,
    qualified_ref: qualified,
    display_ref: shared ? qualified : String(problem.number),
    is_shared: shared,
  };
}
