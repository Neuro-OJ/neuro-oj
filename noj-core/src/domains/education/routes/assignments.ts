import { Hono } from "hono";
import { type AuthEnv, authMiddleware } from "../../identity/index.ts";
import { BadRequestError } from "../../../shared/base/errors.ts";
import {
  assertObjectBody,
  parseJsonBody,
} from "../../../shared/http/request.ts";
import { parsePagination } from "../../../shared/http/pagination.ts";
import {
  type AssignmentDraftInput,
  createAssignment,
  getAssignment,
  listAssignments,
  updateAssignment,
} from "../services/assignments.ts";
import {
  changeAssignmentLifecycle,
  publishAssignment,
  scheduleAssignment,
} from "../services/assignment-lifecycle.ts";

const router = new Hono<AuthEnv>();
router.use("/domains/:slug/assignments/*", authMiddleware, async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});

function revision(value: string | undefined) {
  if (!value) return null;
  const match = /^"?([0-9]+)"?$/.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[1]))) {
    throw new BadRequestError("If-Match 必须是作业 revision");
  }
  return Number(match[1]);
}

router.get("/domains/:slug/classrooms/:id/assignments", async (c) => {
  const { page } = parsePagination(c, { defaultPerPage: 50, maxPerPage: 50 });
  return c.json({
    data: await listAssignments(
      c.req.param("slug"),
      c.req.param("id"),
      c.var.userId,
      page,
    ),
    page,
    per_page: 50,
  });
});
router.post("/domains/:slug/classrooms/:id/assignments", async (c) => {
  const input = await parseJsonBody<AssignmentDraftInput>(c);
  assertObjectBody(input);
  return c.json({
    data: await createAssignment(
      c.req.param("slug"),
      c.req.param("id"),
      c.var.userId,
      input,
    ),
  }, 201);
});
router.get("/domains/:slug/assignments/:id", async (c) =>
  c.json({
    data: await getAssignment(
      c.req.param("slug"),
      c.req.param("id"),
      c.var.userId,
    ),
  }));
router.patch("/domains/:slug/assignments/:id", async (c) => {
  const input = await parseJsonBody<AssignmentDraftInput>(c);
  assertObjectBody(input);
  return c.json({
    data: await updateAssignment(
      c.req.param("slug"),
      c.req.param("id"),
      c.var.userId,
      revision(c.req.header("If-Match")),
      input,
    ),
  });
});
router.post("/domains/:slug/assignments/:id/publish", async (c) =>
  c.json({
    data: await publishAssignment(
      c.req.param("slug"),
      c.req.param("id"),
      c.var.userId,
      revision(c.req.header("If-Match")),
      c.req.header("Idempotency-Key") ?? "",
    ),
  }));
router.post("/domains/:slug/assignments/:id/schedule", async (c) => {
  const input = await parseJsonBody<{ publish_at: string }>(c);
  assertObjectBody(input);
  return c.json({
    data: await scheduleAssignment(
      c.req.param("slug"),
      c.req.param("id"),
      c.var.userId,
      revision(c.req.header("If-Match")),
      input.publish_at,
    ),
  });
});
for (const action of ["extend", "end", "archive"] as const) {
  router.post(`/domains/:slug/assignments/:id/${action}`, async (c) => {
    const input = await parseJsonBody<
      { reason: string; deadline_at?: string | null }
    >(c);
    assertObjectBody(input);
    return c.json({
      data: await changeAssignmentLifecycle(
        c.req.param("slug"),
        c.req.param("id"),
        c.var.userId,
        revision(c.req.header("If-Match")),
        { action, reason: input.reason, deadline_at: input.deadline_at },
      ),
    });
  });
}

/** 作业准备路由，与班级路由一起等待完整隔离门禁后开放。 */
export const assignmentRouter = router;
