import { Hono } from "hono";
import type { AuthEnv } from "../../identity/index.ts";
import { BadRequestError } from "../../../shared/base/errors.ts";
import {
  assertObjectBody,
  parseJsonBody,
} from "../../../shared/http/request.ts";
import { parsePagination } from "../../../shared/http/pagination.ts";
import {
  createSubmissionAnnotation,
  listSubmissionAnnotations,
  type SubmissionAnnotationInput,
  updateSubmissionAnnotation,
} from "../services/annotations.ts";
import {
  downloadTeachingArtifact,
  getTeachingTextFile,
  listTeachingTextFiles,
} from "../services/submission-text.ts";

/** 批注准备路由，使用班级父路由认证及 no-store；所有操作重新检查源码权限。 */
export const annotationRouter = new Hono<AuthEnv>();
const path =
  "/domains/:slug/classrooms/:id/submissions/submission/:submissionId";
annotationRouter.get(`${path}/artifact`, async (c) => {
  c.header("Cache-Control", "private, no-store");
  return await downloadTeachingArtifact(
    c.req.param("slug")!,
    c.req.param("id")!,
    c.req.param("submissionId")!,
    c.var.userId,
  );
});
annotationRouter.get(
  `${path}/files`,
  async (c) =>
    c.json({
      data: await listTeachingTextFiles(
        c.req.param("slug")!,
        c.req.param("id")!,
        c.req.param("submissionId")!,
        c.var.userId,
      ),
    }),
);
annotationRouter.get(`${path}/text`, async (c) => {
  const file = c.req.query("file");
  if (!file) throw new BadRequestError("需要文件名");
  return c.json({
    data: await getTeachingTextFile(
      c.req.param("slug")!,
      c.req.param("id")!,
      c.req.param("submissionId")!,
      c.var.userId,
      file,
    ),
  });
});
annotationRouter.get(`${path}/annotations`, async (c) => {
  const { page } = parsePagination(c, { defaultPerPage: 50, maxPerPage: 50 });
  return c.json({
    data: await listSubmissionAnnotations(
      c.req.param("slug")!,
      c.req.param("id")!,
      c.req.param("submissionId")!,
      c.var.userId,
      page,
    ),
  });
});
annotationRouter.post(`${path}/annotations`, async (c) => {
  const input = await parseJsonBody<unknown>(c);
  assertObjectBody(input);
  return c.json({
    data: await createSubmissionAnnotation(
      c.req.param("slug")!,
      c.req.param("id")!,
      c.req.param("submissionId")!,
      c.var.userId,
      c.req.header("Idempotency-Key") ?? "",
      input as unknown as SubmissionAnnotationInput,
    ),
  }, 201);
});
annotationRouter.patch(`${path}/annotations/:annotationId`, async (c) => {
  const input = await parseJsonBody<unknown>(c);
  assertObjectBody(input);
  const match = c.req.header("If-Match");
  if (match !== undefined && !/^"?[0-9]+"?$/.test(match)) {
    throw new BadRequestError("If-Match 必须是批注 revision");
  }
  return c.json({
    data: await updateSubmissionAnnotation(
      c.req.param("slug")!,
      c.req.param("id")!,
      c.req.param("submissionId")!,
      c.req.param("annotationId")!,
      c.var.userId,
      match === undefined ? null : Number(match.replaceAll('"', "")),
      {
        body: input.body as string | undefined,
        withdraw: input.withdraw === true,
      },
    ),
  });
});
