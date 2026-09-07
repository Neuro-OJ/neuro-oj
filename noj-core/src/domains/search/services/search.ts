import { sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import type { SearchPermissionContext } from "./permission-filter.ts";
import {
  communityVisibilityWhere,
  permissionWhere,
} from "./permission-filter.ts";

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
        ts_rank(search_vector, websearch_to_tsquery('simple', ${q})) AS rank,
        ts_headline('simple', title, websearch_to_tsquery('simple', ${q}),
          'StartSel=[[HIGHLIGHT]], StopSel=[[/HIGHLIGHT]], MaxWords=20, MinWords=5'
        ) AS highlight,
        metadata
      FROM search_entries
      WHERE entity_type = ${type}
        AND is_active = true
        AND (
          search_vector @@ websearch_to_tsquery('simple', ${q})
          OR title ILIKE ${likeQ} ESCAPE '\\'
          OR body ILIKE ${likeQ} ESCAPE '\\'
        )
        AND ${permissionWhere(ctx)}
        AND ${communityVisibilityWhere(ctx)}
      ORDER BY rank DESC NULLS LAST, updated_at DESC
      LIMIT ${perType + 1}
    `);
    const resultRows = "rows" in rows
      ? (rows as { rows: typeof rows[number][] }).rows
      : (rows as unknown as typeof rows[number][]);
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
      ts_rank(search_vector, websearch_to_tsquery('simple', ${q})) AS rank,
      ts_headline('simple', title, websearch_to_tsquery('simple', ${q}),
        'StartSel=[[HIGHLIGHT]], StopSel=[[/HIGHLIGHT]], MaxWords=20, MinWords=5'
      ) AS highlight,
      metadata
    FROM search_entries
    WHERE is_active = true
      AND (
        search_vector @@ websearch_to_tsquery('simple', ${q})
        OR title ILIKE ${likeQ} ESCAPE '\\'
        OR body ILIKE ${likeQ} ESCAPE '\\'
      )
      AND ${permissionWhere(ctx)}
      AND ${communityVisibilityWhere(ctx)}
      ${type ? sql`AND entity_type = ${type}` : sql``}
    ORDER BY rank DESC NULLS LAST, updated_at DESC
    LIMIT ${perPage + 1} OFFSET ${offset}
  `);
  const resultRows = "rows" in rows
    ? (rows as { rows: typeof rows[number][] }).rows
    : (rows as unknown as typeof rows[number][]);

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
