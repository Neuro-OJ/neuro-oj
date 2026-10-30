import { sql } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import { unwrapRows } from "../../../../shared/base/sql-rows.ts";
import type { SearchPermissionContext } from "./permission-filter.ts";
import { unendedPublicContestForProblem } from "../../../access/contest-policy.ts";
import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import {
  communityVisibilityWhere,
  currentSearchResourceWhere,
  notGatedContestContentWhere,
  permissionWhere,
} from "./permission-filter.ts";

// 保护期只允许标题匹配；正文不参与命中、排名或摘要，时间边界实时查询。
function protectedProblem(ctx: SearchPermissionContext) {
  return sql`entity_type='problem' AND ${
    unendedPublicContestForProblem(
      sql`search_entries.entity_id`,
      sql`${ctx.domainId ?? DEFAULT_DOMAIN_ID}`,
    )
  }`;
}
function safeBodyFor(ctx: SearchPermissionContext) {
  return sql`CASE WHEN ${
    protectedProblem(ctx)
  } THEN '' WHEN entity_type='contest' THEN
    (SELECT c.description FROM contests c WHERE c.id=search_entries.entity_id) ELSE body END`;
}
function safeVectorFor(ctx: SearchPermissionContext) {
  return sql`CASE WHEN ${protectedProblem(ctx)} OR entity_type='contest' THEN
    to_tsvector('simple', title || ' ' || coalesce(${
    safeBodyFor(ctx)
  },'')) ELSE search_vector END`;
}
function safeMetadata(ctx: SearchPermissionContext) {
  const domainId = ctx.domainId ?? DEFAULT_DOMAIN_ID;
  const sourceId =
    sql`coalesce(current_problem.domain_id,${DEFAULT_DOMAIN_ID})`;
  const sourceSlug = sql`coalesce(source_domain.slug,'main')`;
  const qualifiedRef = sql`${sourceSlug} || ':' || current_problem.number`;
  return sql`CASE
 WHEN entity_type='contest' THEN metadata-'problem_titles'-'problem_display_ids'
 WHEN entity_type='problem' THEN metadata || jsonb_build_object('contest_protected', ${
    protectedProblem(ctx)
  }, 'reference',(
  SELECT jsonb_build_object(
   'problem_id',current_problem.id,'source_domain_id',${sourceId},'source_domain_slug',${sourceSlug},
   'number',current_problem.number,'qualified_ref',${qualifiedRef},
   'display_ref',CASE WHEN ${sourceId}=${domainId} THEN current_problem.number::text ELSE ${qualifiedRef} END,
   'is_shared',${sourceId}<>${domainId})
  FROM problems current_problem LEFT JOIN domains source_domain ON source_domain.id=current_problem.domain_id
  WHERE current_problem.id=search_entries.entity_id))
 ELSE metadata END`;
}

function escapeLikePattern(s: string): string {
  return s.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll(
    "_",
    "\\_",
  );
}

export interface SearchItem {
  entity_type: string;
  entity_id: string;
  title: string;
  highlight: string;
  rank: number;
  metadata: Record<string, unknown>;
}

export interface GroupedResult {
  groups: Record<string, { items: SearchItem[]; has_more: boolean }>;
  took_ms: number;
}

export interface FlatResult {
  items: SearchItem[];
  has_more: boolean;
  page: number;
  per_page: number;
  took_ms: number;
}

export async function searchGrouped(params: {
  q: string;
  types: string[];
  perType: number;
  ctx: SearchPermissionContext;
}): Promise<GroupedResult> {
  const db = getDb();
  const { q, types, perType, ctx } = params;
  const safeBody = safeBodyFor(ctx), safeVector = safeVectorFor(ctx);
  const likeQ = `%${escapeLikePattern(q)}%`;
  const start = performance.now();
  const groups: GroupedResult["groups"] = {};

  for (const type of types) {
    const rows = await db.execute<{
      id: string;
      entity_type: string;
      entity_id: string;
      title: string;
      rank: number | null;
      highlight: string;
      metadata: Record<string, unknown>;
    }>(sql`
      SELECT id, entity_type, entity_id, title,
        ts_rank(${safeVector}, websearch_to_tsquery('simple', ${q})) AS rank,
        ts_headline('simple', title, websearch_to_tsquery('simple', ${q}),
          'StartSel=[[HIGHLIGHT]], StopSel=[[/HIGHLIGHT]], MaxWords=20, MinWords=5'
        ) AS highlight,
        ${safeMetadata(ctx)} AS metadata
      FROM search_entries
      WHERE entity_type = ${type}
        AND is_active = true
        AND (
          ${safeVector} @@ websearch_to_tsquery('simple', ${q})
          OR title ILIKE ${likeQ} ESCAPE '\\'
          OR ${safeBody} ILIKE ${likeQ} ESCAPE '\\'
        )
        AND ${permissionWhere(ctx)}
        AND ${currentSearchResourceWhere(ctx)}
        AND ${communityVisibilityWhere(ctx)}
        AND ${notGatedContestContentWhere(ctx)}

      ORDER BY rank DESC NULLS LAST, updated_at DESC
      LIMIT ${perType + 1}
    `);
    const resultRows = unwrapRows<typeof rows[number]>(rows as never);
    groups[type] = {
      items: resultRows.slice(0, perType).map((r) => ({
        entity_type: r.entity_type,
        entity_id: r.entity_id,
        title: r.title,
        highlight: r.highlight,
        rank: r.rank ?? 0,
        metadata: r.metadata ?? {},
      })),
      has_more: resultRows.length > perType,
    };
  }

  return { groups, took_ms: Math.round(performance.now() - start) };
}

export async function searchFlat(params: {
  q: string;
  type?: string;
  page: number;
  perPage: number;
  ctx: SearchPermissionContext;
}): Promise<FlatResult> {
  const db = getDb();
  const { q, type, page, perPage, ctx } = params;
  const safeBody = safeBodyFor(ctx), safeVector = safeVectorFor(ctx);
  const likeQ = `%${escapeLikePattern(q)}%`;
  const offset = (page - 1) * perPage;
  const start = performance.now();

  const rows = await db.execute<{
    id: string;
    entity_type: string;
    entity_id: string;
    title: string;
    rank: number | null;
    highlight: string;
    metadata: Record<string, unknown>;
  }>(sql`
    SELECT id, entity_type, entity_id, title,
      ts_rank(${safeVector}, websearch_to_tsquery('simple', ${q})) AS rank,
      ts_headline('simple', title, websearch_to_tsquery('simple', ${q}),
        'StartSel=[[HIGHLIGHT]], StopSel=[[/HIGHLIGHT]], MaxWords=20, MinWords=5'
      ) AS highlight,
      ${safeMetadata(ctx)} AS metadata
    FROM search_entries
    WHERE is_active = true
      AND (
        ${safeVector} @@ websearch_to_tsquery('simple', ${q})
        OR title ILIKE ${likeQ} ESCAPE '\\'
        OR ${safeBody} ILIKE ${likeQ} ESCAPE '\\'
      )
      AND ${permissionWhere(ctx)}
      AND ${currentSearchResourceWhere(ctx)}
      AND ${communityVisibilityWhere(ctx)}
      AND ${notGatedContestContentWhere(ctx)}

      ${type ? sql`AND entity_type = ${type}` : sql``}
    ORDER BY rank DESC NULLS LAST, updated_at DESC
    LIMIT ${perPage + 1} OFFSET ${offset}
  `);
  const resultRows = unwrapRows<typeof rows[number]>(rows as never);

  return {
    items: resultRows.slice(0, perPage).map((r) => ({
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      title: r.title,
      highlight: r.highlight,
      rank: r.rank ?? 0,
      metadata: r.metadata ?? {},
    })),
    has_more: resultRows.length > perPage,
    page,
    per_page: perPage,
    took_ms: Math.round(performance.now() - start),
  };
}
