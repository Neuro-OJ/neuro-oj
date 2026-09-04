/**
 * 题单（training）用户侧路由（issue #224）。
 *
 * 挂载前缀：/api/v1/trainings
 * 包含：公开列表、用户主页题单列表、我的题单、题单 CRUD、题目管理。
 */

import { Hono } from "hono";
import {
  type AuthEnv,
  authMiddleware,
  optionalAuthMiddleware,
} from "./../../identity/index.ts";
import {
  assertObjectBody,
  parseJsonBody,
} from "./../../../shared/http/request.ts";
import { parsePagination } from "./../../../shared/http/pagination.ts";
import { assertPermission, checkPermission } from "./../../identity/index.ts";
import { BadRequestError } from "./../../../shared/base/errors.ts";
import {
  addTrainingProblem,
  createTraining,
  deleteTraining,
  getTraining,
  listMyTrainings,
  listPublicTrainings,
  listTrainingProblems,
  listTrainingsContainingProblem,
  listUserTrainings,
  removeTrainingProblem,
  reorderTrainingProblems,
  resolveTrainingId,
  updateTraining,
} from "../services/trainings.ts";
import type {
  CreateTrainingInput,
  UpdateTrainingInput,
} from "./../types/trainings.ts";

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
    const isAdmin = viewerId
      ? await checkPermission(c, "training:read_any")
      : false;
    const result = await listUserTrainings(createdBy, viewerId, isAdmin, {
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
  const result = await listPublicTrainings({ page, perPage });
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
 * 创建题单。
 * POST /api/v1/trainings
 * 需登录 + training:create；body: { title, description?, visibility? }。
 * 响应 201 返回新建题单。
 */
router.post("/", authMiddleware, async (c) => {
  await assertPermission(c, "training:create");
  const body = await parseJsonBody<CreateTrainingInput>(c);
  assertObjectBody(body as unknown);
  const training = await createTraining(body, c.get("userId"));
  return c.json({ data: training }, 201);
});

/**
 * 题单详情。
 * GET /api/v1/trainings/:id
 * 可选认证；private 题单仅 owner/admin 可见。
 */
router.get("/:id", optionalAuthMiddleware, async (c) => {
  const id = await resolveTrainingId(c.req.param("id") as string);
  const viewerId = c.get("userId") as string | undefined;
  const isAdmin = viewerId
    ? await checkPermission(c, "training:read_any")
    : false;
  const training = await getTraining(
    id,
    viewerId,
    isAdmin,
  );
  return c.json({ data: training });
});

/**
 * 全量更新题单。
 * PUT /api/v1/trainings/:id
 * 需登录；owner 需 training:write_own，他人需 training:write_any；
 * 设为 public 需 training:publish，置顶需 training:pin。
 * body: { title?, description?, visibility?, is_pinned? }。
 */
router.put("/:id", authMiddleware, async (c) => {
  const id = await resolveTrainingId(c.req.param("id") as string);
  const actorId = c.get("userId");
  const isAdmin = await checkPermission(c, "training:write_any");
  const training = await getTraining(id, actorId, isAdmin);
  const isOwner = training.created_by === actorId;
  await assertPermission(
    c,
    isOwner ? "training:write_own" : "training:write_any",
  );

  const body = await parseJsonBody<UpdateTrainingInput>(c);
  assertObjectBody(body as unknown);
  const canPublish = await checkPermission(c, "training:publish");
  const canPin = await checkPermission(c, "training:pin");
  if (body.visibility === "public") {
    await assertPermission(c, "training:publish");
  }
  if (body.is_pinned !== undefined) {
    await assertPermission(c, "training:pin");
  }
  const updated = await updateTraining(id, body, actorId, {
    isAdmin,
    canPublish,
    canPin,
  });
  return c.json({ data: updated });
});

/**
 * 删除题单。
 * DELETE /api/v1/trainings/:id
 * 需登录；owner 需 training:delete_own，他人需 training:delete_any。
 * 响应 204。
 */
router.delete("/:id", authMiddleware, async (c) => {
  const id = await resolveTrainingId(c.req.param("id") as string);
  const actorId = c.get("userId");
  const isAdmin = await checkPermission(c, "training:delete_any");
  const training = await getTraining(id, actorId, isAdmin);
  const isOwner = training.created_by === actorId;
  await assertPermission(
    c,
    isOwner ? "training:delete_own" : "training:delete_any",
  );
  await deleteTraining(id, actorId, isAdmin);
  return c.body(null, 204);
});

/**
 * 题单内题目列表（含 AC 状态）。
 * GET /api/v1/trainings/:id/problems
 * 可选认证；private 题单仅 owner/admin 可见。
 */
router.get("/:id/problems", optionalAuthMiddleware, async (c) => {
  const id = await resolveTrainingId(c.req.param("id") as string);
  const viewerId = c.get("userId") as string | undefined;
  const isAdmin = viewerId
    ? await checkPermission(c, "training:read_any")
    : false;
  const data = await listTrainingProblems(
    id,
    viewerId,
    isAdmin,
  );
  return c.json({ data });
});

/**
 * 向题单添加题目。
 * POST /api/v1/trainings/:id/problems
 * 需登录；owner 需 training:write_own，他人需 training:write_any。
 * body: { problem_id, position? }；响应 201 返回新增题目。
 */
router.post("/:id/problems", authMiddleware, async (c) => {
  const id = await resolveTrainingId(c.req.param("id") as string);
  const actorId = c.get("userId");
  const isAdmin = await checkPermission(c, "training:write_any");
  const training = await getTraining(id, actorId, isAdmin);
  await assertPermission(
    c,
    training.created_by === actorId
      ? "training:write_own"
      : "training:write_any",
  );
  const body = await parseJsonBody<{ problem_id: string; position?: number }>(
    c,
  );
  assertObjectBody(body as unknown);
  if (!body.problem_id) throw new BadRequestError("缺少 problem_id");
  const data = await addTrainingProblem(
    id,
    body.problem_id,
    body.position,
    actorId,
    isAdmin,
  );
  return c.json({ data }, 201);
});

/**
 * 重排题单内题目顺序。
 * PUT /api/v1/trainings/:id/problems
 * 需登录；owner 需 training:write_own，他人需 training:write_any。
 * body: { problems: [{ problem_id, position }] }。
 */
router.put("/:id/problems", authMiddleware, async (c) => {
  const id = await resolveTrainingId(c.req.param("id") as string);
  const actorId = c.get("userId");
  const isAdmin = await checkPermission(c, "training:write_any");
  const training = await getTraining(id, actorId, isAdmin);
  await assertPermission(
    c,
    training.created_by === actorId
      ? "training:write_own"
      : "training:write_any",
  );
  const body = await parseJsonBody<{
    problems: { problem_id: string; position: number }[];
  }>(c);
  assertObjectBody(body as unknown);
  if (!Array.isArray(body.problems)) {
    throw new BadRequestError("problems 必须是数组");
  }
  const data = await reorderTrainingProblems(
    id,
    body.problems,
    actorId,
    isAdmin,
  );
  return c.json({ data });
});

/**
 * 从题单移除指定题目。
 * DELETE /api/v1/trainings/:id/problems/:problemId
 * 需登录；owner 需 training:write_own，他人需 training:write_any。
 * 响应 204。
 */
router.delete("/:id/problems/:problemId", authMiddleware, async (c) => {
  const id = await resolveTrainingId(c.req.param("id") as string);
  const problemId = c.req.param("problemId") as string;
  const actorId = c.get("userId");
  const isAdmin = await checkPermission(c, "training:write_any");
  const training = await getTraining(id, actorId, isAdmin);
  await assertPermission(
    c,
    training.created_by === actorId
      ? "training:write_own"
      : "training:write_any",
  );
  await removeTrainingProblem(id, problemId, actorId, isAdmin);
  return c.body(null, 204);
});

export default router;
