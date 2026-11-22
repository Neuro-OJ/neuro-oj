/**
 * Gateway 实例政策内部路由（P5）。
 *
 * 挂载在内部管理路由下（`createInternalRouter`），沿用服务间 Bearer Token 鉴权。
 *
 * - `GET  /internal/policy`：当前政策 + revision（预占路径的本地权威）
 * - `PUT  /internal/policy`：要求 operation ID、预期 revision、授权管理者；
 *   原子提交政策、操作结果与审计
 * - `GET  /internal/operations/:operationId`：查询超时操作的持久结果
 *
 * Core 只保留管理员授权，不再持有第二份可写政策权威。
 */
import { Hono } from "hono";
import type { Db } from "../db.ts";
import { HTTPException } from "hono/http-exception";
import {
  applyPolicyOperationTx,
  POLICY_ERRORS,
  readCurrentPolicy,
  readPolicyOperation,
  validateCaps,
} from "../policy-operations.ts";

export interface InternalPolicyDeps {
  db: Db;
}

/** 创建政策路由；调用方负责挂载与鉴权中间件。 */
export function createInternalPolicyRouter(deps: InternalPolicyDeps): Hono {
  const app = new Hono();

  // 当前政策（本地权威；不再回查 Core）
  app.get("/internal/policy", async (c) => {
    const policy = await readCurrentPolicy(deps.db);
    c.header("Cache-Control", "no-store");
    return c.json({
      data: {
        revision: policy.revision,
        day: policy.day,
        month: policy.month,
        updated_at: policy.updated_at,
      },
    });
  });

  // 写入政策：operation ID 必填、预期 revision 必填、actor 必填。
  app.put("/internal/policy", async (c) => {
    const operationId = c.req.header("X-Noj-Operation-Id")?.trim() ?? "";
    if (!operationId) {
      return c.json({ error: "operation_id_required" }, 400);
    }
    const rawRevision = c.req.header("X-Noj-Expected-Revision");
    if (rawRevision === undefined) {
      return c.json({ error: "expected_revision_required" }, 428);
    }
    const expectedRevision = Number(rawRevision);
    if (!/^\d+$/.test(rawRevision) || !Number.isSafeInteger(expectedRevision)) {
      return c.json({ error: "invalid_expected_revision" }, 400);
    }
    const actorId = c.req.header("X-Noj-Actor-Id")?.trim() ?? "";
    if (!actorId) return c.json({ error: "actor_required" }, 400);

    let caps;
    try {
      caps = validateCaps(await c.req.json());
    } catch {
      return c.json({ error: POLICY_ERRORS.invalidCaps }, 400);
    }

    const result = await applyPolicyOperationTx(deps.db, {
      operationId,
      expectedRevision,
      caps,
      actorId,
    });
    if (result.status === "conflict") {
      const code = result.error_code ?? POLICY_ERRORS.revisionConflict;
      const status = code === POLICY_ERRORS.operationConflict ? 409 : 409;
      return c.json({ error: code, revision: result.revision }, status);
    }
    c.header("Cache-Control", "no-store");
    return c.json({
      data: {
        operation_id: result.operation_id,
        status: result.status,
        revision: result.revision,
        policy: result.policy,
      },
    });
  });

  // 查询超时操作的持久结果
  app.get("/internal/operations/:operationId", async (c) => {
    const operationId = c.req.param("operationId");
    const result = await readPolicyOperation(deps.db, operationId);
    if (!result) {
      throw new HTTPException(404, {
        res: c.json({ error: "operation_not_found" }, 404),
      });
    }
    return c.json({
      data: {
        operation_id: result.operation_id,
        status: result.status,
        revision: result.revision,
        policy: result.policy,
        error_code: result.error_code,
      },
    });
  });

  return app;
}
