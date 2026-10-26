import { type Context, Hono } from "hono";
import { assignmentRouter } from "./assignments.ts";
import { studentSubmissionsRouter } from "./student-submissions.ts";
import { interactionRouter } from "./interactions.ts";
import { annotationRouter } from "./annotations.ts";
import { classroomEnrollmentRouter } from "./enrollment.ts";
import { educationWorkbenchRouter } from "./workbench.ts";
import { authMiddleware } from "../../access/identity/middleware/auth.ts";
import { type AuthEnv } from "../../../shared/http/hono-env.ts";
import {
  BadRequestError,
  UnauthorizedError,
} from "../../../shared/base/errors.ts";
import {
  assertObjectBody,
  parseJsonBody,
} from "../../../shared/http/request.ts";
import {
  buildPaginationMeta,
  parsePagination,
} from "../../../shared/http/pagination.ts";
import type {
  AssistantCapability,
  ClassroomRole,
} from "../../../shared/education-types.ts";
import {
  createClassroom,
  getClassroom,
  listClassrooms,
  updateClassroom,
} from "../services/classrooms.ts";
import {
  listClassroomMembers,
  removeClassroomMember,
  setClassroomMember,
  transferClassroom,
} from "../services/members.ts";
import { listClassroomInvitations } from "../services/invitations.ts";
import {
  createClassroomInvitationCommand,
  revokeClassroomInvitationCommand,
} from "../../application/access.ts";
import type { DomainInvitationInput } from "../../access/invitations.ts";
import {
  requireUserActor,
  type UserActor,
} from "../../access/contracts/actor.ts";

const router = new Hono<AuthEnv>();

/** authMiddleware 已注入验签后的 UserActor；HTTP body 不能构造身份。 */
function authenticatedActor(c: Context<AuthEnv>): UserActor {
  const actor = c.get("actor");
  if (!actor) throw new UnauthorizedError("未提供认证身份");
  return requireUserActor(actor);
}

async function body<T>(c: Context): Promise<T> {
  const input = await parseJsonBody<unknown>(c);
  assertObjectBody(input);
  return input as T;
}
for (
  const path of ["/domains/:slug/classrooms", "/domains/:slug/classrooms/*"]
) {
  router.use(path, authMiddleware, async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
}

function revision(value: string | undefined) {
  if (!value) return null;
  const match = /^"?([0-9]+)"?$/.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[1]))) {
    throw new BadRequestError("If-Match 必须是班级 revision");
  }
  return Number(match[1]);
}

router.get("/domains/:slug/classrooms", async (c) => {
  const { page } = parsePagination(c, { defaultPerPage: 50, maxPerPage: 50 });
  return c.json({
    data: await listClassrooms(c.req.param("slug"), c.var.userId, page),
    page,
    per_page: 50,
  });
});
router.post("/domains/:slug/classrooms", async (c) => {
  const input = await body<
    {
      name: string;
      description?: string;
      stage_tag?: string;
      primary_coach_id?: string;
    }
  >(c);
  return c.json({
    data: await createClassroom(c.req.param("slug"), c.var.userId, input),
  }, 201);
});
router.get(
  "/domains/:slug/classrooms/:id",
  async (c) =>
    c.json({
      data: await getClassroom(
        c.req.param("slug"),
        c.req.param("id"),
        c.var.userId,
      ),
    }),
);
router.patch("/domains/:slug/classrooms/:id", async (c) => {
  const input = await body<
    { name?: string; description?: string; stage_tag?: string }
  >(c);
  return c.json({
    data: await updateClassroom(
      c.req.param("slug"),
      c.req.param("id"),
      c.var.userId,
      revision(c.req.header("If-Match")),
      {
        name: input.name,
        description: input.description,
        stage_tag: input.stage_tag,
      },
    ),
  });
});
router.post(
  "/domains/:slug/classrooms/:id/archive",
  async (c) =>
    c.json({
      data: await updateClassroom(
        c.req.param("slug"),
        c.req.param("id"),
        c.var.userId,
        revision(c.req.header("If-Match")),
        { archive: true },
      ),
    }),
);
router.get(
  "/domains/:slug/classrooms/:id/members",
  async (c) =>
    c.json({
      data: await listClassroomMembers(
        c.req.param("slug"),
        c.req.param("id"),
        c.var.userId,
      ),
    }),
);
router.put("/domains/:slug/classrooms/:id/members/:userId", async (c) => {
  const input = await body<
    { role: ClassroomRole; capabilities?: AssistantCapability[] }
  >(c);
  return c.json({
    data: await setClassroomMember(
      c.req.param("slug"),
      c.req.param("id"),
      c.var.userId,
      c.req.param("userId"),
      revision(c.req.header("If-Match")),
      input,
    ),
  });
});
router.delete(
  "/domains/:slug/classrooms/:id/members/:userId",
  async (c) =>
    c.json({
      data: await removeClassroomMember(
        c.req.param("slug"),
        c.req.param("id"),
        c.var.userId,
        c.req.param("userId"),
        revision(c.req.header("If-Match")),
      ),
    }),
);
router.post("/domains/:slug/classrooms/:id/transfer", async (c) => {
  const input = await body<{ user_id: string }>(c);
  if (typeof input.user_id !== "string") {
    throw new BadRequestError("接任教练账号非法");
  }
  return c.json({
    data: await transferClassroom(
      c.req.param("slug"),
      c.req.param("id"),
      c.var.userId,
      input.user_id,
      revision(c.req.header("If-Match")),
    ),
  });
});

/** 班级准备路由；完成域资源隔离后在生产组合根挂载。 */
router.post("/domains/:slug/classrooms/:id/invitations", async (c) => {
  const input = await body<
    DomainInvitationInput
  >(c);
  return c.json({
    data: await createClassroomInvitationCommand(
      authenticatedActor(c),
      c.req.param("slug"),
      c.req.param("id"),
      input,
    ),
  }, 201);
});
router.get(
  "/domains/:slug/classrooms/:id/invitations",
  async (c) => {
    const pagination = parsePagination(c, { defaultPerPage: 25 });
    const result = await listClassroomInvitations(
      c.req.param("slug"),
      c.req.param("id"),
      c.var.userId,
      pagination,
    );
    return c.json({
      data: result.data,
      pagination: buildPaginationMeta(
        pagination.page,
        pagination.perPage,
        result.total,
      ),
    });
  },
);
router.delete(
  "/domains/:slug/classrooms/:id/invitations/:inviteId",
  async (c) =>
    c.json({
      data: await revokeClassroomInvitationCommand(
        authenticatedActor(c),
        c.req.param("slug"),
        c.req.param("id"),
        c.req.param("inviteId"),
      ),
    }),
);

/** 班级准备路由；完成域资源隔离后在生产组合根挂载。 */
router.route("/", assignmentRouter);
router.route("/", studentSubmissionsRouter);
router.route("/", interactionRouter);
router.route("/", annotationRouter);
router.route("/", classroomEnrollmentRouter);
router.route("/", educationWorkbenchRouter);
export const educationRouter = router;
