import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.ts";
import { parseJsonBody } from "../lib/request.ts";
import { BadRequestError } from "../lib/errors.ts";
import {
  createProblem,
  deleteProblem,
  getProblem,
  getProblemByTypeAndNumber,
  listProblems,
  updateProblem,
} from "../services/problems.ts";
import type {
  CreateProblemInput,
  ProblemListQuery,
  UpdateProblemInput,
} from "../types/problems.ts";
import {
  deleteSupportPackage,
  MAX_SUPPORT_PACKAGE_SIZE,
  saveSupportPackage,
} from "../services/support-package.ts";

const router = new Hono<{ Variables: { userId: string; userRole: string } }>();

/**
 * 双索引查找工具函数。
 * 支持通过 UUID、display_id（如 P1001）、纯数字 ID（兼容旧 seed 数据 1001/1002/1003）
 * 以及其他任意非标准 ID 格式查找题目。
 *
 * 先通过正则判断 id 格式，避免每次 display_id 请求都先多一次 UUID 查询。
 * 对于不匹配任何已知格式的 ID，fallback 到 `getProblem(id)` 直接查找。
 */
async function resolveProblem(id: string) {
  // UUID 格式：直接按 id 精确查找
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  ) {
    return await getProblem(id);
  }

  // display_id 格式：解析 "P1001" / "U42" → (type, number)
  const match = id.match(/^([UuPp])(\d+)$/);
  if (match) {
    const type = match[1].toUpperCase();
    const number = parseInt(match[2], 10);
    return await getProblemByTypeAndNumber(type, number);
  }

  // 纯数字 id（兼容旧 seed 数据 1001/1002/1003 等使用数字编号的题目）
  if (/^\d+$/.test(id)) {
    return await getProblem(id);
  }

  // fallback：尝试直接按 id 查找（兼容非标准 ID 格式）
  return await getProblem(id);
}

/**
 * 获取题目列表。
 * 支持分页与筛选：?page=1&limit=20&difficulty=easy&category_id=xxx&keyword=xxx&type=U&number=1001
 */
router.get("/", async (c) => {
  const page = parseInt(c.req.query("page") || "1", 10);
  const limit = parseInt(c.req.query("limit") || "20", 10);

  // 校验非数字输入
  if (Number.isNaN(page) || Number.isNaN(limit)) {
    throw new BadRequestError("分页参数 page 和 limit 必须为数字");
  }

  const query: ProblemListQuery = {
    page: Math.max(1, page),
    limit: Math.min(100, Math.max(1, limit)),
  };

  const difficulty = c.req.query("difficulty");
  if (difficulty) query.difficulty = difficulty;

  const categoryId = c.req.query("category_id");
  if (categoryId) query.category_id = categoryId;

  const keyword = c.req.query("keyword");
  if (keyword) query.keyword = keyword;

  const type = c.req.query("type");
  if (type) query.type = type;

  const numberStr = c.req.query("number");
  if (numberStr) {
    const number = parseInt(numberStr, 10);
    if (!Number.isNaN(number)) query.number = number;
  }

  const ownerId = c.req.query("owner_id");
  if (ownerId) query.owner_id = ownerId;

  const result = await listProblems(query);
  return c.json({
    data: result.items,
    total: result.total,
    page: result.page,
    limit: result.limit,
  });
});

/**
 * 获取题目详情（双索引：UUID 或 display_id）。
 */
router.get("/:id", async (c) => {
  const id = c.req.param("id") as string;
  const problem = await resolveProblem(id);
  return c.json({ data: problem });
});

/**
 * 创建题目。
 * admin 可创建任意 type，普通用户仅限 U 型。
 * POST /api/v1/problems
 */
router.post("/", authMiddleware, async (c) => {
  const body = await parseJsonBody<CreateProblemInput>(c);

  if (!body.title || !body.judge_image || !body.judge_command) {
    throw new BadRequestError(
      "缺少必填字段：title, judge_image, judge_command",
    );
  }

  if (!body.description) {
    throw new BadRequestError("缺少必填字段：description");
  }

  const userId = c.get("userId");
  const userRole = c.get("userRole");
  const problem = await createProblem(body, userId, userRole);
  return c.json({ data: problem }, 201);
});

/**
 * 全量更新题目（双索引：UUID 或 display_id）。
 * 权限在服务层按 type+owner 判断。
 */
router.put("/:id", authMiddleware, async (c) => {
  const id = c.req.param("id") as string;
  const body = await parseJsonBody<UpdateProblemInput>(c);
  const userId = c.get("userId");
  const userRole = c.get("userRole");

  // 双索引解析获取实际题目 ID
  const problem = await resolveProblem(id);
  const updated = await updateProblem(problem.id, body, userId, userRole);
  return c.json({ data: updated });
});

/**
 * 删除题目（双索引：UUID 或 display_id）。
 * 权限在服务层按 type+owner 判断。
 */
router.delete("/:id", authMiddleware, async (c) => {
  const id = c.req.param("id") as string;
  const userId = c.get("userId");
  const userRole = c.get("userRole");

  // 双索引解析获取实际题目 ID
  const problem = await resolveProblem(id);
  await deleteProblem(problem.id, userId, userRole);
  return c.body(null, 204);
});

/**
 * 上传支持包。
 * POST /api/v1/problems/:id/support-package
 */
router.post("/:id/support-package", authMiddleware, async (c) => {
  const id = c.req.param("id") as string;
  const userId = c.get("userId");
  const userRole = c.get("userRole");

  // 双索引解析获取实际题目 ID，同时获取题目信息用于权限校验
  const problem = await resolveProblem(id);

  // 解析 multipart/form-data
  const body = await c.req.parseBody();
  const file = body["file"];

  if (!file || !(file instanceof File)) {
    throw new BadRequestError("请上传有效的 zip 文件");
  }

  if (!file.name.toLowerCase().endsWith(".zip")) {
    throw new BadRequestError("仅支持 .zip 格式文件");
  }

  if (file.size > MAX_SUPPORT_PACKAGE_SIZE) {
    throw new BadRequestError(
      `支持包大小超过限制（最大 ${
        (MAX_SUPPORT_PACKAGE_SIZE / 1024 / 1024).toFixed(0)
      }MB）`,
    );
  }

  const fileBytes = new Uint8Array(await file.arrayBuffer());

  // 验证 zip magic bytes（PK 头：0x50, 0x4B）
  if (fileBytes.length < 4 || fileBytes[0] !== 0x50 || fileBytes[1] !== 0x4B) {
    throw new BadRequestError("文件不是有效的 zip 格式");
  }

  const packagePath = await saveSupportPackage(
    problem.id,
    { name: file.name, data: fileBytes },
    userId,
    userRole,
    { type: problem.type, owner_id: problem.owner_id }, // 复用已获取的题目信息
  );

  return c.json({ data: { support_package_path: packagePath } });
});

/**
 * 删除支持包。
 * DELETE /api/v1/problems/:id/support-package
 */
router.delete("/:id/support-package", authMiddleware, async (c) => {
  const id = c.req.param("id") as string;
  const userId = c.get("userId");
  const userRole = c.get("userRole");

  // 双索引解析获取实际题目 ID，同时获取题目信息用于权限校验
  const problem = await resolveProblem(id);

  await deleteSupportPackage(problem.id, userId, userRole, {
    type: problem.type,
    owner_id: problem.owner_id,
  });

  return c.json({ data: { support_package_path: null } });
});

export default router;
