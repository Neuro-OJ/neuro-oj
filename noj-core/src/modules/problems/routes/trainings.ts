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
import {
  assertObjectBody,
  parseJsonBody,
} from "../../../shared/http/request.ts";
import { parsePagination } from "../../../shared/http/pagination.ts";

import { BadRequestError } from "../../../shared/base/errors.ts";
import { userActorFromAuthenticatedId } from "../../access/contracts/actor.ts";
import {
  addTrainingProblemCommand,
  createTrainingCommand,
  deleteTrainingCommand,
  removeTrainingProblemCommand,
  reorderTrainingProblemsCommand,
  updateTrainingCommand,
} from "../../application/problems.ts";
import {
  getTraining,
  listMyTrainings,
  listPublicTrainings,
  listTrainingProblems,
  listTrainingsContainingProblem,
  listUserTrainings,
  resolveTrainingId,
} from "../services/trainings.ts";
import type {
  CreateTrainingInput,
  UpdateTrainingInput,
} from "../types/trainings.ts";

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
 * 创建题单。
 * POST /api/v1/trainings
 * 需登录 + training:create；body: { title, description?, visibility? }。
 * 响应 201 返回新建题单。
 */
router.post("/", authMiddleware, async (c) => {
  const body = await parseJsonBody<CreateTrainingInput>(c);
  assertObjectBody(body as unknown);
  const training = await createTrainingCommand(
    userActorFromAuthenticatedId(c.get("userId")),
    body,
  );
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
  const training = await getTraining(
    id,
    viewerId,
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
  const body = await parseJsonBody<UpdateTrainingInput>(c);
  assertObjectBody(body as unknown);
  const updated = await updateTrainingCommand(
    userActorFromAuthenticatedId(actorId),
    id,
    body,
  );
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
  await deleteTrainingCommand(userActorFromAuthenticatedId(actorId), id);
  return c.body(null, 204);
});

/** 题单中的题目只读取 main 的当前授权作答版本。 */
router.get("/:id/problems", optionalAuthMiddleware, async (c) => {
  const id = await resolveTrainingId(c.req.param("id") as string);
  return c.json({ data: await listTrainingProblems(id, c.get("userId")) });
});

/** 将当前可访问的默认域题目加入题单。 */
router.post("/:id/problems", authMiddleware, async (c) => {
  const id = await resolveTrainingId(c.req.param("id") as string);
  const actorId = c.get("userId");
  const body = await parseJsonBody<{ problem_id: string; position?: number }>(
    c,
  );
  assertObjectBody(body as unknown);
  if (!body.problem_id) throw new BadRequestError("缺少 problem_id");
  const data = await addTrainingProblemCommand(
    userActorFromAuthenticatedId(actorId),
    id,
    body.problem_id,
    body.position,
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
  const body = await parseJsonBody<{
    problems: { problem_id: string; position: number }[];
  }>(c);
  assertObjectBody(body as unknown);
  if (!Array.isArray(body.problems)) {
    throw new BadRequestError("problems 必须是数组");
  }
  const data = await reorderTrainingProblemsCommand(
    userActorFromAuthenticatedId(actorId),
    id,
    body.problems,
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
  await removeTrainingProblemCommand(
    userActorFromAuthenticatedId(actorId),
    id,
    problemId,
  );
  return c.body(null, 204);
});

export default router;
