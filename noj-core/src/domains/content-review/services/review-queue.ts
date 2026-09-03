import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "../../../db/connection.ts";
import { contentReviewQueue } from "../../../db/schema.ts";
import { NotFoundError, ValidationError } from "../../../lib/errors.ts";
import { nowIso } from "../../../lib/dates.ts";
import { logAudit } from "../../system/index.ts";

/**
 * 统一审查队列记录服务（issue #413）。
 *
 * content_review_queue 表既是机器审核留痕（pass→approved / block→rejected），
 * 也是统一人工审查队列（review/error→pending_review），管理员处置后落 reviewed。
 */

export type ReviewContentType = "post" | "comment" | "message";
export type ReviewChannel = "ugc" | "dm";
export type ReviewQueueStatus =
  | "pending_review"
  | "approved"
  | "rejected"
  | "reviewed"
  | "dismissed";

export interface EnqueueReviewInput {
  content_type: ReviewContentType;
  target_id: string;
  channel: ReviewChannel;
  /** 初始状态：pending_review（转人工）或 approved/rejected（机器留痕） */
  status: ReviewQueueStatus;
  review_provider: string;
  verdict: string;
  label?: string[] | null;
  hit_words?: string[] | null;
  risk_level?: string | null;
  content_snapshot?: string;
  /** 上下文 JSON（作者/会话等，详情端点据此展开） */
  meta?: Record<string, unknown>;
}

/**
 * 写入一条审核队列记录，并写审计 review.queued。
 * 同一 target 已有 pending_review 记录时跳过（防编辑风暴重复入队）。
 * @returns 新建记录；重复时返回 null。
 */
export async function enqueueReview(
  input: EnqueueReviewInput,
): Promise<typeof contentReviewQueue.$inferSelect | null> {
  const db = getDb();
  const now = nowIso();

  // 同一内容未决记录去重：避免编辑/多次发送产生重复人工队列
  if (input.status === "pending_review") {
    const existing = await db.select({ id: contentReviewQueue.id })
      .from(contentReviewQueue)
      .where(
        and(
          eq(contentReviewQueue.target_id, input.target_id),
          eq(contentReviewQueue.status, "pending_review"),
        ),
      )
      .limit(1);
    if (existing[0]) return null;
  }

  const row = {
    id: crypto.randomUUID(),
    content_type: input.content_type,
    target_id: input.target_id,
    channel: input.channel,
    status: input.status,
    review_provider: input.review_provider,
    verdict: input.verdict,
    label: input.label?.length ? JSON.stringify(input.label) : null,
    hit_words: input.hit_words?.length ? JSON.stringify(input.hit_words) : null,
    risk_level: input.risk_level ?? null,
    content_snapshot: input.content_snapshot ?? "",
    meta: JSON.stringify(input.meta ?? {}),
    reviewed_by: null,
    reviewed_at: null,
    resolution: null,
    action_taken: null,
    created_at: now,
    updated_at: now,
  };
  const [inserted] = await db.insert(contentReviewQueue).values(row)
    .returning();

  await logAudit(
    "review.queued",
    {
      action: "review.queued",
      content_type: input.content_type,
      target_id: input.target_id,
      channel: input.channel,
      status: input.status,
      verdict: input.verdict,
      review_provider: input.review_provider,
    },
    { type: `content_review_${input.content_type}`, id: input.target_id },
  );

  return inserted;
}

/** 队列列表查询参数。 */
export interface ReviewQueueFilter {
  status?: ReviewQueueStatus;
  content_type?: ReviewContentType;
  channel?: ReviewChannel;
  from?: string;
  to?: string;
  page: number;
  perPage: number;
}

/**
 * 分页查询统一审查队列（默认待人工处理，按创建时间倒序）。
 */
export async function listReviewQueue(filter: ReviewQueueFilter) {
  const db = getDb();
  const conds = [];
  if (filter.status) {
    conds.push(eq(contentReviewQueue.status, filter.status));
  }
  if (filter.content_type) {
    conds.push(eq(contentReviewQueue.content_type, filter.content_type));
  }
  if (filter.channel) {
    conds.push(eq(contentReviewQueue.channel, filter.channel));
  }
  if (filter.from) {
    conds.push(gte(contentReviewQueue.created_at, filter.from));
  }
  if (filter.to) {
    conds.push(lte(contentReviewQueue.created_at, filter.to));
  }
  const where = conds.length ? and(...conds) : undefined;

  const [rows, totalArr] = await Promise.all([
    db.select().from(contentReviewQueue).where(where)
      .orderBy(desc(contentReviewQueue.created_at))
      .limit(filter.perPage).offset((filter.page - 1) * filter.perPage),
    db.select({ count: sql<number>`count(*)::int` }).from(contentReviewQueue)
      .where(where),
  ]);
  const total = totalArr[0]?.count ?? 0;

  return {
    data: rows,
    total,
    page: filter.page,
    per_page: filter.perPage,
    total_pages: Math.max(1, Math.ceil(total / filter.perPage)),
  };
}

/** 队列单条记录详情。 */
export async function getReviewQueueItem(id: string) {
  const db = getDb();
  const [row] = await db.select().from(contentReviewQueue)
    .where(eq(contentReviewQueue.id, id)).limit(1);
  if (!row) throw new NotFoundError("审查记录不存在");
  return row;
}

/**
 * 人工处置统一审查队列记录：落 reviewed（或 dismissed）并写审计 review.resolved。
 * @param actorId 处置人 UUID（可为空——后台任务场景）
 */
export async function resolveReviewQueue(
  id: string,
  actorId: string | null,
  status: "reviewed" | "dismissed",
  actionTaken: string,
  resolution: string,
): Promise<typeof contentReviewQueue.$inferSelect> {
  if (!resolution?.trim()) {
    throw new ValidationError("处置说明不能为空");
  }
  const db = getDb();
  const now = nowIso();

  const [row] = await db.update(contentReviewQueue).set({
    status,
    reviewed_by: actorId,
    reviewed_at: now,
    resolution: resolution.trim(),
    action_taken: actionTaken,
    updated_at: now,
  }).where(eq(contentReviewQueue.id, id)).returning();

  if (!row) throw new NotFoundError("审查记录不存在");

  await logAudit(
    "review.resolved",
    {
      action: "review.resolved",
      content_type: row.content_type as ReviewContentType,
      target_id: row.target_id,
      status,
      action_taken: actionTaken,
      resolution,
    },
    { type: `content_review_${row.content_type}`, id: row.id },
  );

  return row;
}
