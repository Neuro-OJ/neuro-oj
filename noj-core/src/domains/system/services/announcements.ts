/**
 * 公告服务层（issue #231）。
 *
 * 提供：
 * - listPublicAnnouncements()：公开列表（仅 active，置顶优先 + 分页）
 * - getPublicAnnouncement()：公开详情（非 active / 不存在 → 404）
 * - listAdminAnnouncements()：管理列表（含未发布/已下架，可选 is_active 筛选）
 * - createAnnouncement() / updateAnnouncement() / deleteAnnouncement()：管理 CRUD
 *
 * 约定：
 * - 细粒度权限（assertPermission("announcement:manage")）在路由层 handler 内执行，
 *   服务层经 getRequestContext() 取操作者（adminMiddleware 已注入）。
 * - 全部写操作记录审计日志（announcement.create / update / delete）。
 * - 写成功后 publishEvent 广播变更（fire-and-forget，Redis 不可用时跳过，
 *   由前端页面加载 / 轮询 fallback 兜底，与既有事件机制一致）。
 */

import { and, count, desc, eq } from "drizzle-orm";
import { getDb } from "./../../../shared/db/connection.ts";
import { announcements } from "./../../../shared/db/schema.ts";
import {
  NotFoundError,
  ValidationError,
} from "./../../../shared/base/errors.ts";
import { Channels, publishSseEvent } from "../../../lib/event-bus.ts";
import { generatePublicId, resolvePublicId } from "../../../lib/public-id.ts";
import { getRequestContext } from "../../../lib/requestContext.ts";
import {
  buildPaginationMeta,
  type PaginationMeta,
} from "./../../../shared/http/pagination.ts";
import { logAudit } from "./audit-log.ts";

/** 列表摘要截断长度（Markdown 源码字符数） */
const EXCERPT_LENGTH = 120;
/** 标题长度上限 */
const TITLE_MAX = 100;
/** 内容长度上限 */
const CONTENT_MAX = 50000;

/** 公开列表项（不含 content 全文） */
export interface AnnouncementSummary {
  id: string;
  public_id: string;
  title: string;
  is_pinned: boolean;
  created_at: string;
  updated_at: string;
  /** content Markdown 源码截断 120 字符 */
  excerpt: string;
}

/** 公开详情（含 content 全文） */
export interface AnnouncementDetail {
  id: string;
  public_id: string;
  title: string;
  content: string;
  is_pinned: boolean;
  created_at: string;
  updated_at: string;
  created_by: string;
}

/** 管理列表项（含 content 全文与发布状态） */
export interface AdminAnnouncementItem {
  id: string;
  public_id: string;
  title: string;
  content: string;
  is_pinned: boolean;
  is_active: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** 创建公告入参（is_pinned / is_active 缺省 false / true） */
export interface CreateAnnouncementInput {
  title: string;
  content: string;
  is_pinned?: boolean;
  is_active?: boolean;
}

/** 更新公告入参（部分更新语义；发布/下架 = 更新 is_active） */
export interface UpdateAnnouncementInput {
  title?: string;
  content?: string;
  is_pinned?: boolean;
  is_active?: boolean;
}

/** 公开列表响应 */
export interface PublicAnnouncementListResponse {
  data: AnnouncementSummary[];
  meta: PaginationMeta;
}

/** 管理列表响应 */
export interface AdminAnnouncementListResponse {
  data: AdminAnnouncementItem[];
  meta: PaginationMeta;
}

/** 广播公告变更（写 SSE 事件日志 + Redis 通知） */
async function broadcastAnnouncementUpdate(): Promise<void> {
  await publishSseEvent(
    Channels.announcements,
    { type: "announcement:updated" },
  );
}

/** 标题 / 内容长度校验（title 1–100、content 1–50000），非法抛 400 */
function validateFields(title?: string, content?: string): void {
  if (title !== undefined) {
    const t = title.trim();
    if (t.length < 1 || t.length > TITLE_MAX) {
      throw new ValidationError(`title 长度必须在 1–${TITLE_MAX} 字符之间`);
    }
  }
  if (content !== undefined) {
    const c = content.trim();
    if (c.length < 1 || c.length > CONTENT_MAX) {
      throw new ValidationError(`content 长度必须在 1–${CONTENT_MAX} 字符之间`);
    }
  }
}

/**
 * 公开列表：仅 active，置顶优先（is_pinned DESC）+ 最新在前（created_at DESC）。
 */
export async function listPublicAnnouncements(
  page: number,
  perPage: number,
): Promise<PublicAnnouncementListResponse> {
  const db = getDb();
  const offset = (page - 1) * perPage;
  const where = eq(announcements.is_active, true);

  const [rows, totalRow] = await Promise.all([
    db.select().from(announcements)
      .where(where)
      .orderBy(desc(announcements.is_pinned), desc(announcements.created_at))
      .limit(perPage)
      .offset(offset),
    db.select({ value: count() }).from(announcements).where(where),
  ]);

  const data = rows.map((row) => ({
    id: row.id,
    public_id: row.public_id,
    title: row.title,
    is_pinned: row.is_pinned,
    created_at: row.created_at,
    updated_at: row.updated_at,
    excerpt: row.content.slice(0, EXCERPT_LENGTH),
  }));

  return { data, meta: buildPaginationMeta(page, perPage, totalRow[0].value) };
}

/**
 * 公开详情：仅 active 可见；非 active 或不存在 → NotFoundError（404）。
 */
export async function getPublicAnnouncement(
  id: string,
): Promise<AnnouncementDetail> {
  const db = getDb();
  const [row] = await db.select().from(announcements)
    .where(and(eq(announcements.id, id), eq(announcements.is_active, true)))
    .limit(1);

  if (!row) {
    throw new NotFoundError("公告不存在或已下架");
  }

  return {
    id: row.id,
    public_id: row.public_id,
    title: row.title,
    content: row.content,
    is_pinned: row.is_pinned,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
  };
}

/**
 * 管理列表：全量（含未发布/已下架），最新在前，分页 + 可选 is_active 筛选。
 */
export async function listAdminAnnouncements(
  page: number,
  perPage: number,
  isActive?: boolean,
): Promise<AdminAnnouncementListResponse> {
  const db = getDb();
  const offset = (page - 1) * perPage;
  const conditions = isActive === undefined
    ? []
    : [eq(announcements.is_active, isActive)];

  const [rows, totalRow] = await Promise.all([
    db.select().from(announcements)
      .where(and(...conditions))
      .orderBy(desc(announcements.created_at))
      .limit(perPage)
      .offset(offset),
    db.select({ value: count() }).from(announcements).where(and(...conditions)),
  ]);

  return {
    data: rows.map((row) => ({ ...row })),
    meta: buildPaginationMeta(page, perPage, totalRow[0].value),
  };
}

/**
 * 将 UUID 或 public_id 解析为内部公告 UUID。
 */
export function resolveAnnouncementId(value: string): Promise<string> {
  return resolvePublicId(
    announcements,
    announcements.id,
    announcements.public_id,
    "ann",
    value,
    "公告不存在",
  );
}

/**
 * 创建公告。created_by 写入当前操作者（RequestContext）。
 *
 * @throws {ValidationError} title / content 缺失或长度非法（HTTP 400）
 */
export async function createAnnouncement(
  input: CreateAnnouncementInput,
): Promise<AdminAnnouncementItem> {
  // 必填校验：title / content 必须存在（否则会绕过 validateFields，
  // 落到 DB NOT NULL 约束抛 500，而非 spec 要求的 400）
  if (
    typeof input.title !== "string" ||
    typeof input.content !== "string"
  ) {
    throw new ValidationError("缺少必填字段：title、content");
  }
  validateFields(input.title, input.content);

  const db = getDb();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const publicId = generatePublicId("ann");
  const actorId = getRequestContext().actorId;

  await db.insert(announcements).values({
    id,
    public_id: publicId,
    title: input.title.trim(),
    content: input.content.trim(),
    is_pinned: input.is_pinned ?? false,
    is_active: input.is_active ?? true,
    created_by: actorId,
    created_at: now,
    updated_at: now,
  });

  const [row] = await db.select().from(announcements)
    .where(eq(announcements.id, id))
    .limit(1);

  await logAudit(
    "announcement.create",
    { action: "announcement.create", title: row!.title },
    { type: "announcement", id },
  );
  await broadcastAnnouncementUpdate();

  return { ...row! };
}

/**
 * 更新公告（部分更新语义）；发布/下架 = 更新 is_active。
 *
 * @throws {NotFoundError} 公告不存在
 */
export async function updateAnnouncement(
  id: string,
  input: UpdateAnnouncementInput,
): Promise<AdminAnnouncementItem> {
  validateFields(input.title, input.content);

  const db = getDb();
  const existing = await db.select().from(announcements)
    .where(eq(announcements.id, id))
    .limit(1);
  if (existing.length === 0) {
    throw new NotFoundError("公告不存在");
  }

  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (input.title !== undefined) updates.title = input.title.trim();
  if (input.content !== undefined) updates.content = input.content.trim();
  if (input.is_pinned !== undefined) updates.is_pinned = input.is_pinned;
  if (input.is_active !== undefined) updates.is_active = input.is_active;

  await db.update(announcements).set(updates).where(eq(announcements.id, id));

  const [row] = await db.select().from(announcements)
    .where(eq(announcements.id, id))
    .limit(1);

  await logAudit(
    "announcement.update",
    { action: "announcement.update", title: row!.title },
    { type: "announcement", id },
  );
  await broadcastAnnouncementUpdate();

  return { ...row! };
}

/**
 * 物理删除公告。
 *
 * @throws {NotFoundError} 公告不存在
 */
export async function deleteAnnouncement(id: string): Promise<void> {
  const db = getDb();
  const existing = await db.select().from(announcements)
    .where(eq(announcements.id, id))
    .limit(1);
  if (existing.length === 0) {
    throw new NotFoundError("公告不存在");
  }

  await db.delete(announcements).where(eq(announcements.id, id));

  await logAudit(
    "announcement.delete",
    { action: "announcement.delete", title: existing[0].title },
    { type: "announcement", id },
  );
  await broadcastAnnouncementUpdate();
}
