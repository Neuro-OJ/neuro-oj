import { Hono } from "hono";
import {
  type AuthEnv,
  authMiddleware,
  optionalAuthMiddleware,
} from "../../identity/index.ts";
import { parsePagination } from "../../../shared/http/pagination.ts";
import {
  assertObjectBody,
  parseJsonBody,
} from "../../../shared/http/request.ts";
import { BadRequestError } from "../../../shared/base/errors.ts";
import { createDomainProblem } from "../services/problems/problems-crud.ts";
import {
  listDomainProblems,
  readDomainProblem,
} from "../services/workspace/problem-read.ts";
import {
  publishDomainProblemVersion,
  readDomainProblemDraft,
  saveDomainProblemDraft,
} from "../services/workspace/problem-edit.ts";
import type { CreateProblemInput } from "../types/problems.ts";
import type { ProblemDraftContent } from "../types/problem-content.ts";
import { draftRevisionRequired } from "../services/versioning/draft.ts";

/** 显式域题库路由；资源隔离阶段完成后由组合根统一挂载。 */
export const domainProblemsRouter = new Hono<AuthEnv>();
const prefix = "/domains/:slug/problems";

function draftRevision(header: string | undefined) {
  if (header === undefined) throw draftRevisionRequired();
  const raw = header.replace(/^"|"$/g, "");
  const revision = Number(raw);
  if (!raw || !Number.isInteger(revision) || revision < 0) {
    throw new BadRequestError("草稿 revision 必须为非负整数");
  }
  return revision;
}

domainProblemsRouter.get(prefix, optionalAuthMiddleware, async (c) => {
  c.header("Cache-Control", "no-store");
  const pagination = parsePagination(c, { perPageField: "limit" });
  return c.json(
    await listDomainProblems(c.req.param("slug")!, c.var.userId ?? null, {
      page: pagination.page,
      limit: pagination.perPage,
      keyword: c.req.query("keyword"),
    }),
  );
});
domainProblemsRouter.get(
  `${prefix}/:reference`,
  optionalAuthMiddleware,
  async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(
      await readDomainProblem(
        c.req.param("slug")!,
        c.req.param("reference")!,
        c.var.userId ?? null,
      ),
    );
  },
);
domainProblemsRouter.post(prefix, authMiddleware, async (c) => {
  const input = await parseJsonBody<CreateProblemInput>(c);
  assertObjectBody(input);
  if (
    typeof input.title !== "string" || !input.title.trim() ||
    typeof input.description !== "string"
  ) throw new BadRequestError("题目标题与题面必填");
  if (input.type !== undefined) {
    throw new BadRequestError("域题库不接受 P/U 分类");
  }
  const created = await createDomainProblem(
    c.req.param("slug")!,
    input,
    c.var.userId,
    c,
  );
  c.header("Cache-Control", "no-store");
  return c.json({
    problem_id: created.id,
    number: created.number,
    display_ref: String(created.number),
    draft_revision: 1,
  }, 201);
});
domainProblemsRouter.get(
  `${prefix}/:reference/draft`,
  authMiddleware,
  async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(
      await readDomainProblemDraft(
        c.req.param("slug")!,
        c.req.param("reference")!,
        c.var.userId,
      ),
    );
  },
);
domainProblemsRouter.put(
  `${prefix}/:reference/draft`,
  authMiddleware,
  async (c) => {
    const revision = draftRevision(c.req.header("if-match"));
    const input = await parseJsonBody<{ content: ProblemDraftContent }>(c);
    assertObjectBody(input);
    assertObjectBody(input.content);
    c.header("Cache-Control", "no-store");
    return c.json(
      await saveDomainProblemDraft(
        c.req.param("slug")!,
        c.req.param("reference")!,
        c.var.userId,
        input.content,
        revision,
        c,
      ),
    );
  },
);

domainProblemsRouter.post(
  `${prefix}/:reference/publish`,
  authMiddleware,
  async (c) => {
    const revision = draftRevision(c.req.header("if-match"));
    const input = await parseJsonBody<{ change_note?: string }>(c);
    assertObjectBody(input);
    if (
      input.change_note !== undefined && typeof input.change_note !== "string"
    ) throw new BadRequestError("发布说明必须为文本");
    c.header("Cache-Control", "no-store");
    return c.json(
      await publishDomainProblemVersion(
        c.req.param("slug")!,
        c.req.param("reference")!,
        c.var.userId,
        revision,
        input.change_note ?? "",
        c,
      ),
    );
  },
);
