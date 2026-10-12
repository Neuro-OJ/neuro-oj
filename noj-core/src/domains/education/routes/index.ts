import { type Context, Hono } from "hono";
import { assignmentRouter } from "./assignments.ts";
import { studentSubmissionsRouter } from "./student-submissions.ts";
import { type AuthEnv, authMiddleware } from "../../identity/index.ts";
import { BadRequestError } from "../../../shared/base/errors.ts";
import {
  assertObjectBody,
  parseJsonBody,
} from "../../../shared/http/request.ts";
import { parsePagination } from "../../../shared/http/pagination.ts";
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
import {
  createClassroomInvitation,
  listClassroomInvitations,
  revokeClassroomInvitation,
} from "../services/invitations.ts";

const router = new Hono<AuthEnv>();
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
  const input = await body<{ email: string }>(c);
  return c.json({
    data: await createClassroomInvitation(
      c.req.param("slug"),
      c.req.param("id"),
      c.var.userId,
      input.email,
    ),
  }, 201);
});
router.get(
  "/domains/:slug/classrooms/:id/invitations",
  async (c) =>
    c.json({
      data: await listClassroomInvitations(
        c.req.param("slug"),
        c.req.param("id"),
        c.var.userId,
      ),
    }),
);
router.delete(
  "/domains/:slug/classrooms/:id/invitations/:inviteId",
  async (c) =>
    c.json({
      data: await revokeClassroomInvitation(
        c.req.param("slug"),
        c.req.param("id"),
        c.var.userId,
        c.req.param("inviteId"),
      ),
    }),
);

/** 班级准备路由；完成域资源隔离后在生产组合根挂载。 */
router.route("/", assignmentRouter);
router.route("/", studentSubmissionsRouter);
export const educationRouter = router;
