/**
 * 域题目批量摘要读模型。
 *
 * 该入口只返回页面需要的公开元数据，并把题目授权作为集合条件一次性
 * 应用；不可见题目统一映射为 unavailable，不能通过响应差异探测题目是否
 * 存在。题目数量只影响 IN/OR 参数，不触发逐题详情查询。
 */
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  domainProblemBindings,
  domains,
  problems,
  problemShareSettings,
  problemVersions,
} from "../../../../shared/db/schema.ts";
import { BadRequestError } from "../../../../shared/base/errors.ts";
import { loadWorkspace } from "../../../access/contracts/cross-module/workspace_services_access.ts";
import { getProblemSubmissionSummaries } from "../../../access/submission-policy.ts";
import { unendedPublicContestForProblem } from "../../../access/contest-policy.ts";
import { parseDomainProblemReference } from "./problem-reference.ts";

const MAX_PROBLEM_SUMMARIES = 50;
const PROBLEM_KINDS = ["oi", "ai", "objective"] as const;

export type ProblemSummaryKind = (typeof PROBLEM_KINDS)[number];

export interface DomainProblemSummaryItem {
  reference: string;
  availability: "available" | "unavailable";
  title: string | null;
  kind: ProblemSummaryKind | null;
  answer_version_id: string | null;
  answer_version: number | null;
  progress: "solved" | "attempted" | "unseen" | null;
}

function progressOf(
  row: { solved: boolean | null; attempted: boolean | null } | undefined,
  authenticated: boolean,
): DomainProblemSummaryItem["progress"] {
  if (!authenticated) return null;
  return row?.solved ? "solved" : row?.attempted ? "attempted" : "unseen";
}

/** 读取当前域内一页题目摘要；调用者负责传入已解析的认证用户 ID。 */
export async function readDomainProblemSummaries(
  slug: string,
  references: string[],
  actorId: string | null,
): Promise<{ items: DomainProblemSummaryItem[] }> {
  const uniqueReferences = [...new Set(references)];
  if (
    uniqueReferences.length < 1 ||
    uniqueReferences.length > MAX_PROBLEM_SUMMARIES ||
    uniqueReferences.some((reference) =>
      typeof reference !== "string" || !reference.trim()
    )
  ) {
    throw new BadRequestError(
      `每次必须提供 1-${MAX_PROBLEM_SUMMARIES} 个有效题号`,
      "INVALID_PROBLEM_SUMMARIES",
    );
  }
  const parsed = uniqueReferences.map((reference) => ({
    reference,
    ...parseDomainProblemReference(reference),
  }));
  const workspace = await loadWorkspace(slug, actorId);
  const db = getDb();
  const source = alias(domains, "problem_summary_source_domain");
  const binding = domainProblemBindings;
  const canEdit = workspace.platformAdmin ||
    workspace.context.domainPermissions.has("problem:write_any");
  const scope = {
    domainId: workspace.domain.id,
    member: !!workspace.membership || workspace.platformAdmin,
  };
  const referenceWhere = or(
    ...parsed.map((item) =>
      and(
        eq(problems.number, item.number),
        item.sourceSlug
          ? eq(source.slug, item.sourceSlug)
          : eq(problems.domain_id, workspace.domain.id),
      )
    ),
  );
  const authorized = and(
    eq(binding.domain_id, workspace.domain.id),
    isNull(binding.disabled_at),
    workspace.membership || workspace.platformAdmin
      ? undefined
      : eq(binding.visibility, "public"),
    isNotNull(problems.latest_version_id),
    or(
      and(
        eq(binding.kind, "owned"),
        eq(problems.domain_id, workspace.domain.id),
        canEdit ? undefined : sql`NOT ${
          unendedPublicContestForProblem(
            problems.id,
            sql`${workspace.domain.id}`,
          )
        }`,
      ),
      and(
        eq(binding.kind, "shared"),
        eq(problems.visibility, "public"),
        sql`${source.status} <> 'suspended'`,
        sql`${source.configuration}->>'access' = 'public'`,
        eq(problemShareSettings.enabled, true),
        sql`(${problemShareSettings.scope} = 'all' OR EXISTS (
          SELECT 1 FROM problem_share_targets grant_target
          WHERE grant_target.problem_id = ${problems.id}
            AND grant_target.domain_id = ${workspace.domain.id}
        ))`,
        sql`EXISTS (
          SELECT 1 FROM domain_problem_bindings source_binding
          WHERE source_binding.problem_id = ${problems.id}
            AND source_binding.domain_id = ${source.id}
            AND source_binding.kind = 'owned'
            AND source_binding.visibility = 'public'
            AND source_binding.disabled_at IS NULL
        )`,
        sql`NOT ${unendedPublicContestForProblem(problems.id, source.id)}`,
      ),
    ),
  );
  const rows = await db.select({
    problem_id: problems.id,
    source_slug: source.slug,
    number: problems.number,
    title: sql<string>`${problemVersions.content}->>'title'`,
    kind: sql<string>`${problemVersions.content}->>'kind'`,
    answer_version_id: problemVersions.id,
    answer_version: problemVersions.version,
  })
    .from(binding)
    .innerJoin(problems, eq(problems.id, binding.problem_id))
    .innerJoin(source, eq(source.id, problems.domain_id))
    .innerJoin(
      problemVersions,
      and(
        eq(problemVersions.problem_id, problems.id),
        eq(
          problemVersions.id,
          sql`CASE WHEN ${binding.effective_version_mode} = 'exact'
            THEN ${binding.required_version_id}
            ELSE ${problems.latest_version_id} END`,
        ),
      ),
    )
    .leftJoin(
      problemShareSettings,
      eq(problemShareSettings.problem_id, problems.id),
    )
    .where(and(authorized, referenceWhere));
  const problemIds = rows.map((row) => row.problem_id);
  const statistics = actorId
    ? await getProblemSubmissionSummaries(scope, problemIds, actorId)
    : [];
  const statisticsByProblem = new Map(
    statistics.map((row) => [row.problem_id, row]),
  );
  const rowsByReference = new Map(
    rows.map((row) => [`${row.source_slug}:${row.number}`, row]),
  );
  return {
    items: parsed.map(({ reference, sourceSlug, number }) => {
      const row = rowsByReference.get(
        `${sourceSlug ?? workspace.domain.slug}:${number}`,
      );
      if (!row || !PROBLEM_KINDS.includes(row.kind as ProblemSummaryKind)) {
        return {
          reference,
          availability: "unavailable",
          title: null,
          kind: null,
          answer_version_id: null,
          answer_version: null,
          progress: null,
        };
      }
      return {
        reference,
        availability: "available",
        title: row.title,
        kind: row.kind as ProblemSummaryKind,
        answer_version_id: row.answer_version_id,
        answer_version: row.answer_version,
        progress: progressOf(
          statisticsByProblem.get(row.problem_id),
          !!actorId,
        ),
      };
    }),
  };
}
