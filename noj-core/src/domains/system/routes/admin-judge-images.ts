import { Hono } from "hono";
import type { AuthEnv } from "../../../middleware/auth.ts";
import { parseJsonBody } from "./../../../shared/http/request.ts";
import { BadRequestError } from "./../../../shared/base/errors.ts";
import {
  createJudgeImage,
  deleteJudgeImage,
  listJudgeImages,
  updateJudgeImage,
} from "../services/judge-images.ts";
import type {
  CreateJudgeImageInput,
  UpdateJudgeImageInput,
} from "../../../types/problems.ts";

/**
 * 管理端评测镜像白名单路由（挂载前缀 /api/v1/admin，见 admin/index.ts）。
 *
 * 提供：
 * - GET/POST /judge-images       白名单列表 / 新增
 * - PUT/DELETE /judge-images/:id 更新 / 删除
 */
const router = new Hono<AuthEnv>();

/**
 * 获取所有白名单条目。
 * GET /api/v1/admin/judge-images
 */
router.get("/judge-images", async (c) => {
  const items = await listJudgeImages();
  return c.json({ data: items });
});

/**
 * 新增白名单条目。
 * POST /api/v1/admin/judge-images
 */
router.post("/judge-images", async (c) => {
  const body = await parseJsonBody<CreateJudgeImageInput>(c);

  if (!body.image?.trim()) {
    throw new BadRequestError("镜像名不能为空");
  }

  const item = await createJudgeImage(body);
  return c.json({ data: item }, 201);
});

/**
 * 更新白名单条目。
 * PUT /api/v1/admin/judge-images/:id
 */
router.put("/judge-images/:id", async (c) => {
  const id = c.req.param("id") as string;
  const body = await parseJsonBody<UpdateJudgeImageInput>(c);
  const item = await updateJudgeImage(id, body);
  return c.json({ data: item }, 200);
});

/**
 * 删除白名单条目。
 * DELETE /api/v1/admin/judge-images/:id
 */
router.delete("/judge-images/:id", async (c) => {
  const id = c.req.param("id") as string;
  await deleteJudgeImage(id);
  return c.body(null, 204);
});

export default router;
