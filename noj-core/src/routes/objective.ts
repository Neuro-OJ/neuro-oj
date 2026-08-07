import { Hono } from "hono";
import { authMiddleware, optionalAuthMiddleware } from "../middleware/auth.ts";
import { parseJsonBody } from "../lib/request.ts";
import { BadRequestError } from "../lib/errors.ts";
import { parsePagination } from "../lib/pagination.ts";
import {
  assertObjectivePaper,
  createQuestion,
  deleteQuestion,
  getPaperOrThrow,
  isPaperOwnerOrAdmin,
  listPaperQuestions,
  updateQuestion,
} from "../services/objective-questions.ts";
import {
  getObjectiveSubmission,
  listObjectiveSubmissions,
  submitObjectivePaper,
} from "../services/objective-submissions.ts";
import type {
  CreateQuestionInput,
  SubmitObjectiveInput,
  UpdateQuestionInput,
} from "../types/objective.ts";

type Env = {
  Variables: {
    userId?: string;
    userRole?: string;
  };
};

const router = new Hono<Env>();

/**
 * 获取套卷小题列表。
 * GET /api/v1/objective/papers/:id/questions
 * 公开可读（与编程题详情一致）；owner/admin 视图含答案与解析，其余裁剪。
 */
router.get("/papers/:id/questions", optionalAuthMiddleware, async (c) => {
  const paperId = c.req.param("id") as string;
  const userId = c.var.userId;
  const userRole = c.var.userRole;

  const paper = await getPaperOrThrow(paperId);
  assertObjectivePaper(paper);
  // RBAC：owner（problem:write_any）或 admin 视图含答案，其余裁剪
  const includeAnswer = await isPaperOwnerOrAdmin(
    paper,
    userId,
    userRole,
    c,
  );
  const data = await listPaperQuestions(paperId, includeAnswer);
  return c.json({ data });
});

/**
 * 创建小题（绑定套卷）。
 * POST /api/v1/objective/papers/:id/questions
 */
router.post("/papers/:id/questions", authMiddleware, async (c) => {
  const paperId = c.req.param("id") as string;
  const userId = c.var.userId as string;
  const userRole = c.var.userRole;
  const body = await parseJsonBody<CreateQuestionInput>(c);

  const data = await createQuestion(paperId, body, userId, userRole, c);
  return c.json({ data }, 201);
});

/**
 * 更新小题。
 * PUT /api/v1/objective/questions/:qid
 */
router.put("/questions/:qid", authMiddleware, async (c) => {
  const qid = c.req.param("qid") as string;
  const userId = c.var.userId as string;
  const userRole = c.var.userRole;
  const body = await parseJsonBody<UpdateQuestionInput>(c);

  const data = await updateQuestion(qid, body, userId, userRole, c);
  return c.json({ data });
});

/**
 * 删除小题。
 * DELETE /api/v1/objective/questions/:qid
 */
router.delete("/questions/:qid", authMiddleware, async (c) => {
  const qid = c.req.param("qid") as string;
  const userId = c.var.userId as string;
  const userRole = c.var.userRole;

  await deleteQuestion(qid, userId, userRole, c);
  return c.body(null, 204);
});

/**
 * 提交套卷答案（即时判定）。
 * POST /api/v1/objective/papers/:id/submit
 * body: { answers: {question_id: [...]}, contest_id?: string }
 */
router.post("/papers/:id/submit", authMiddleware, async (c) => {
  const paperId = c.req.param("id") as string;
  const userId = c.var.userId as string;
  const body = await parseJsonBody<SubmitObjectiveInput>(c);

  if (!body.answers) {
    throw new BadRequestError("缺少必填字段：answers");
  }
  const result = await submitObjectivePaper(paperId, body, userId);
  return c.json({ data: result }, 201);
});

/**
 * 提交历史（本人；admin 可查他人）。
 * GET /api/v1/objective/submissions?paper_id=&contest_id=&user_id=&page=&per_page=
 */
router.get("/submissions", authMiddleware, async (c) => {
  const userId = c.var.userId as string;
  const userRole = c.var.userRole;
  const { page, perPage } = parsePagination(c, {
    defaultPerPage: 20,
    maxPerPage: 100,
  });

  const result = await listObjectiveSubmissions({
    viewerId: userId,
    viewerRole: userRole,
    c,
    paperId: c.req.query("paper_id") || undefined,
    contestId: c.req.query("contest_id") || undefined,
    targetUserId: c.req.query("user_id") || undefined,
    page,
    perPage,
  });
  return c.json({ data: result });
});

/**
 * 单次提交详情。
 * GET /api/v1/objective/submissions/:id
 * 仅提交者本人或 admin 可读；竞赛模式不展示解析。
 */
router.get("/submissions/:id", authMiddleware, async (c) => {
  const id = c.req.param("id") as string;
  const userId = c.var.userId as string;
  const userRole = c.var.userRole;

  const data = await getObjectiveSubmission(id, userId, userRole, c);
  return c.json({ data });
});

export default router;
