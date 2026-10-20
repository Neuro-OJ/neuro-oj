import { Hono } from "hono";
import { NotFoundError } from "../../../shared/base/errors.ts";
import {
  ADMIN_FULL_ACCESS,
  type AuthEnv,
  authMiddleware,
  resolvePermissions,
} from "../../../domains/identity/index.ts";
import { resolveProblem } from "../services/problem-resolve.ts";
import { evaluateProblemAccessWithContestId } from "../services/problem-access-check.ts";
import { resolveProblemAnswerVersion } from "../services/versioning/publish.ts";
import { resolveProblemUiHtml } from "../services/support-package.ts";

const router = new Hono<AuthEnv>();

/**
 * 获取界面题的 `ui.html`（做题页在沙箱 iframe 中渲染）。
 * GET /api/v1/problems/:id/ui
 *
 * 访问口径与 `/template` 一致（题目可见性 + 竞赛上下文）；界面必须与作答版本一致：
 * 显式 `?version_id=` 优先，否则取默认作答版本，绝不无条件取最新版。
 * 非界面题一律 404。
 */
router.get("/:id/ui", authMiddleware, async (c) => {
  const id = c.req.param("id") as string;
  const userId = c.get("userId") as string;
  const isAdmin = (await resolvePermissions(c)).has(ADMIN_FULL_ACCESS);
  const problem = await resolveProblem(id);
  const { result } = await evaluateProblemAccessWithContestId(problem, {
    viewerId: userId,
    isAdmin,
    contestId: c.req.query("contest_id"),
  });
  if (!result.allowed || problem.submission_mode !== "ui") {
    throw new NotFoundError("题目不存在");
  }
  const versionId = c.req.query("version_id")?.trim() ||
    (await resolveProblemAnswerVersion(problem.id))?.version_id || null;
  const html = await resolveProblemUiHtml(problem.id, { versionId });
  if (html === null) {
    return c.json({ error: "该题目没有界面文件" }, 404);
  }
  return c.json({ data: { html } });
});

export default router;
