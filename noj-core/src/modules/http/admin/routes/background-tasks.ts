/**
 * 后台任务管理路由（P4）。
 *
 * 挂载前缀 `/api/v1/admin/background-tasks`（见 `domains/admin/index.ts`）。
 *
 * - `GET /` 任务列表（按状态/类型过滤，分页）
 * - `GET /health` 任务健康快照（积压、最老年龄、失败数、租约到期）
 * - `GET /:id` 任务详情
 * - `POST /:id/retry` 管理员重试终态失败任务（审计 + 不抢占有效租约）
 *
 * 只读端点与重试都要求管理员权限；重试写入审计日志，便于追责。
 */
import { Hono } from "hono";
import type { AuthEnv } from "../../../access/identity/middleware/auth.ts";
import { BadRequestError, NotFoundError } from "../../../../shared/base/errors.ts";
import {
  getTaskById,
  listTasks,
  readTaskHealth,
  requeueFailedTaskTx,
} from "../../../runtime/tasks/repository.ts";
import { appendAuditLogTx } from "../../../platform/contracts/audit.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import type { BackgroundTaskRow } from "../../../../shared/db/schema.ts";

const router = new Hono<AuthEnv>();

/** 把任务行裁剪成管理端可公开的形态（不含 payload 内部凭据）。 */
function toTaskResponse(row: BackgroundTaskRow) {
  return {
    id: row.id,
    task_type: row.task_type,
    target_kind: row.target_kind,
    target_id: row.target_id,
    dedupe_key: row.dedupe_key,
    payload_version: row.payload_version,
    status: row.status,
    available_at: row.available_at,
    failure_count: row.failure_count,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
    finished_at: row.finished_at,
  };
}

/** 任务列表。 */
router.get("/", async (c) => {
  const page = Math.max(1, Number(c.req.query("page") ?? "1") || 1);
  const perPage = Math.min(
    200,
    Math.max(1, Number(c.req.query("per_page") ?? "50") || 50),
  );
  const status = c.req.query("status") as
    | BackgroundTaskRow["status"]
    | undefined;
  const taskType = c.req.query("task_type") ?? undefined;
  const { data, total } = await listTasks({
    status,
    taskType,
    limit: perPage,
    offset: (page - 1) * perPage,
  });
  return c.json({
    data: data.map(toTaskResponse),
    total,
    page,
    per_page: perPage,
  });
});

/** 任务健康快照；指标标签不含 task ID 或用户 ID。 */
router.get("/health", async (c) => {
  const health = await readTaskHealth();
  return c.json({
    data: {
      ready: health.ready,
      leased: health.leased,
      failed: health.failed,
      oldest_ready_age_ms: health.oldestReadyAgeMs,
      next_lease_expiry_ms: health.nextLeaseExpiryMs,
    },
  });
});

/** 任务详情。 */
router.get("/:id", async (c) => {
  const row = await getTaskById(c.req.param("id") as string);
  if (!row) throw new NotFoundError("任务不存在");
  return c.json({ data: toTaskResponse(row) });
});

/**
 * 人工重试终态失败任务。
 *
 * 只处理 `failed`：有效租约中的任务不会被抢占；成功重试写入审计。
 */
router.post("/:id/retry", async (c) => {
  const taskId = c.req.param("id") as string;
  const row = await getTaskById(taskId);
  if (!row) throw new NotFoundError("任务不存在");
  if (row.status !== "failed") {
    throw new BadRequestError(
      "只有终态失败的任务可以人工重试",
      "TASK_NOT_FAILED",
    );
  }
  const requeued = await getDb().transaction(async (tx) => {
    const ok = await requeueFailedTaskTx(tx, taskId);
    if (!ok) return false;
    await appendAuditLogTx(tx, {
      actor: c.var.actor,
      action: "background_task.retry",
      target: { type: "background_task", id: taskId },
      detail: {
        action: "background_task.retry",
        task_type: row.task_type,
        target_kind: row.target_kind,
        target_id: row.target_id,
        previous_failure_count: row.failure_count,
      },
    });
    return true;
  });
  if (!requeued) {
    throw new BadRequestError("任务状态已变化，无法重试", "TASK_NOT_FAILED");
  }
  return c.json({ data: { id: taskId, status: "pending" } }, 202);
});

export default router;
