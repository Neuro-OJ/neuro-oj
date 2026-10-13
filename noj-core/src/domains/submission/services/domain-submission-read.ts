import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { domains, problems, submissions } from "../../../shared/db/schema.ts";
import { NotFoundError } from "../../../shared/base/errors.ts";
import { loadWorkspace, workspaceAudit } from "../../workspace/index.ts";
import {
  domainProblemReference,
  loadBindingAvailability,
} from "../../catalog/index.ts";
import {
  getSubmission,
  listSubmissions,
  resolveSubmissionId,
} from "./submissions/submissions-crud.ts";
import type { ListSubmissionsParams } from "./submissions/submissions-types.ts";
import { applySubmissionProjection } from "./submissions/submission-projection.ts";
import type { ResultVisibility } from "../../../shared/contest-types.ts";
import type { ProblemReference } from "../../../shared/workspace/types.ts";

/** 裁剪后的详情：隐藏结果字段允许缺省。 */
export type DomainSubmissionDetail = Record<string, unknown> & {
  domain_id: string;
  domain_problem_binding_id: string | null;
  reference: ProblemReference;
  resource_available: boolean;
  result_visibility: ResultVisibility;
};

async function submissionMetadata(domainId: string, ids: string[]) {
  if (!ids.length) return [];
  return await getDb().select({
    id: submissions.id,
    binding_id: submissions.domain_problem_binding_id,
    user_id: submissions.user_id,
    problem_id: problems.id,
    number: problems.number,
    source_domain_id: problems.domain_id,
    source_domain_slug: domains.slug,
  })
    .from(submissions).innerJoin(
      problems,
      eq(problems.id, submissions.problem_id),
    )
    .innerJoin(domains, eq(domains.id, problems.domain_id))
    .where(
      and(eq(submissions.domain_id, domainId), inArray(submissions.id, ids)),
    );
}

/** 使用域本人提交目录；资源撤销后不继续泄露源题标题。 */
export async function listDomainSubmissions(
  slug: string,
  actorId: string,
  query: Omit<
    ListSubmissionsParams,
    "domainId" | "platformAdmin" | "userId" | "userSearch"
  >,
) {
  const access = await loadWorkspace(slug, actorId);
  const result = await listSubmissions({
    ...query,
    userId: actorId,
    domainId: access.domain.id,
    platformAdmin: access.platformAdmin,
  });
  const metadata = await submissionMetadata(
    access.domain.id,
    result.data.map((row) => row.id),
  );
  const facts = await loadBindingAvailability(
    getDb(),
    access.domain.id,
    metadata.flatMap((row) => row.binding_id ? [row.binding_id] : []),
  );
  const available = new Map(facts.map((row) => [row.id, row.available]));
  const byId = new Map(metadata.map((row) => [row.id, row]));
  return {
    ...result,
    data: result.data.map((row) => {
      const source = byId.get(row.id)!;
      const resourceAvailable = source.binding_id !== null &&
        available.get(source.binding_id) === true;
      return {
        ...row,
        domain_id: access.domain.id,
        reference: domainProblemReference(
          {
            id: source.problem_id,
            number: source.number,
            domain_id: source.source_domain_id!,
          },
          source.source_domain_slug,
          access.domain.id,
        ),
        resource_available: resourceAvailable,
        problem: {
          id: row.problem_id,
          title: resourceAvailable ? row.problem.title : "资源不可用",
        },
      };
    }),
  };
}

/** 当前使用域授权后的详情读取；共享撤销保留本人代码与成绩，隐藏源评测输出。 */
export async function getDomainSubmission(
  slug: string,
  reference: string,
  actorId: string,
): Promise<DomainSubmissionDetail> {
  const access = await loadWorkspace(slug, actorId);
  const id = await resolveSubmissionId(reference);
  const [metadata] = await submissionMetadata(access.domain.id, [id]);
  if (!metadata) throw new NotFoundError("提交不存在");
  const manager = access.platformAdmin ||
    access.context.domainPermissions.has("submission:read_all");
  if (metadata.user_id !== actorId && !manager) {
    throw new NotFoundError("提交不存在");
  }
  const result = await getSubmission(id, actorId, undefined, undefined, {
    domainId: access.domain.id,
    canReadDetails: manager,
    platformAdmin: access.platformAdmin,
  });
  const [fact] = await loadBindingAvailability(
    getDb(),
    access.domain.id,
    metadata.binding_id ? [metadata.binding_id] : [],
  );
  const resourceAvailable = fact?.available === true;
  const record = structuredClone(result) as unknown as Record<string, unknown>;
  if (!resourceAvailable) {
    for (
      const key of [
        "attempts",
        "version_results",
        "latest_attempt",
        "effective_attempt",
        "progress",
      ]
    ) delete record[key];
    if (record.result && typeof record.result === "object") {
      const raw = record.result as Record<string, unknown>;
      record.result = {
        status: raw.status,
        score: raw.score,
        time_ms: raw.time_ms,
        memory_kb: raw.memory_kb,
      };
    }
  }
  const projected = applySubmissionProjection(record, {
    viewerId: actorId,
    isAdmin: false,
    isOwner: metadata.user_id === actorId,
  });
  if (access.platformAdmin) {
    await workspaceAudit(getDb(), actorId, access.domain.id, "domain.update", {
      operation: "submission.read",
      submission_id: id,
    });
  }
  return {
    ...projected,
    domain_id: access.domain.id,
    domain_problem_binding_id: metadata.binding_id,
    reference: domainProblemReference(
      {
        id: metadata.problem_id,
        number: metadata.number,
        domain_id: metadata.source_domain_id!,
      },
      metadata.source_domain_slug,
      access.domain.id,
    ),
    resource_available: resourceAvailable,
    result_visibility:
      (projected.result_visibility ?? "cases") as ResultVisibility,
  };
}
