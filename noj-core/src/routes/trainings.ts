/**
 * 题单（training）用户侧路由（issue #224）。
 *
 * 挂载前缀：/api/v1/trainings
 * 包含：公开列表、用户主页题单列表、我的题单、题单 CRUD、题目管理。
 */

import { Hono } from "hono";
import { authMiddleware, optionalAuthMiddleware } from "../middleware/auth.ts";
import { parseJsonBody } from "../lib/request.ts";
import { parsePagination } from "../lib/pagination.ts";
import { assertPermission, checkPermission } from "../lib/permissions.ts";
import { BadRequestError } from "../lib/errors.ts";
import {
  addTrainingProblem,
  createTraining,
  deleteTraining,
  getTraining,
  listMyTrainings,
  listPublicTrainings,
  listTrainingsContainingProblem,
  listTrainingProblems,
  listUserTrainings,
  removeTrainingProblem,
  reorderTrainingProblems,
  updateTraining,
} from "../services/trainings.ts";
import type {
  CreateTrainingInput,
  UpdateTrainingInput,
} from "../types/trainings.ts";

const router = new Hono<{ Variables: { userId: string; userRole: string } }>();

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertObjectBody(
  body: unknown,
): asserts body is Record<string, unknown> {
  if (!isObject(body)) {
    throw new BadRequestError("请求体必须为 JSON 对象");
  }
}

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

router.post("/", authMiddleware, async (c) => {
  await assertPermission(c, "training:create");
  const body = await parseJsonBody<CreateTrainingInput>(c);
  assertObjectBody(body as unknown);
  const training = await createTraining(body, c.get("userId"));
  return c.json({ data: training }, 201);
});

router.get("/:id", optionalAuthMiddleware, async (c) => {
  const viewerId = c.get("userId") as string | undefined;
  const isAdmin = viewerId
    ? await checkPermission(c, "training:read_any")
    : false;
  const training = await getTraining(
    c.req.param("id") as string,
    viewerId,
    isAdmin,
  );
  return c.json({ data: training });
});

router.put("/:id", authMiddleware, async (c) => {
  const id = c.req.param("id") as string;
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

router.delete("/:id", authMiddleware, async (c) => {
  const id = c.req.param("id") as string;
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

router.get("/:id/problems", optionalAuthMiddleware, async (c) => {
  const viewerId = c.get("userId") as string | undefined;
  const isAdmin = viewerId
    ? await checkPermission(c, "training:read_any")
    : false;
  const data = await listTrainingProblems(
    c.req.param("id") as string,
    viewerId,
    isAdmin,
  );
  return c.json({ data });
});

router.post("/:id/problems", authMiddleware, async (c) => {
  const id = c.req.param("id") as string;
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

router.put("/:id/problems", authMiddleware, async (c) => {
  const id = c.req.param("id") as string;
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

router.delete("/:id/problems/:problemId", authMiddleware, async (c) => {
  const id = c.req.param("id") as string;
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
