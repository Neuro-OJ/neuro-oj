import { Hono } from "hono";
import type { AuthEnv } from "../../../middleware/auth.ts";
import { parseJsonBody } from "./../../../shared/http/request.ts";
import { BadRequestError } from "./../../../shared/base/errors.ts";
import {
  buildPaginationMeta,
  parsePagination,
} from "./../../../shared/http/pagination.ts";
import {
  addParticipants,
  createContest,
  deleteContest,
  getContest,
  getContestProblems,
  listContests,
  listParticipants,
  removeParticipant,
  resolveContestId,
  updateContest,
} from "../services/contests.ts";
import type {
  CreateContestInput,
  UpdateContestInput,
} from "../../../types/contests.ts";
import { isValidContestType } from "../../../types/contests.ts";
import { listSubmissions } from "../../submission/index.ts";
import { resolveUserId } from "../../identity/index.ts";

/**
 * 管理端竞赛管理路由（挂载前缀 /api/v1/admin，见 admin/index.ts）。
 *
 * 提供：
 * - GET/POST /contests                    竞赛列表 / 创建
 * - GET/PUT/DELETE /contests/:id          竞赛详情 / 更新 / 删除
 * - GET/POST /contests/:id/participants   参与者列表 / 批量添加
 * - DELETE /contests/:id/participants/:userId  移除参与者
 * - GET /contests/:id/submissions         竞赛提交列表
 */
const router = new Hono<AuthEnv>();

/**
 * GET /contests —— 竞赛列表（管理端，含非公开竞赛）。
 * 权限：管理员。query：page、perPage、type。响应：{ data, pagination }。
 */
router.get("/contests", async (c) => {
  const { page, perPage } = parsePagination(c);
  const typeQuery = c.req.query("type");
  if (typeQuery && !isValidContestType(typeQuery)) {
    throw new BadRequestError("竞赛类型不合法");
  }
  const type = typeQuery && isValidContestType(typeQuery)
    ? typeQuery
    : undefined;
  const result = await listContests({ page, perPage, type, showAll: true });
  return c.json({
    data: result.data,
    pagination: buildPaginationMeta(page, perPage, result.total),
  });
});

/**
 * GET /contests/:id —— 竞赛详情（含题目列表）。
 * 权限：管理员。path：id。响应：{ data: { ...contest, problems } }。
 */
router.get("/contests/:id", async (c) => {
  const contestId = await resolveContestId(c.req.param("id") as string);
  const [contest, problems] = await Promise.all([
    getContest(contestId),
    getContestProblems(contestId),
  ]);
  return c.json({ data: { ...contest, problems } });
});

/**
 * POST /contests —— 创建竞赛。
 * 权限：管理员。body：CreateContestInput。响应：201 { data }。
 */
router.post("/contests", async (c) => {
  const body = await parseJsonBody<CreateContestInput>(c);
  const data = await createContest(body, c.get("userId"));
  return c.json({ data }, 201);
});

/**
 * PUT /contests/:id —— 更新竞赛。
 * 权限：管理员。path：id。body：UpdateContestInput。响应：{ data }。
 */
router.put("/contests/:id", async (c) => {
  const contestId = await resolveContestId(c.req.param("id") as string);
  const body = await parseJsonBody<UpdateContestInput>(c);
  const data = await updateContest(
    contestId,
    body,
  );
  return c.json({ data });
});

/**
 * DELETE /contests/:id —— 删除竞赛。
 * 权限：管理员。path：id。响应：204 无内容。
 */
router.delete("/contests/:id", async (c) => {
  const contestId = await resolveContestId(c.req.param("id") as string);
  await deleteContest(contestId);
  return c.body(null, 204);
});

/**
 * GET /contests/:id/participants —— 竞赛参与者列表。
 * 权限：管理员。path：id。响应：{ data }。
 */
router.get("/contests/:id/participants", async (c) => {
  const contestId = await resolveContestId(c.req.param("id") as string);
  const data = await listParticipants(contestId);
  return c.json({ data });
});

/**
 * POST /contests/:id/participants —— 批量添加参与者。
 * 权限：管理员。path：id。body：用户 ID 数组。响应：201 { data: { added } }。
 */
router.post("/contests/:id/participants", async (c) => {
  const contestId = await resolveContestId(c.req.param("id") as string);
  const userIds = await parseJsonBody<string[]>(c);
  if (!Array.isArray(userIds)) {
    throw new BadRequestError("请求体必须为用户 ID 数组");
  }
  const resolvedIds = await Promise.all(userIds.map((v) => resolveUserId(v)));
  const added = await addParticipants(contestId, resolvedIds);
  return c.json({ data: { added } }, 201);
});

/**
 * DELETE /contests/:id/participants/:userId —— 移除某位参与者。
 * 权限：管理员。path：id、userId。响应：204 无内容。
 */
router.delete("/contests/:id/participants/:userId", async (c) => {
  const contestId = await resolveContestId(c.req.param("id") as string);
  const targetUserId = await resolveUserId(c.req.param("userId") as string);
  await removeParticipant(
    contestId,
    targetUserId,
  );
  return c.body(null, 204);
});

/**
 * GET /contests/:id/submissions —— 竞赛提交列表。
 * 权限：管理员。path：id。query：page、perPage。响应：{ data, pagination }。
 */
router.get("/contests/:id/submissions", async (c) => {
  const contestId = await resolveContestId(c.req.param("id") as string);
  await getContest(contestId);
  const { page, perPage } = parsePagination(c);
  const result = await listSubmissions({ contestId, page, perPage });
  return c.json({
    data: result.data,
    pagination: buildPaginationMeta(page, perPage, result.total),
  });
});

export default router;
