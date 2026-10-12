/**
 * 轮播管理路由。
 *
 * 挂载到 `/api/v1/admin/carousel`（见 admin/index.ts）。
 * 细粒度权限：`announcement:manage`（与公告管理复用同一运营展示位权限）。
 *
 * - GET    /slides               列出全部（含停用）
 * - POST   /slides               新建
 * - PATCH  /slides/:id           更新
 * - DELETE /slides/:id           删除
 * - POST   /slides/reorder       按 id 顺序重排
 */

import { Hono } from "hono";
import {
  assertPermission,
  type AuthEnv,
  authMiddleware,
} from "./../../identity/index.ts";
import { parseJsonBody } from "./../../../shared/http/request.ts";
import { BadRequestError } from "./../../../shared/base/errors.ts";
import { enforceRateLimit } from "./../../system/index.ts";
import { withActorContext } from "./../../system/index.ts";
import {
  type CarouselSlideInput,
  createSlide,
  deleteSlide,
  listAllSlides,
  reorderSlides,
  updateSlide,
  uploadCarouselImage,
} from "./../../system/services/carousel.ts";

const router = new Hono<AuthEnv>();

// 组级注入 Actor RequestContext：审计日志（logAudit）依赖 getRequestContext()，
// 而管理员路径经 FINE_GRAINED_ADMIN_PREFIXES 跳过了注入上下文的 adminMiddleware。
// 与 admin/routes/catalog.ts 同模式。
router.use("*", authMiddleware, (c, next) => {
  return withActorContext(c, () => next());
});

/** 解析幻灯片请求体（校验在 service 层）。 */
function parseSlideInput(body: Record<string, unknown>): CarouselSlideInput {
  return {
    kind: body.kind as CarouselSlideInput["kind"],
    image_storage_url: body.image_storage_url as string | null | undefined,
    title: body.title as string | null | undefined,
    subtitle: body.subtitle as string | null | undefined,
    gradient_key: body.gradient_key as string | null | undefined,
    link_url: body.link_url as string | null | undefined,
    is_enabled: body.is_enabled as boolean | undefined,
  };
}

/** 全部幻灯片（含停用）。 */
router.get("/slides", async (c) => {
  await assertPermission(c, "announcement:manage");
  const data = await listAllSlides();
  return c.json({ data });
});

/** 新建幻灯片。 */
router.post("/slides", async (c) => {
  await assertPermission(c, "announcement:manage");
  await enforceRateLimit(
    `carousel-write:user:${c.get("userId") as string}`,
    { windowSec: 60, max: 30 },
  );
  const body = await parseJsonBody<Record<string, unknown>>(c);
  const id = await createSlide(parseSlideInput(body));
  return c.json({ data: { id } }, 201);
});

/** 按 id 顺序重排（须在 /slides/:id 之前注册，避免 "reorder" 被当作 id）。 */
router.post("/slides/reorder", async (c) => {
  await assertPermission(c, "announcement:manage");
  await enforceRateLimit(
    `carousel-write:user:${c.get("userId") as string}`,
    { windowSec: 60, max: 30 },
  );
  const body = await parseJsonBody<{ ids?: string[] }>(c);
  await reorderSlides(Array.isArray(body.ids) ? body.ids : []);
  return c.json({ data: { reordered: true } });
});

/** 上传轮播图片（multipart `file` 字段）。 */
router.post("/images", async (c) => {
  await assertPermission(c, "announcement:manage");
  await enforceRateLimit(
    `carousel-upload:user:${c.get("userId") as string}`,
    { windowSec: 60, max: 10 },
  );
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!file || !(file instanceof File)) {
    throw new BadRequestError("请上传有效的图片文件");
  }
  const url = await uploadCarouselImage(file);
  return c.json({ data: { image_storage_url: url } }, 201);
});

/** 更新幻灯片。 */
router.patch("/slides/:id", async (c) => {
  await assertPermission(c, "announcement:manage");
  await enforceRateLimit(
    `carousel-write:user:${c.get("userId") as string}`,
    { windowSec: 60, max: 30 },
  );
  const body = await parseJsonBody<Record<string, unknown>>(c);
  await updateSlide(c.req.param("id") ?? "", parseSlideInput(body));
  return c.json({ data: { updated: true } });
});

/** 删除幻灯片。 */
router.delete("/slides/:id", async (c) => {
  await assertPermission(c, "announcement:manage");
  await enforceRateLimit(
    `carousel-write:user:${c.get("userId") as string}`,
    { windowSec: 60, max: 30 },
  );
  await deleteSlide(c.req.param("id") ?? "");
  return c.body(null, 204);
});

export default router;
