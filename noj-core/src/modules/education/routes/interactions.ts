import { Hono } from "hono";
import { educationWriteRateLimit } from "./write-rate-limit.ts";
import { authMiddleware } from "../../access/identity/middleware/auth.ts";
import { type AuthEnv } from "../../../shared/http/hono-env.ts";
import { BadRequestError } from "../../../shared/base/errors.ts";
import {
  assertObjectBody,
  parseJsonBody,
} from "../../../shared/http/request.ts";
import { parsePagination } from "../../../shared/http/pagination.ts";
import {
  createAssignmentFeedback,
  getAssignmentFeedback,
  listAssignmentFeedback,
  updateAssignmentFeedback,
} from "../services/feedback.ts";
import {
  type AssignmentHelpInput,
  createAssignmentHelp,
  getAssignmentHelp,
  listAssignmentHelp,
  replyAssignmentHelp,
  setAssignmentHelpState,
} from "../services/help.ts";
import {
  listEducationNotifications,
  markEducationNotificationRead,
} from "../services/notifications.ts";
import { educationNotificationSse } from "./notification-sse.ts";

/** 教学互动准备路由，复用当前域授权、禁用缓存和统一错误处理。 */
export const interactionRouter = new Hono<AuthEnv>();
interactionRouter.route("/", educationNotificationSse);
interactionRouter.use(
  "/domains/:slug/assignments/*",
  authMiddleware,
  async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  },
);
for (
  const path of [
    "/domains/:slug/notifications",
    "/domains/:slug/notifications/*",
  ]
) {
  interactionRouter.use(path, authMiddleware, async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
}
function revision(value: string | undefined) {
  if (value === undefined) return null;
  const match = /^"?([0-9]+)"?$/.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[1]))) {
    throw new BadRequestError("If-Match 必须是互动记录 revision");
  }
  return Number(match[1]);
}
interactionRouter.get(
  "/domains/:slug/assignments/:id/feedback",
  async (c) =>
    c.json({
      data: await listAssignmentFeedback(
        c.req.param("slug"),
        c.req.param("id"),
        c.var.userId,
        parsePagination(c, { defaultPerPage: 50, maxPerPage: 50 }).page,
      ),
    }),
);
interactionRouter.get(
  "/domains/:slug/assignments/:id/feedback/:feedbackId",
  async (c) =>
    c.json({
      data: await getAssignmentFeedback(
        c.req.param("slug"),
        c.req.param("id"),
        c.req.param("feedbackId"),
        c.var.userId,
      ),
    }),
);
interactionRouter.post(
  "/domains/:slug/assignments/:id/feedback",
  educationWriteRateLimit,
  async (c) => {
    const input = await parseJsonBody<
      { body: string; target_user_id?: string | null }
    >(c);
    assertObjectBody(input);
    return c.json({
      data: await createAssignmentFeedback(
        c.req.param("slug"),
        c.req.param("id"),
        c.var.userId,
        c.req.header("Idempotency-Key") ?? "",
        input,
      ),
    }, 201);
  },
);
interactionRouter.patch(
  "/domains/:slug/assignments/:id/feedback/:feedbackId",
  educationWriteRateLimit,
  async (c) => {
    const input = await parseJsonBody<{ body: string }>(c);
    assertObjectBody(input);
    return c.json({
      data: await updateAssignmentFeedback(
        c.req.param("slug"),
        c.req.param("id"),
        c.req.param("feedbackId"),
        c.var.userId,
        revision(c.req.header("If-Match")),
        { body: input.body },
      ),
    });
  },
);
interactionRouter.delete(
  "/domains/:slug/assignments/:id/feedback/:feedbackId",
  educationWriteRateLimit,
  async (c) =>
    c.json({
      data: await updateAssignmentFeedback(
        c.req.param("slug"),
        c.req.param("id"),
        c.req.param("feedbackId"),
        c.var.userId,
        revision(c.req.header("If-Match")),
        { withdraw: true },
      ),
    }),
);
interactionRouter.get(
  "/domains/:slug/assignments/:id/help-requests",
  async (c) =>
    c.json({
      data: await listAssignmentHelp(
        c.req.param("slug"),
        c.req.param("id"),
        c.var.userId,
        {
          page: parsePagination(c, { defaultPerPage: 50, maxPerPage: 50 }).page,
          state: c.req.query("state") as "open" | "resolved" | undefined,
        },
      ),
    }),
);
interactionRouter.post(
  "/domains/:slug/assignments/:id/help-requests",
  educationWriteRateLimit,
  async (c) => {
    const input = await parseJsonBody<AssignmentHelpInput>(c);
    assertObjectBody(input);
    return c.json({
      data: await createAssignmentHelp(
        c.req.param("slug"),
        c.req.param("id"),
        c.var.userId,
        c.req.header("Idempotency-Key") ?? "",
        input,
      ),
    }, 201);
  },
);
interactionRouter.get(
  "/domains/:slug/assignments/:id/help-requests/:helpId",
  async (c) =>
    c.json({
      data: await getAssignmentHelp(
        c.req.param("slug"),
        c.req.param("id"),
        c.req.param("helpId"),
        c.var.userId,
        parsePagination(c, { defaultPerPage: 50, maxPerPage: 50 }).page,
      ),
    }),
);
interactionRouter.post(
  "/domains/:slug/assignments/:id/help-requests/:helpId/replies",
  educationWriteRateLimit,
  async (c) => {
    const input = await parseJsonBody<{ body: string; resolve?: boolean }>(c);
    assertObjectBody(input);
    return c.json({
      data: await replyAssignmentHelp(
        c.req.param("slug"),
        c.req.param("id"),
        c.req.param("helpId"),
        c.var.userId,
        c.req.header("Idempotency-Key") ?? "",
        input,
      ),
    }, 201);
  },
);
interactionRouter.patch(
  "/domains/:slug/assignments/:id/help-requests/:helpId",
  educationWriteRateLimit,
  async (c) => {
    const input = await parseJsonBody<{ state: "open" | "resolved" }>(c);
    assertObjectBody(input);
    return c.json({
      data: await setAssignmentHelpState(
        c.req.param("slug"),
        c.req.param("id"),
        c.req.param("helpId"),
        c.var.userId,
        revision(c.req.header("If-Match")),
        input.state,
      ),
    });
  },
);
interactionRouter.get(
  "/domains/:slug/notifications",
  async (c) =>
    c.json({
      data: await listEducationNotifications(
        c.req.param("slug"),
        c.var.userId,
        parsePagination(c, { defaultPerPage: 50, maxPerPage: 50 }).page,
      ),
    }),
);
interactionRouter.post(
  "/domains/:slug/notifications/:id/read",
  educationWriteRateLimit,
  async (c) =>
    c.json({
      data: await markEducationNotificationRead(
        c.req.param("slug"),
        c.req.param("id"),
        c.var.userId,
      ),
    }),
);
