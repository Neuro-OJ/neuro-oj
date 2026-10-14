import { Hono } from "hono";
import { type AuthEnv, authMiddleware } from "../../identity/index.ts";
import { BadRequestError, NotFoundError } from "../../../shared/base/errors.ts";
import { enforceProblemImportRateLimit } from "../../system/index.ts";
import { loadEditableDomainProblem } from "../services/workspace/problem-edit.ts";
import {
  draftRevisionRequired,
  getProblemDraft,
} from "../services/versioning/draft.ts";
import {
  listDraftOiFiles,
  loadOiDataFromDraft,
  saveOiDraft,
} from "../services/versioning/oi-draft.ts";
import { validateOiDataPath } from "../services/oi-data.ts";
import { parseOiArchive } from "../services/oi-archive.ts";
import { MAX_SUPPORT_PACKAGE_SIZE } from "../services/support-package.ts";
import type { ProblemDraftContent } from "../types/problem-content.ts";
import { assertObjectBody } from "../../../shared/http/request.ts";

/** 隐藏数据只供本域源题编辑者使用，引用域没有文件编辑或下载入口。 */
export const domainProblemFilesRouter = new Hono<AuthEnv>();
const prefix = "/domains/:slug/problems/:reference/oi";
domainProblemFilesRouter.use(`${prefix}/*`, authMiddleware, async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
async function resource(slug: string, reference: string, actor: string) {
  const access = await loadEditableDomainProblem(slug, reference, actor);
  if (access.problem.judge_type !== "oi") {
    throw new BadRequestError("数据编辑仅用于 OI 题");
  }
  return access;
}
domainProblemFilesRouter.get(`${prefix}/files`, async (c) => {
  const access = await resource(
    c.req.param("slug")!,
    c.req.param("reference")!,
    c.var.userId,
  );
  const [draft, files] = await Promise.all([
    getProblemDraft(access.problem.id, access.problem),
    listDraftOiFiles(access.problem.id),
  ]);
  return c.json({
    data: {
      draft_revision: draft.revision,
      updated_at: draft.updated_at,
      files,
    },
  });
});
domainProblemFilesRouter.get(`${prefix}/file`, async (c) => {
  const access = await resource(
      c.req.param("slug")!,
      c.req.param("reference")!,
      c.var.userId,
    ),
    path = c.req.query("path");
  if (!path) throw new BadRequestError("缺少文件路径");
  validateOiDataPath(path);
  const bytes = (await loadOiDataFromDraft(access.problem.id))[path];
  if (!bytes) throw new NotFoundError("文件不存在");
  if (c.req.query("download") === "1") {
    return new Response(bytes as BodyInit, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename*=UTF-8''${
          encodeURIComponent(path.split("/").at(-1)!)
        }`,
      },
    });
  }
  let text: string | null = null;
  if (bytes.length <= 1024 * 1024) {
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!decoded.includes("\0")) text = decoded;
    } catch { /* 二进制文件只返回元数据。 */ }
  }
  return c.json({
    data: {
      path,
      size: bytes.length,
      text,
      truncated: bytes.length > 1024 * 1024,
    },
  });
});
domainProblemFilesRouter.post(`${prefix}/save`, async (c) => {
  const slug = c.req.param("slug")!,
    reference = c.req.param("reference")!,
    actor = c.var.userId;
  const access = await resource(slug, reference, actor);
  const header = c.req.header("If-Match");
  if (header === undefined) throw draftRevisionRequired();
  const value = header.replace(/^"|"$/g, ""), revision = Number(value);
  if (!value || !Number.isSafeInteger(revision) || revision < 0) {
    throw new BadRequestError("草稿 revision 无效");
  }
  await enforceProblemImportRateLimit(c, actor);
  const form = await c.req.parseBody({ all: true });
  if (
    typeof form.metadata !== "string" || form.metadata.length > 4 * 1024 * 1024
  ) throw new BadRequestError("缺少合法编辑配置");
  let metadata: {
    content: ProblemDraftContent;
    changes?: Record<string, string>;
    removed?: string[];
    upload_paths?: string[];
  };
  try {
    metadata = JSON.parse(form.metadata);
  } catch {
    throw new BadRequestError("编辑配置不是有效 JSON");
  }
  assertObjectBody(metadata);
  assertObjectBody(metadata.content);
  if (metadata.content.kind !== "oi") {
    throw new BadRequestError("需要 OI 草稿内容");
  }
  if (metadata.changes !== undefined) assertObjectBody(metadata.changes);
  for (const list of [metadata.removed, metadata.upload_paths]) {
    if (
      list !== undefined &&
      (!Array.isArray(list) || !list.every((path) => typeof path === "string"))
    ) throw new BadRequestError("文件路径列表非法");
  }
  const changing = form.file !== undefined || form.data_files !== undefined ||
    Object.keys(metadata.changes ?? {}).length > 0 ||
    (metadata.removed?.length ?? 0) > 0;
  let entries: Record<string, Uint8Array> | undefined;
  if (changing) {
    entries = await loadOiDataFromDraft(access.problem.id);
    if (form.file !== undefined) {
      if (
        !(form.file instanceof File) ||
        !form.file.name.toLowerCase().endsWith(".zip") ||
        form.file.size > MAX_SUPPORT_PACKAGE_SIZE
      ) throw new BadRequestError("请上传不超过 128 MiB 的 ZIP 题目包");
      entries =
        (await parseOiArchive(new Uint8Array(await form.file.arrayBuffer())))
          .entries;
      for (
        const path of [
          "problem.json",
          "problem.yaml",
          "problem.md",
          "statement.md",
        ]
      ) delete entries[path];
    }
    for (const path of metadata.removed ?? []) {
      validateOiDataPath(path);
      delete entries[path];
    }
    for (const [path, text] of Object.entries(metadata.changes ?? {})) {
      validateOiDataPath(path);
      if (typeof text !== "string") {
        throw new BadRequestError("编辑内容必须是文本");
      }
      entries[path] = new TextEncoder().encode(text);
    }
    const files = form.data_files === undefined
      ? []
      : Array.isArray(form.data_files)
      ? form.data_files
      : [form.data_files];
    for (const [index, file] of files.entries()) {
      if (!(file instanceof File) || file.size > 64 * 1024 * 1024) {
        throw new BadRequestError("数据文件超过 64 MiB 或格式非法");
      }
      const path = metadata.upload_paths?.[index] ?? file.name;
      validateOiDataPath(path);
      entries[path] = new Uint8Array(await file.arrayBuffer());
    }
  }
  const saved = await saveOiDraft(access.problem.id, {
    runtime_config: metadata.content.runtime_config,
    title: metadata.content.title,
    description: metadata.content.description,
    samples: metadata.content.samples,
    expectedRevision: revision,
    actorId: actor,
    domainId: access.domain.id,
    authorize: async (tx) => {
      await loadEditableDomainProblem(slug, reference, actor, {
        executor: tx,
        write: true,
      });
    },
  }, entries);
  return c.json({
    data: {
      problem_id: saved.problem_id,
      draft_revision: saved.revision,
      files_changed: saved.files_changed,
    },
  });
});
