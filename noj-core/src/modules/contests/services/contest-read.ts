// 竞赛读取：获取单个竞赛详情与分页查询竞赛列表。
import type { Executor } from "../../../shared/db/executor.ts";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { contests } from "../../../shared/db/schema.ts";
import { BadRequestError, NotFoundError } from "../../../shared/base/errors.ts";
import { unwrapRows } from "../../../shared/base/sql-rows.ts";
import { DEFAULT_DOMAIN_ID } from "../../../shared/workspace/types.ts";
import { toContestResponse } from "./contest-input.ts";
import { isParticipant } from "./contest-participants.ts";
import {
  type ContestResponse,
  type ContestType,
  isValidContestType,
} from "../types/contests.ts";

/** 竞赛列表查询参数（分页、按类型筛选、是否包含非公开竞赛）。 */
export interface ListContestsParams {
  page?: number;
  perPage?: number;
  type?: ContestType;
  showAll?: boolean;
  /** 旧 API 固定默认域，显式域列表由专用授权入口提供。 */
  defaultDomainOnly?: boolean;
}

/** 竞赛列表查询结果（分页数据与总数）。 */
export interface ListContestsResult {
  data: ContestResponse[];
  total: number;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * 获取竞赛详情（含题目数、参与者数；若提供用户则含其注册状态）。
 *
 * @param id 竞赛 UUID
 * @param userId 当前用户 ID（可选）
 * @returns 竞赛响应
 * @throws {NotFoundError} 竞赛不存在时
 */
export async function getContest(
  id: string,
  userId?: string,
  executor?: Executor,
): Promise<ContestResponse> {
  const db = executor ?? getDb();
  const rows = await db.execute(sql`
    SELECT c.*,
      (SELECT COUNT(*)::int FROM contest_problems cp WHERE cp.contest_id = c.id) AS problem_count,
      (SELECT COUNT(*)::int FROM contest_participants cpa WHERE cpa.contest_id = c.id) AS participant_count
    FROM contests c
    WHERE c.id = ${id}
    LIMIT 1
  `);
  const [row] = unwrapRows<
    typeof contests.$inferSelect & {
      problem_count: number;
      participant_count: number;
    }
  >(rows as never);
  if (!row) {
    throw new NotFoundError("竞赛不存在");
  }
  const registered = userId === undefined
    ? undefined
    : await isParticipant(id, userId, db);
  return toContestResponse(row, registered);
}

/**
 * 分页查询竞赛列表（默认仅公开竞赛，可按类型筛选）。
 *
 * @param params 查询参数（分页、类型、是否包含非公开）
 * @returns 竞赛列表与总数
 * @throws {BadRequestError} 分页或类型参数不合法时
 */
export async function listContests(
  params: ListContestsParams = {},
): Promise<ListContestsResult> {
  const page = params.page ?? 1;
  const perPage = params.perPage ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(page) || page < 1) {
    throw new BadRequestError("page 必须为正整数");
  }
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > MAX_PAGE_SIZE) {
    throw new BadRequestError(`perPage 必须为 1-${MAX_PAGE_SIZE} 的整数`);
  }
  if (params.type && !isValidContestType(params.type)) {
    throw new BadRequestError("竞赛类型不合法");
  }

  const conditions = [];
  if (params.defaultDomainOnly) {
    conditions.push(
      or(
        eq(contests.domain_id, DEFAULT_DOMAIN_ID),
        isNull(contests.domain_id),
      )!,
    );
  }
  if (params.type) conditions.push(eq(contests.type, params.type));
  const where = conditions.length === 0 ? undefined : and(...conditions);
  const db = getDb();
  const [countRow] = await db.select({ total: sql<number>`COUNT(*)` }).from(
    contests,
  ).where(where);
  const total = Number(countRow?.total ?? 0);
  if (total === 0) return { data: [], total: 0 };

  const rows = await db.execute(sql`
    SELECT c.*,
      (SELECT COUNT(*)::int FROM contest_problems cp WHERE cp.contest_id = c.id) AS problem_count,
      (SELECT COUNT(*)::int FROM contest_participants cpa WHERE cpa.contest_id = c.id) AS participant_count
    FROM contests c
    WHERE TRUE
      ${
    params.defaultDomainOnly
      ? sql`AND (c.domain_id = ${DEFAULT_DOMAIN_ID} OR c.domain_id IS NULL)`
      : sql``
  }
      ${params.type ? sql`AND c.type = ${params.type}` : sql``}
    ORDER BY c.start_time DESC, c.id ASC
    LIMIT ${perPage} OFFSET ${(page - 1) * perPage}
  `);
  const data = unwrapRows<
    typeof contests.$inferSelect & {
      problem_count: number;
      participant_count: number;
    }
  >(rows as never).map((row) => toContestResponse(row));
  return { data, total };
}
