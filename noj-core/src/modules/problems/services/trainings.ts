/**
 * 题单（training）读取服务（issue #224）。
 *
 * 0.11 起题单只存在于域内：`/api/v1/domains/:slug/trainings` →
 * [`workspace/training-access.ts`](./workspace/training-access.ts) 与
 * [`workspace/trainings.ts`](./workspace/trainings.ts)。旧的实例级
 * `/api/v1/trainings` 路由及其写函数（创建/更新/删除/题目增删排序）已删除，
 * 本文件只保留用户主页「TA 的题单」所需的按创建者列表查询。
 */

import { and, count, desc, eq } from "drizzle-orm";
import {
  loadWorkspace,
} from "../../access/contracts/cross-module/workspace_services_access.ts";
import {
  DEFAULT_DOMAIN_ID,
  DEFAULT_DOMAIN_SLUG,
} from "../../../shared/workspace/types.ts";
import { getDb } from "../../../shared/db/connection.ts";
import { trainings } from "../../../shared/db/schema.ts";
import type { TrainingVisibility } from "../types/trainings.ts";

/** 题单列表分页参数。 */
export interface ListTrainingsParams {
  page?: number;
  perPage?: number;
}

/** 用户主页展示用的题单摘要。 */
export interface TrainingSummary {
  id: string;
  public_id: string;
  title: string;
  description: string;
  state: "draft" | "published";
  visibility: TrainingVisibility;
  is_pinned: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** 题单列表分页结果。 */
export interface ListTrainingsResult {
  data: TrainingSummary[];
  total: number;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * 规范化分页参数：page 至少为 1，perPage 限制在 [1, MAX_PAGE_SIZE]。
 *
 * @param params 原始分页参数
 * @returns 规范化后的 page、perPage 与 offset
 */
function normalizePage(params: ListTrainingsParams): {
  page: number;
  perPage: number;
  offset: number;
} {
  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, params.perPage ?? DEFAULT_PAGE_SIZE),
  );
  return { page, perPage, offset: (page - 1) * perPage };
}

/**
 * 列出指定用户在 main 创建的题单；非本人或实际域管理员仅可见已发布题单。
 *
 * @param ownerId 题单所属用户 id
 * @param viewerId 查看者 id（可选）
 * @param params 分页参数
 * @returns 该用户的题单分页结果
 */
export async function listUserTrainings(
  ownerId: string,
  viewerId: string | null = null,
  params: ListTrainingsParams = {},
): Promise<ListTrainingsResult> {
  const db = getDb();
  const { perPage, offset } = normalizePage(params);
  const workspace = await loadWorkspace(DEFAULT_DOMAIN_SLUG, viewerId);
  const isOwner = ownerId === viewerId || workspace.platformAdmin ||
    workspace.context.domainPermissions.has("training:write_any");
  const conditions = [
    eq(trainings.domain_id, DEFAULT_DOMAIN_ID),
    eq(trainings.created_by, ownerId),
  ];
  if (!isOwner) conditions.push(eq(trainings.state, "published"));
  const where = and(...conditions);
  const [rows, totalRows] = await Promise.all([
    db.select().from(trainings).where(where)
      .orderBy(desc(trainings.is_pinned), desc(trainings.updated_at))
      .limit(perPage).offset(offset),
    db.select({ total: count() }).from(trainings).where(where),
  ]);
  return {
    data: rows.map((row) => ({
      id: row.id,
      public_id: row.public_id,
      title: row.title,
      description: row.description,
      state: row.state as "draft" | "published",
      visibility: row.visibility as TrainingVisibility,
      is_pinned: row.is_pinned,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
    })),
    total: totalRows[0]?.total ?? 0,
  };
}
