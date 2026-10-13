import { and, eq, inArray } from "drizzle-orm";
import type { Executor } from "../../../shared/db/executor.ts";
import {
  domainProblemBindings,
  domains,
  problems,
  problemVersions,
} from "../../../shared/db/schema.ts";
import { BadRequestError, NotFoundError } from "../../../shared/base/errors.ts";
import {
  assertCurrentProblemShare,
  domainProblemReference,
  type ProblemContentV1,
} from "../../catalog/index.ts";
import { contestAllowsProblem } from "./contest-scoring.ts";
import type { ContestType } from "../types/contests.ts";

/** 比赛固定目标域选择的已发布版本，后续读取仍检查源授权，不能恢复撤销的共享内容。 */
export async function resolveDomainContestProblems(
  executor: Executor,
  domainId: string,
  problemIds: string[],
  type: ContestType,
  validateType = true,
) {
  const rows = await executor.select({
    binding: domainProblemBindings,
    problem: problems,
    source: domains,
  })
    .from(domainProblemBindings).innerJoin(
      problems,
      eq(problems.id, domainProblemBindings.problem_id),
    )
    .innerJoin(domains, eq(domains.id, problems.domain_id))
    .where(
      and(
        eq(domainProblemBindings.domain_id, domainId),
        inArray(problems.id, problemIds),
      ),
    )
    .orderBy(problems.id).for("share");
  if (rows.length !== new Set(problemIds).size) {
    throw new NotFoundError("比赛包含不属于当前域题库的题目");
  }
  const versions = new Map<string, string>();
  const references = new Map<
    string,
    ReturnType<typeof domainProblemReference>
  >();
  const bindingIds = new Map<string, string>();
  for (const { binding, problem, source } of rows) {
    if (
      binding.disabled_at || source.status === "suspended" ||
      !problem.latest_version_id
    ) {
      throw new NotFoundError("比赛题目已下架或不可用");
    }
    if (binding.kind === "shared") {
      await assertCurrentProblemShare(problem, source, domainId, executor);
    }
    const versionId = binding.effective_version_mode === "exact"
      ? binding.required_version_id
      : problem.latest_version_id;
    const [version] = versionId
      ? await executor.select().from(problemVersions).where(and(
        eq(problemVersions.id, versionId),
        eq(problemVersions.problem_id, problem.id),
      ))
      : [];
    if (!version) throw new NotFoundError("比赛题目作答版本不可用");
    if (
      validateType &&
      !contestAllowsProblem(type, (version.content as ProblemContentV1).kind)
    ) {
      throw new BadRequestError("此赛制不允许所选题型");
    }
    versions.set(problem.id, version.id);
    references.set(
      problem.id,
      domainProblemReference(
        { ...problem, domain_id: source.id },
        source.slug,
        domainId,
      ),
    );
    bindingIds.set(problem.id, binding.id);
  }
  return { versions, references, bindingIds };
}
