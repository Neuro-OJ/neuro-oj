/**
 * 题单（training）用户侧路由（issue #224）。
 *
 * 挂载前缀：/api/v1/trainings
 * 包含：公开列表、用户主页题单列表、我的题单、题单 CRUD、题目管理。
 */

import { Hono } from "hono";
import {
  authMiddleware,
  optionalAuthMiddleware,
} from "../../access/identity/middleware/auth.ts";
import { type AuthEnv } from "../../../shared/http/hono-env.ts";
import { parsePagination } from "../../../shared/http/pagination.ts";

import { BadRequestError } from "../../../shared/base/errors.ts";
import {
  getTraining,
  listMyTrainings,
  listPublicTrainings,
  listTrainingProblems,
  listTrainingsContainingProblem,
  listUserTrainings,
  resolveTrainingId,
} from "../services/trainings.ts";

const router = new Hono<AuthEnv>();

/**
 * 题单列表（公开或按创建者查询）。
 * GET /api/v1/trainings?page=&per_page=&created_by=
 * 可选认证；created_by 指定时非 owner/admin 仅返回 public 题单。
 */
router.get("/", optionalAuthMiddleware, async (c) => {
  const { page, perPage } = parsePagination(c);
  const createdBy = c.req.query("created_by");
  if (createdBy) {
    const viewerId = c.get("userId") as string | undefined;
    const result = await listUserTrainings(createdBy, viewerId, false, {
      page,
      perPage,
    });
    return c.json({
      data: result.data,
      total: result.total,
      page,
      per_page: perPage,
    });
  }
  const result = await listPublicTrainings(
    { page, perPage },
    c.get("userId") ?? null,
  );
  return c.json({
    data: result.data,
    total: result.total,
    page,
    per_page: perPage,
  });
});

/**
 * 我的题单列表（含 private）。
 * GET /api/v1/trainings/mine?page=&per_page=
 * 需登录。
 */
router.get("/mine", authMiddleware, async (c) => {
  const { page, perPage } = parsePagination(c);
  const result = await listMyTrainings(c.get("userId"), { page, perPage });
  return c.json({
    data: result.data,
    total: result.total,
    page,
    per_page: perPage,
  });
});

/**
 * 查询当前用户创建的、包含指定题目的题单 id 列表。
 * 用于题目页「加入题单」弹窗预勾选。
 */
router.get("/containing", authMiddleware, async (c) => {
  const problemId = c.req.query("problem_id");
  if (!problemId) {
    throw new BadRequestError("缺少参数：problem_id");
  }
  const ids = await listTrainingsContainingProblem(
    c.get("userId"),
    problemId,
  );
  return c.json({ data: ids });
});

/**
 * 题单详情。
 * GET /api/v1/trainings/:id
 * 可选认证；private 题单仅 owner/admin 可见。
 */
router.get("/:id", optionalAuthMiddleware, async (c) => {
  const id = await resolveTrainingId(c.req.param("id") as string);
  const viewerId = c.get("userId") as string | undefined;
  const training = await getTraining(
    id,
    viewerId,
  );
  return c.json({ data: training });
});

/** 题单中的题目只读取 main 的当前授权作答版本。 */
router.get("/:id/problems", optionalAuthMiddleware, async (c) => {
  const id = await resolveTrainingId(c.req.param("id") as string);
  return c.json({ data: await listTrainingProblems(id, c.get("userId")) });
});

export default router;
