/**
 * 提交路由
 *
 * 提供提交相关 API：
 * - POST /api/v1/submissions — 接收代码提交
 * - GET /api/v1/submissions/:id — 查询提交状态
 */

import { Hono } from "hono";
import * as submissions from "../services/submissions.ts";
import * as problems from "../services/problems.ts";
import type { CreateSubmissionInput } from "../types/submissions.ts";

const router = new Hono();

/**
 * POST /api/v1/submissions — 接收代码提交
 */
router.post("/", async (c) => {
  const body = await c.req.json<CreateSubmissionInput>();

  if (!body.problem_id) {
    return c.json({ error: "problem_id is required" }, 400);
  }
  if (!body.language) {
    return c.json({ error: "language is required" }, 400);
  }
  if (!body.code) {
    return c.json({ error: "code is required" }, 400);
  }

  const problem = problems.getProblem(body.problem_id);
  if (!problem) {
    return c.json({ error: "Problem not found" }, 404);
  }

  const supportedLanguages = ["python3", "javascript", "cpp", "java", "go", "rust"];
  if (!supportedLanguages.includes(body.language)) {
    return c.json({ error: "Unsupported language" }, 400);
  }

  const userId = "anonymous";
  const submission = submissions.createSubmission(userId, body);

  return c.json(
    {
      data: {
        id: submission.id,
        status: submission.status,
        created_at: submission.created_at,
      },
    },
    201
  );
});

/**
 * GET /api/v1/submissions/:id — 查询提交状态
 */
router.get("/:id", (c) => {
  const id = c.req.param("id");
  const userId = "anonymous";

  const submission = submissions.getSubmission(id, userId);

  if (!submission) {
    return c.json({ error: "Submission not found" }, 404);
  }

  return c.json({ data: submission });
});

/**
 * GET /api/v1/submissions — 提交列表
 */
router.get("/", (c) => {
  const userId = "anonymous";
  const list = submissions.listSubmissions(userId);
  return c.json({ data: list });
});

export default router;