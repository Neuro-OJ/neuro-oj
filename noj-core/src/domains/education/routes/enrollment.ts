import { type Context, Hono } from "hono";
import type { AuthEnv } from "../../identity/index.ts";
import { BadRequestError } from "../../../shared/base/errors.ts";
import {
  assertObjectBody,
  parseJsonBody,
} from "../../../shared/http/request.ts";
import { parsePagination } from "../../../shared/http/pagination.ts";
import {
  executeClassroomImport,
  previewClassroomImport,
} from "../services/classroom-import.ts";
import {
  listClassroomJoinRequests,
  readClassroomJoin,
  requestClassroomJoin,
  reviewClassroomJoin,
} from "../services/join-requests.ts";

/** 入班准备接口沿用班级父路由的认证及 no-store，路径域在每条服务重新校验。 */
export const classroomEnrollmentRouter = new Hono<AuthEnv>();
const prefix = "/domains/:slug/classrooms/:id";
function revision(c: Context) {
  const value = c.req.header("If-Match");
  if (value === undefined) return null;
  if (
    !/^"?[0-9]+"?$/.test(value) ||
    !Number.isSafeInteger(Number(value.replaceAll('"', "")))
  ) throw new BadRequestError("If-Match 必须是班级 revision");
  return Number(value.replaceAll('"', ""));
}
classroomEnrollmentRouter.get(
  `${prefix}/join`,
  async (c) =>
    c.json({
      data: await readClassroomJoin(
        c.req.param("slug")!,
        c.req.param("id")!,
        c.var.userId,
      ),
    }),
);
classroomEnrollmentRouter.post(`${prefix}/join`, async (c) => {
  const input = await parseJsonBody<{ reason: string }>(c);
  assertObjectBody(input);
  return c.json({
    data: await requestClassroomJoin(
      c.req.param("slug")!,
      c.req.param("id")!,
      c.var.userId,
      input.reason,
    ),
  }, 201);
});
classroomEnrollmentRouter.get(`${prefix}/join-requests`, async (c) => {
  const { page } = parsePagination(c, { defaultPerPage: 50, maxPerPage: 50 });
  return c.json({
    data: await listClassroomJoinRequests(
      c.req.param("slug")!,
      c.req.param("id")!,
      c.var.userId,
      {
        page,
        status: c.req.query("status") as
          | "pending"
          | "approved"
          | "rejected"
          | undefined,
      },
    ),
  });
});
classroomEnrollmentRouter.post(
  `${prefix}/join-requests/:requestId/review`,
  async (c) => {
    const input = await parseJsonBody<{ decision: "approve" | "reject" }>(c);
    assertObjectBody(input);
    return c.json({
      data: await reviewClassroomJoin(
        c.req.param("slug")!,
        c.req.param("id")!,
        c.req.param("requestId")!,
        c.var.userId,
        revision(c),
        c.req.header("Idempotency-Key") ?? "",
        input.decision,
      ),
    });
  },
);
classroomEnrollmentRouter.post(`${prefix}/imports/preview`, async (c) => {
  const input = await parseJsonBody<{ csv: string; replace_pending?: boolean }>(
    c,
  );
  assertObjectBody(input);
  return c.json({
    data: await previewClassroomImport(
      c.req.param("slug")!,
      c.req.param("id")!,
      c.var.userId,
      input.csv,
      input.replace_pending === true,
    ),
  });
});
classroomEnrollmentRouter.post(`${prefix}/imports/execute`, async (c) => {
  const input = await parseJsonBody<
    { csv: string; preview_hash: string; replace_pending?: boolean }
  >(c);
  assertObjectBody(input);
  return c.json({
    data: await executeClassroomImport(
      c.req.param("slug")!,
      c.req.param("id")!,
      c.var.userId,
      c.req.header("Idempotency-Key") ?? "",
      revision(c),
      input,
    ),
  });
});
