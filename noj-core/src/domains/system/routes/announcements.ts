/**
 * 公告公开路由（issue #231）。
 *
 * 提供：
 * - GET /api/v1/announcements：公开列表（仅 active，置顶优先 + 分页）
 * - GET /api/v1/announcements/events：公告变更 SSE（需登录，注册在 /:id 之前，
 *   避免被参数路由捕获；此端点必须留在本实例内——若放 sse.ts 并挂载于其后，
 *   公开路由会被 sse 实例的全局 authMiddleware 拦截，见 app.ts 挂载注释）
 * - GET /api/v1/announcements/:id：公开详情（非 active / 不存在 → 404）
 *
 * 挂载前缀为 /api/v1/announcements（见 app.ts），本文件内为相对路径。
 */

import { Hono } from "hono";
import { authMiddleware } from "./../../identity/index.ts";
import { Channels, onEvent } from "./../../../shared/sse/event-bus.ts";
import { createSseStream } from "./../../../shared/sse/sse-stream.ts";
import { parsePagination } from "./../../../shared/http/pagination.ts";
import {
  getPublicAnnouncement,
  listPublicAnnouncements,
  resolveAnnouncementId,
} from "../services/announcements.ts";

const router = new Hono();

/**
 * 公开公告列表。
 * GET /api/v1/announcements?page=1&per_page=20
 * 仅返回 is_active=true 的公告，排序 is_pinned DESC, created_at DESC。
 */
router.get("/", async (c) => {
  const { page, perPage } = parsePagination(c);
  const result = await listPublicAnnouncements(page, perPage);
  return c.json(result);
});

/**
 * 公告变更 SSE 端点。
 *
 * 登录用户可订阅。收到 `announcement:updated` 事件后，
 * 前端应重新拉取公告列表（首页轮播 / 公开列表页），
 * 与 `queue:changed` 同模式：事件 data 仅作触发通知，不含公告完整数据。
 *
 * 事件格式：
 *   event: announcement:updated
 *   data: { type: "announcement:updated" }
 */
router.get("/events", authMiddleware, (c) => {
  return createSseStream(
    c,
    ({ stream, closed, close, onUnsubscribe }) => {
      onUnsubscribe(
        onEvent(
          Channels.announcements,
          (_channel, message) => {
            if (closed) return;
            stream.writeSSE({
              event: "announcement:updated",
              data: message,
            }).catch(() => {
              close();
            });
          },
        ),
      );
    },
  );
});

/**
 * 公开公告详情。
 * GET /api/v1/announcements/:id
 * 非 active 或不存在 → 404（NotFoundError 由 app.ts 统一处理）。
 */
router.get("/:id", async (c) => {
  const id = await resolveAnnouncementId(c.req.param("id") as string);
  const detail = await getPublicAnnouncement(id);
  return c.json(detail);
});

export default router;
