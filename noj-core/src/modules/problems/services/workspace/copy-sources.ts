/**
 * 跨域复制来源目录。
 *
 * 只列出操作者确实可以复制的已发布资源：授权过滤、关键词过滤、计数与排序
 * 全部在 SQL 中完成，分页不会泄漏未授权来源。响应不包含答案、评测配置、
 * 文件地址或密钥，只给复制命令需要的来源身份与版本/修订号。
 */
import {
  and,
  asc,
  count,
  eq,
  ilike,
  isNotNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { BadRequestError } from "../../../../shared/base/errors.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import { domains, problems, trainings } from "../../../../shared/db/schema.ts";
import {
  DOMAIN_MEMBER_ROLES,
  domainRoleCapabilities,
  isPlatformRole,
} from "../../../../shared/access/roles.ts";
import { findPlatformRole } from "../../../access/identity/services/security/permissions.ts";
import {
  assertWorkspacePermission,
  loadWorkspace,
} from "../../../access/contracts/cross-module/workspace_services_access.ts";

/** 复制来源种类。 */
export type CopySourceKind = "problem" | "training";

/** 来源域的最小身份投影。 */
export interface CopySourceDomain {
  id: string;
  slug: string;
  name: string;
}

/** 题目来源项：只包含复制命令需要的已发布版本信息。 */
export interface ProblemCopySourceItem {
  kind: "problem";
  source: CopySourceDomain;
  problem_id: string;
  number: number;
  display_ref: string;
  reference: string;
  title: string;
  /** 题型：客观题套卷 / OI / 双容器评测。 */
  problem_kind: "objective" | "oi" | "dual";
  version_id: string;
}

/** 题单来源项：题单按 revision 复核，题目随题单一并复制。 */
export interface TrainingCopySourceItem {
  kind: "training";
  source: CopySourceDomain;
  training_id: string;
  public_id: string;
  title: string;
  revision: number;
}

export type CopySourceItem = ProblemCopySourceItem | TrainingCopySourceItem;

export interface CopySourcePage {
  items: CopySourceItem[];
  page: number;
  limit: number;
  total: number;
}

export interface CopySourceQuery {
  slug: string;
  actorId: string;
  kind: CopySourceKind;
  page: number;
  limit: number;
  sourceSlug?: string;
  keyword?: string;
}

/** 具备“管理源域资源”能力的成员角色；由静态能力表推导，不另写角色表。 */
function sourceMemberRoles(kind: CopySourceKind) {
  const capability = kind === "problem"
    ? "problem:write_any"
    : "training:write_any";
  return DOMAIN_MEMBER_ROLES.filter((role) =>
    domainRoleCapabilities(role).has(capability)
  );
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/**
 * 分页列出可复制的已发布资源。
 *
 * 授权口径：平台管理员可见全部来源域；其他操作者必须是来源域的活跃成员，
 * 且成员角色具备对应的管理能力（owner 由 domains.owner_id 推导）。
 */
export async function listDomainCopySources(
  query: CopySourceQuery,
): Promise<CopySourcePage> {
  const { slug, actorId, kind, page, limit } = query;
  if (kind !== "problem" && kind !== "training") {
    throw new BadRequestError("kind 必须是 problem 或 training");
  }
  const target = await loadWorkspace(slug, actorId, { write: true });
  assertWorkspacePermission(
    target.context,
    kind === "problem" ? "problem:create" : "training:create",
  );

  const platformRole = await findPlatformRole(actorId);
  const platformAdmin = isPlatformRole(platformRole) &&
    platformRole === "admin";
  const roles = sourceMemberRoles(kind);
  const memberOfSource = sql`EXISTS (
    SELECT 1 FROM domain_memberships source_member
    WHERE source_member.domain_id = ${domains.id}
      AND source_member.user_id = ${actorId}
      AND source_member.status = 'active'
      AND source_member.role IN (${
    sql.join(roles.map((role) => sql`${role}`), sql`, `)
  })
  )`;
  const sourceVisible = platformAdmin
    ? sql`TRUE`
    : or(eq(domains.owner_id, actorId), memberOfSource)!;
  const keyword = query.keyword?.trim();
  const keywordCondition = keyword
    ? ilike(
      kind === "problem" ? problems.title : trainings.title,
      `%${escapeLikePattern(keyword)}%`,
    )
    : undefined;
  const sourceSlug = query.sourceSlug?.trim();
  const db = getDb();
  const offset = (page - 1) * limit;

  if (kind === "problem") {
    const conditions = and(
      ne(domains.id, target.domain.id),
      ne(domains.status, "suspended"),
      isNotNull(problems.latest_version_id),
      sourceVisible,
      sourceSlug ? eq(domains.slug, sourceSlug) : undefined,
      keywordCondition,
    );
    const [totalRow] = await db.select({ count: count() }).from(problems)
      .innerJoin(domains, eq(domains.id, problems.domain_id))
      .where(conditions);
    const rows = await db.select({
      domain_id: domains.id,
      domain_slug: domains.slug,
      domain_name: domains.name,
      problem_id: problems.id,
      number: problems.number,
      title: problems.title,
      judge_type: problems.judge_type,
      is_objective: problems.is_objective,
      version_id: problems.latest_version_id,
    }).from(problems)
      .innerJoin(domains, eq(domains.id, problems.domain_id))
      .where(conditions)
      .orderBy(asc(domains.name), asc(domains.id), asc(problems.number))
      .limit(limit)
      .offset(offset);
    return {
      items: rows.map((row) => ({
        kind: "problem" as const,
        source: {
          id: row.domain_id,
          slug: row.domain_slug,
          name: row.domain_name,
        },
        problem_id: row.problem_id,
        number: row.number,
        display_ref: `${row.domain_slug}:${row.number}`,
        reference: `${row.domain_slug}:${row.number}`,
        title: row.title,
        problem_kind: row.is_objective
          ? "objective" as const
          : row.judge_type === "oi"
          ? "oi" as const
          : "dual" as const,
        version_id: row.version_id!,
      })),
      page,
      limit,
      total: Number(totalRow?.count ?? 0),
    };
  }

  const conditions = and(
    ne(domains.id, target.domain.id),
    ne(domains.status, "suspended"),
    eq(trainings.state, "published"),
    sourceVisible,
    sourceSlug ? eq(domains.slug, sourceSlug) : undefined,
    keywordCondition,
    // 只能复制“全部题目都属于源域且均已发布”的题单。
    sql`NOT EXISTS (
      SELECT 1 FROM training_problems source_item
      JOIN problems source_problem ON source_problem.id = source_item.problem_id
      WHERE source_item.training_id = ${trainings.id}
        AND (source_problem.domain_id <> ${trainings.domain_id}
          OR source_problem.latest_version_id IS NULL)
    )`,
  );
  const [totalRow] = await db.select({ count: count() }).from(trainings)
    .innerJoin(domains, eq(domains.id, trainings.domain_id))
    .where(conditions);
  const rows = await db.select({
    domain_id: domains.id,
    domain_slug: domains.slug,
    domain_name: domains.name,
    training_id: trainings.id,
    public_id: trainings.public_id,
    title: trainings.title,
    revision: trainings.revision,
  }).from(trainings)
    .innerJoin(domains, eq(domains.id, trainings.domain_id))
    .where(conditions)
    .orderBy(
      asc(domains.name),
      asc(domains.id),
      asc(trainings.created_at),
      asc(trainings.id),
    )
    .limit(limit)
    .offset(offset);
  return {
    items: rows.map((row) => ({
      kind: "training" as const,
      source: {
        id: row.domain_id,
        slug: row.domain_slug,
        name: row.domain_name,
      },
      training_id: row.training_id,
      public_id: row.public_id,
      title: row.title,
      revision: row.revision,
    })),
    page,
    limit,
    total: Number(totalRow?.count ?? 0),
  };
}
