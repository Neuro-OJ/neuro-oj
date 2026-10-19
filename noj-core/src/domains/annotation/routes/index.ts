import { Hono } from "hono";
import type { Context } from "hono";
import {
  type AuthEnv,
  authMiddleware,
  requireAdmin,
} from "../../identity/index.ts";
import { BadRequestError } from "../../../shared/base/errors.ts";
import {
  assertObjectBody,
  parseJsonBody,
} from "../../../shared/http/request.ts";
import { enforceRateLimit } from "../../system/index.ts";
import { listDomainSubmissionTextFiles } from "../../submission/index.ts";
import {
  getAnnotationSource,
  parseAnnotationTarget,
} from "../services/sources.ts";
import {
  annotationInbox,
  annotationRecipients,
  createAnnotation,
  getAnnotation,
  getAnnotationOriginal,
  listAnnotations,
  markAnnotationRead,
  replyAnnotation,
  shareAnnotation,
  updateAnnotationMessage,
  updateAnnotationThread,
} from "../services/threads.ts";

/** 全局批注入口；所有身份数据 no-store，治理查询另行认证和审计。 */
export const annotationRouter = new Hono<AuthEnv>();
const root = "/domains/:slug/annotations";
annotationRouter.use(root, authMiddleware);
annotationRouter.use(`${root}/*`, authMiddleware);
annotationRouter.use(root, async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
annotationRouter.use(`${root}/*`, async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
async function input<T>(c: Context): Promise<T> {
  const value = await parseJsonBody<unknown>(c);
  assertObjectBody(value);
  return value as T;
}
function current(c: Context) {
  const raw = c.req.header("If-Match");
  if (raw === undefined) return null;
  if (!/^(?:\d+|"\d+")$/.test(raw)) {
    throw new BadRequestError("If-Match 批注版本无效");
  }
  const value = Number(raw.replaceAll('"', ""));
  if (!Number.isSafeInteger(value)) {
    throw new BadRequestError("If-Match 批注版本无效");
  }
  return value;
}
async function limit(c: Context<AuthEnv>) {
  await enforceRateLimit(`annotation:user:${c.var.userId}`, {
    windowSec: 60,
    max: 60,
  });
}
annotationRouter.get(root, async (c) => {
  let target;
  if (c.req.query("target")) {
    try {
      target = parseAnnotationTarget(JSON.parse(c.req.query("target")!));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new BadRequestError("批注原文参数无效");
      }
      throw error;
    }
  }
  return c.json(
    await listAnnotations(c.req.param("slug")!, c.var.userId, {
      target,
      shared: c.req.query("shared") === "1",
      teachingOnly: c.req.query("visibility") === "teaching",
      cursor: c.req.query("cursor"),
      limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
    }),
  );
});
annotationRouter.get(
  `${root}/inbox`,
  async (c) =>
    c.json(await annotationInbox(c.req.param("slug")!, c.var.userId, { cursor: c.req.query("cursor"), limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined })),
);
annotationRouter.get(
  `${root}/submissions/:submissionId/files`,
  async (c) =>
    c.json({
      data: await listDomainSubmissionTextFiles(
        c.req.param("slug")!,
        c.var.userId,
        c.req.param("submissionId")!,
      ),
    }),
);
annotationRouter.post(`${root}/source`, async (c) => {
  await limit(c);
  const body = await input<{ target: unknown }>(c);
  return c.json({
    data: await getAnnotationSource(
      c.req.param("slug")!,
      c.var.userId,
      parseAnnotationTarget(body.target),
    ),
  });
});
annotationRouter.post(`${root}/recipients`, async (c) => {
  await limit(c);
  const body = await input<{ target: unknown; keyword?: string }>(c);
  return c.json({
    data: await annotationRecipients(
      c.req.param("slug")!,
      c.var.userId,
      parseAnnotationTarget(body.target),
      body.keyword,
    ),
  });
});
annotationRouter.post(root, async (c) => {
  await limit(c);
  const body = await input<Parameters<typeof createAnnotation>[3]>(c);
  return c.json({
    data: await createAnnotation(
      c.req.param("slug")!,
      c.var.userId,
      c.req.header("Idempotency-Key") ?? "",
      body,
    ),
  }, 201);
});
annotationRouter.get(
  `${root}/:id`,
  async (c) =>
    c.json({
      data: await getAnnotation(
        c.req.param("slug")!,
        c.var.userId,
        c.req.param("id")!,
        c.req.query("page") ? Number(c.req.query("page")) : 1,
      ),
    }),
);
annotationRouter.get(
  `${root}/:id/source`,
  async (c) =>
    c.json({
      data: await getAnnotationOriginal(
        c.req.param("slug")!,
        c.var.userId,
        c.req.param("id")!,
      ),
    }),
);
annotationRouter.post(`${root}/:id/share`, async (c) => {
  await limit(c);
  const body = await input<{ student_id?: string }>(c);
  return c.json({
    data: await shareAnnotation(
      c.req.param("slug")!,
      c.var.userId,
      c.req.param("id")!,
      c.req.header("Idempotency-Key") ?? "",
      current(c),
      body.student_id,
    ),
  }, 201);
});
annotationRouter.post(`${root}/:id/replies`, async (c) => {
  await limit(c);
  const body = await input<{ body: string }>(c);
  return c.json({
    data: await replyAnnotation(
      c.req.param("slug")!,
      c.var.userId,
      c.req.param("id")!,
      c.req.header("Idempotency-Key") ?? "",
      body.body,
    ),
  }, 201);
});
annotationRouter.patch(`${root}/:id/messages/:messageId`, async (c) => {
  await limit(c);
  const body = await input<Parameters<typeof updateAnnotationMessage>[5]>(c);
  return c.json({
    data: await updateAnnotationMessage(
      c.req.param("slug")!,
      c.var.userId,
      c.req.param("id")!,
      c.req.param("messageId")!,
      current(c),
      body,
    ),
  });
});
annotationRouter.patch(`${root}/:id`, async (c) => {
  await limit(c);
  const body = await input<Parameters<typeof updateAnnotationThread>[4]>(c);
  return c.json({
    data: await updateAnnotationThread(
      c.req.param("slug")!,
      c.var.userId,
      c.req.param("id")!,
      current(c),
      body,
    ),
  });
});
annotationRouter.post(
  `${root}/:id/read`,
  async (c) =>
    c.json({
      data: await markAnnotationRead(
        c.req.param("slug")!,
        c.var.userId,
        c.req.param("id")!,
      ),
    }),
);
annotationRouter.post(
  "/admin/instance/annotations/:slug/:id/query",
  authMiddleware,
  requireAdmin(),
  async (c) => {
    c.header("Cache-Control", "no-store");
    const body = await input<{ reason: string; page?: number }>(c);
    if (
      typeof body.reason !== "string" || !body.reason.trim()
    ) throw new BadRequestError("请填写治理查询原因");
    return c.json({
      data: await getAnnotation(
        c.req.param("slug")!,
        c.var.userId,
        c.req.param("id")!,
        body.page ?? 1,
        body.reason,
      ),
    });
  },
);
