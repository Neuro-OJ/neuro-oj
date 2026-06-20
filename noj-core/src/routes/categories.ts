import { Hono } from "hono";
import { adminMiddleware, authMiddleware } from "../middleware/auth.ts";
import { parseJsonBody } from "../lib/request.ts";
import { ValidationError } from "../lib/errors.ts";
import {
  createCategory,
  deleteCategory,
  getCategory,
  listCategories,
  updateCategory,
} from "../services/categories.ts";
import type {
  CreateCategoryInput,
  UpdateCategoryInput,
} from "../services/categories.ts";

const router = new Hono<{ Variables: { userId: string; userRole: string } }>();

/**
 * 获取分类树。
 * GET /api/v1/categories
 */
router.get("/", async (c) => {
  const tree = await listCategories();
  return c.json({ data: tree });
});

/**
 * 获取单个分类详情。
 * GET /api/v1/categories/:id
 */
router.get("/:id", async (c) => {
  const id = c.req.param("id") as string;
  const category = await getCategory(id);
  return c.json({ data: category });
});

/**
 * 创建分类（管理员）。
 * POST /api/v1/categories
 */
router.post("/", authMiddleware, adminMiddleware, async (c) => {
  const body = await parseJsonBody<CreateCategoryInput>(c);

  if (!body.name || !body.slug) {
    throw new ValidationError("缺少必填字段：name, slug");
  }

  const category = await createCategory(body);
  return c.json({ data: category }, 201);
});

/**
 * 更新分类（管理员）。
 * PUT /api/v1/categories/:id
 */
router.put("/:id", authMiddleware, adminMiddleware, async (c) => {
  const id = c.req.param("id") as string;
  const body = await parseJsonBody<UpdateCategoryInput>(c);
  const category = await updateCategory(id, body);
  return c.json({ data: category });
});

/**
 * 删除分类（管理员）。
 * DELETE /api/v1/categories/:id
 */
router.delete("/:id", authMiddleware, adminMiddleware, async (c) => {
  const id = c.req.param("id") as string;
  await deleteCategory(id);
  return c.body(null, 204);
});

export default router;
