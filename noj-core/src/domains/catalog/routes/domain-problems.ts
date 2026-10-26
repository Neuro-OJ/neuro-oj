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
  listDomainProblemVersions,
  readDomainProblem,
  readDomainProblemTemplate,
} from "../services/workspace/problem-read.ts";
import {
  preflightDomainProblemVersion,
  publishDomainProblemVersion,
  readDomainProblemDraft,
  saveDomainProblemDraft,
} from "../services/workspace/problem-edit.ts";
import type { CreateProblemInput } from "../types/problems.ts";
import type { ProblemDraftContent } from "../types/problem-content.ts";
import { draftRevisionRequired } from "../services/versioning/draft.ts";
import { setDomainProblemBindingState } from "../services/workspace/problem-bindings.ts";
import { listEditableDomainProblemDrafts } from "../services/workspace/problem-draft-list.ts";
import { domainProblemFilesRouter } from "./domain-problem-files.ts";
import { importDomainProblemDraftBundle } from "../services/workspace/problem-bundle-edit.ts";
import { enforceProblemImportRateLimit } from "../../system/index.ts";
import { MAX_SUPPORT_PACKAGE_SIZE } from "../services/support-package.ts";
import { importDomainProblemBundle } from "../services/workspace/problem-bundle-import.ts";
import {
  readDomainModelCapabilities,
  readDomainProblemUi,
} from "../services/workspace/problem-capabilities.ts";

/** 显式域题库入口，保留使用域上下文及来源题号。 */
export const domainProblemsRouter = new Hono<AuthEnv>();
const prefix = "/domains/:slug/problems";
domainProblemsRouter.get(
  `${prefix}/llm-model-aliases`,
  authMiddleware,
  async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      data: await readDomainModelCapabilities(
        c.req.param("slug")!,
        c.var.userId,
      ),
    });
  },
);
domainProblemsRouter.get(
  `${prefix}/:reference/ui`,
  authMiddleware,
  async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      data: await readDomainProblemUi(
        c.req.param("slug")!,
        c.req.param("reference")!,
        c.var.userId,
        c.req.query("version_id"),
      ),
    });
  },
);
domainProblemsRouter.route("/", domainProblemFilesRouter);
domainProblemsRouter.get(
  "/domains/:slug/problem-drafts",
  authMiddleware,
  async (c) => {
    const { page, perPage } = parsePagination(c, {
      perPageField: "limit",
      maxPerPage: 100,
    });
    c.header("Cache-Control", "no-store");
    return c.json(
      await listEditableDomainProblemDrafts(
        c.req.param("slug")!,
        c.var.userId,
        page,
        perPage,
      ),
    );
  },
);

domainProblemsRouter.get(
  `${prefix}/:reference/template`,
  optionalAuthMiddleware,
  async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      data: await readDomainProblemTemplate(
        c.req.param("slug")!,
        c.req.param("reference")!,
        c.var.userId ?? null,
        c.req.query("version_id"),
      ),
    });
  },
);
domainProblemsRouter.get(
  `${prefix}/:reference/versions`,
  optionalAuthMiddleware,
  async (c) => {
    const { page, perPage } = parsePagination(c, {
      perPageField: "limit",
      maxPerPage: 100,
    });
    c.header("Cache-Control", "no-store");
    return c.json(
      await listDomainProblemVersions(
        c.req.param("slug")!,
        c.req.param("reference")!,
        c.var.userId ?? null,
        page,
        perPage,
      ),
    );
  },
);

function draftRevision(header: string | undefined) {
  if (header === undefined) throw draftRevisionRequired();
  const raw = header.replace(/^"|"$/g, "");
  const revision = Number(raw);
  if (!raw || !Number.isInteger(revision) || revision < 0) {
    throw new BadRequestError("草稿 revision 必须为非负整数");
  }
  return revision;
}

domainProblemsRouter.post(
  `${prefix}/import-bundle`,
  authMiddleware,
  async (c) => {
    const header = c.req.header("If-Match");
    const revision = header === undefined ? undefined : draftRevision(header);
    await enforceProblemImportRateLimit(c, c.var.userId);
    const form = await c.req.parseBody();
    if (
      !(form.file instanceof File) ||
      !form.file.name.toLowerCase().endsWith(".zip")
    ) {
      throw new BadRequestError("请上传 ZIP 题目包");
    }
    if (form.file.size > MAX_SUPPORT_PACKAGE_SIZE) {
      throw new BadRequestError("题目包超过 128 MiB");
    }
    c.header("Cache-Control", "no-store");
    const saved = await importDomainProblemBundle(
      c.req.param("slug")!,
      c.var.userId,
      new Uint8Array(await form.file.arrayBuffer()),
      revision,
      c,
    );
    return c.json({ data: saved }, saved.created ? 201 : 200);
  },
);

domainProblemsRouter.post(
  `${prefix}/:reference/import-bundle`,
  authMiddleware,
  async (c) => {
    const revision = draftRevision(c.req.header("If-Match"));
    await enforceProblemImportRateLimit(c, c.var.userId);
    const form = await c.req.parseBody();
    if (
      !(form.file instanceof File) ||
      !form.file.name.toLowerCase().endsWith(".zip")
    ) {
      throw new BadRequestError("请上传 ZIP 题目包");
    }
    if (form.file.size > MAX_SUPPORT_PACKAGE_SIZE) {
      throw new BadRequestError("题目包超过 128 MiB");
    }
    c.header("Cache-Control", "no-store");
    return c.json({
      data: await importDomainProblemDraftBundle(
        c.req.param("slug")!,
        c.req.param("reference")!,
        c.var.userId,
        new Uint8Array(await form.file.arrayBuffer()),
        revision,
        c,
      ),
    });
  },
);

domainProblemsRouter.get(
  `${prefix}/:reference/publish-preflight`,
  authMiddleware,
  async (c) => {
    const revision = draftRevision(c.req.query("expected_revision"));
    c.header("Cache-Control", "no-store");
    return c.json(
      await preflightDomainProblemVersion(
        c.req.param("slug")!,
        c.req.param("reference")!,
        c.var.userId,
        revision,
      ),
    );
  },
);

domainProblemsRouter.get(prefix, optionalAuthMiddleware, async (c) => {
  c.header("Cache-Control", "no-store");
  const pagination = parsePagination(c, { perPageField: "limit" });
  return c.json(
    await listDomainProblems(c.req.param("slug")!, c.var.userId ?? null, {
      page: pagination.page,
      limit: pagination.perPage,
      keyword: c.req.query("keyword"),
      difficulty: c.req.query("difficulty"),
      kind: c.req.query("kind"),
      progress: c.req.query("progress"),
      tag_id: c.req.query("tag_id"),
      judge_backend: c.req.query("judge_backend"),
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
  if ("type" in input) {
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

domainProblemsRouter.post(
  `${prefix}/:reference/state`,
  authMiddleware,
  async (c) => {
    const input = await parseJsonBody<
      { disabled: boolean; visibility?: "public" | "members"; reason: string }
    >(c);
    assertObjectBody(input);
    c.header("Cache-Control", "no-store");
    return c.json({
      data: await setDomainProblemBindingState(
        c.req.param("slug")!,
        c.req.param("reference")!,
        c.var.userId,
        draftRevision(c.req.header("If-Match")),
        input,
      ),
    });
  },
);
