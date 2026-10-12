import { Hono } from "hono";
import type { AuthEnv } from "../../identity/index.ts";
import { parsePagination } from "../../../shared/http/pagination.ts";
import {
  getClassroomStudentSubmission,
  listClassroomStudentSubmissions,
  type TeachingSubmissionKind,
} from "../services/student-submissions.ts";

/** 教学提交准备路由，认证及禁止缓存沿用班级父路由。 */
export const studentSubmissionsRouter = new Hono<AuthEnv>();
studentSubmissionsRouter.get(
  "/domains/:slug/classrooms/:id/students/:userId/submissions",
  async (c) => {
    const { page } = parsePagination(c, { defaultPerPage: 50, maxPerPage: 50 });
    return c.json({
      data: await listClassroomStudentSubmissions(
        c.req.param("slug"),
        c.req.param("id"),
        c.req.param("userId"),
        c.var.userId,
        {
          page,
          kind: c.req.query("kind") as TeachingSubmissionKind | undefined,
        },
      ),
    });
  },
);
studentSubmissionsRouter.get(
  "/domains/:slug/classrooms/:id/submissions/:kind/:submissionId",
  async (c) =>
    c.json({
      data: await getClassroomStudentSubmission(
        c.req.param("slug"),
        c.req.param("id"),
        c.req.param("submissionId"),
        c.req.param("kind") as TeachingSubmissionKind,
        c.var.userId,
      ),
    }),
);
