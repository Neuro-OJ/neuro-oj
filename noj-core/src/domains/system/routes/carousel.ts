/**
 * 轮播公开路由。
 *
 * 挂载前缀 /api/v1/carousel（见 app.ts），本文件内为相对路径。
 * 只读端点，无需认证与限流。
 */

import { Hono } from "hono";
import {
  getCarouselImageBytes,
  listEnabledSlides,
} from "../services/carousel.ts";

const router = new Hono();

/**
 * 已启用的轮播幻灯片（按 sort_order 升序）。
 * GET /api/v1/carousel/slides
 */
router.get("/slides", async (c) => {
  const data = await listEnabledSlides();
  return c.json({ data });
});

/**
 * 轮播图片字节流（公开）。
 * GET /api/v1/carousel/slides/:id/image
 *
 * 供前端 `<img>` 展示（`noj-storage://` 不能直接作 src）。
 */
router.get("/slides/:id/image", async (c) => {
  const { bytes, contentType, etag } = await getCarouselImageBytes(
    c.req.param("id") ?? "",
  );
  return new Response(bytes as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400",
      "ETag": etag,
    },
  });
});

export default router;
