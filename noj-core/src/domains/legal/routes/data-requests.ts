/**
 * legal 域删除/更正请求路由（用户侧）。
 *
 * POST /api/v1/legal/data-requests —— 提交请求
 * GET  /api/v1/legal/data-requests —— 查看自己的请求
 */

import { Hono } from "hono";
import { type AuthEnv, authMiddleware } from "./../../identity/index.ts";
import { parseJsonBody } from "./../../../shared/http/request.ts";
import { enforceRateLimit } from "./../../system/index.ts";
import {
  createDataRequest,
  listUserDataRequests,
} from "../services/data-requests.ts";

const router = new Hono<AuthEnv>();

/** 提交请求限流：每用户 5 分钟最多 10 次。 */
const REQUEST_LIMIT = { windowSec: 300, max: 10 };

/** 提交删除/更正请求。 */
router.post("/data-requests", authMiddleware, async (c) => {
  const userId = c.get("userId") as string;
  await enforceRateLimit(`data-request:user:${userId}`, REQUEST_LIMIT);

  const body = await parseJsonBody<{
    kind?: string;
    target_type?: string;
    target_id?: string | null;
    detail?: string;
  }>(c);

  const id = await createDataRequest(
    userId,
    body.kind ?? "",
    body.target_type ?? "",
    body.target_id ?? null,
    body.detail ?? "",
  );
  return c.json({ data: { id } }, 201);
});

/** 查看自己的请求列表。 */
router.get("/data-requests", authMiddleware, async (c) => {
  const userId = c.get("userId") as string;
  const rows = await listUserDataRequests(userId);
  return c.json({ data: rows });
});

export default router;
