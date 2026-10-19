import { sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { unwrapRows } from "../../../shared/base/sql-rows.ts";
import type { SearchPermissionContext } from "./permission-filter.ts";
import { DEFAULT_DOMAIN_ID } from "../../workspace/index.ts";
import {
  communityVisibilityWhere,
  contestSecrecyProblemWhere,
  currentSearchResourceWhere,
  notGatedContestContentWhere,
  permissionWhere,
} from "./permission-filter.ts";

// 旧索引的比赛body可能包含未公开赛题；匹配和输出均读取当前比赛摘要。
const safeBody = sql`CASE WHEN entity_type='contest' THEN
  (SELECT c.description FROM contests c WHERE c.id=search_entries.entity_id) ELSE body END`;
const safeVector = sql`CASE WHEN entity_type='contest' THEN
  to_tsvector('simple', title || ' ' || coalesce(${safeBody},'')) ELSE search_vector END`;
function safeMetadata(ctx: SearchPermissionContext) {
  const domainId = ctx.domainId ?? DEFAULT_DOMAIN_ID;
  const sourceId =
    sql`coalesce(current_problem.domain_id,${DEFAULT_DOMAIN_ID})`;
  const sourceSlug = sql`coalesce(source_domain.slug,'main')`;
  const qualifiedRef = sql`${sourceSlug} || ':' || current_problem.number`;
  return sql`CASE
 WHEN entity_type='user' THEN metadata || coalesce((
  SELECT jsonb_build_object('username',u.username,'avatar_url',CASE WHEN u.avatar_url IS NULL THEN NULL ELSE '/api/v1/users/' || u.id || '/avatar?v=' || md5(u.avatar_url) END)
  FROM users u WHERE u.id=search_entries.entity_id AND u.deleted_at IS NULL), '{}'::jsonb)
 WHEN entity_type='contest' THEN metadata-'problem_titles'-'problem_display_ids'
 WHEN entity_type='problem' THEN metadata || jsonb_build_object('reference',(
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
        AND ${contestSecrecyProblemWhere(ctx)}
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
      AND ${contestSecrecyProblemWhere(ctx)}
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
