/**
 * 删除/更正请求服务（PIPL 权利保障）。
 *
 * 覆盖**内容类**（帖子/评论/提交等）的删除更正请求；账户注销另由
 * `identity/services/account-deletion.ts` 处理。
 *
 * 状态机：pending → processing → resolved | rejected。
 */

import { and, desc, eq } from "drizzle-orm";
import { getDb } from "./../../../shared/db/connection.ts";
import { dataRequests } from "./../../../shared/db/schema.ts";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "./../../../shared/base/errors.ts";
import { logAudit } from "../../system/index.ts";

/** 请求类型。 */
export const DATA_REQUEST_KINDS = ["delete", "correct"] as const;
export type DataRequestKind = (typeof DATA_REQUEST_KINDS)[number];

/** 请求对象类型。 */
export const DATA_REQUEST_TARGETS = [
  "post",
  "comment",
  "submission",
  "profile",
  "other",
] as const;
export type DataRequestTarget = (typeof DATA_REQUEST_TARGETS)[number];

/** 处理状态。 */
export const DATA_REQUEST_STATUSES = [
  "pending",
  "processing",
  "resolved",
  "rejected",
] as const;
export type DataRequestStatus = (typeof DATA_REQUEST_STATUSES)[number];

/** 对外呈现的请求行。 */
export interface DataRequestRow {
  id: string;
  user_id: string;
  kind: DataRequestKind;
  target_type: DataRequestTarget;
  target_id: string | null;
  detail: string;
  status: DataRequestStatus;
  handled_by: string | null;
  handled_at: string | null;
  resolution: string | null;
  created_at: string;
  updated_at: string;
}

/** 允许的状态转换。 */
const ALLOWED_TRANSITIONS: Record<DataRequestStatus, DataRequestStatus[]> = {
  pending: ["processing", "resolved", "rejected"],
  processing: ["resolved", "rejected"],
  resolved: [],
  rejected: [],
};

/** 校验枚举值，非法抛 ValidationError。 */
function assertEnum<T extends string>(
  value: string,
  allowed: readonly T[],
  field: string,
): asserts value is T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(`无效的 ${field}：${value}`);
  }
}

/**
 * 创建删除/更正请求。
 *
 * @returns 新请求 id
 */
export async function createDataRequest(
  userId: string,
  kind: string,
  targetType: string,
  targetId: string | null,
  detail: string,
): Promise<string> {
  assertEnum(kind, DATA_REQUEST_KINDS, "kind");
  assertEnum(targetType, DATA_REQUEST_TARGETS, "target_type");
  if (typeof detail !== "string" || detail.trim().length === 0) {
    throw new ValidationError("请填写请求说明");
  }
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(dataRequests).values({
    id,
    user_id: userId,
    kind,
    target_type: targetType,
    target_id: targetId,
    detail: detail.trim(),
    status: "pending",
    created_at: now,
    updated_at: now,
  });
  return id;
}

/** 列出某用户自己的请求（最新在前）。 */
export async function listUserDataRequests(
  userId: string,
): Promise<DataRequestRow[]> {
  const db = getDb();
  return await db
    .select()
    .from(dataRequests)
    .where(eq(dataRequests.user_id, userId))
    .orderBy(desc(dataRequests.created_at)) as DataRequestRow[];
}

/** 列出全部请求（管理端；可按状态过滤）。 */
export async function listAllDataRequests(
  status?: string,
): Promise<DataRequestRow[]> {
  const db = getDb();
  const where = status ? and(eq(dataRequests.status, status)) : undefined;
  return await db
    .select()
    .from(dataRequests)
    .where(where)
    .orderBy(desc(dataRequests.created_at)) as DataRequestRow[];
}

/**
 * 更新请求状态（管理端）。
 *
 * @throws NotFoundError 请求不存在
 * @throws BadRequestError 非法状态转换
 */
export async function updateDataRequestStatus(
  id: string,
  status: string,
  handledBy: string,
  resolution: string | null,
): Promise<void> {
  assertEnum(status, DATA_REQUEST_STATUSES, "status");
  const db = getDb();
  const [row] = await db
    .select()
    .from(dataRequests)
    .where(eq(dataRequests.id, id))
    .limit(1);
  if (!row) throw new NotFoundError("请求不存在");

  const current = row.status as DataRequestStatus;
  if (!ALLOWED_TRANSITIONS[current].includes(status)) {
    throw new BadRequestError(
      `不允许的状态转换：${current} → ${status}`,
    );
  }

  // 乐观锁（2026-09-24 评审）：WHERE 带上读取时的 status，防两个管理员并发
  // 处置同一请求时后写覆盖前写（状态机校验基于读取时的值）。
  const updated = await db
    .update(dataRequests)
    .set({
      status,
      handled_by: handledBy,
      handled_at: new Date().toISOString(),
      resolution,
      updated_at: new Date().toISOString(),
    })
    .where(and(eq(dataRequests.id, id), eq(dataRequests.status, current)))
    .returning({ id: dataRequests.id });
  if (updated.length === 0) {
    throw new ConflictError(
      "请求状态已被其他管理员更新，请刷新后重试",
    );
  }

  // 合规留痕（2026-09-24 评审）：权利请求的处置必须可审计（谁在何时批准/驳回）。
  await logAudit(
    "legal.data_request_update",
    {
      action: "legal.data_request_update",
      id,
      from: current,
      to: status,
    },
    { type: "data_request", id },
  );
}
