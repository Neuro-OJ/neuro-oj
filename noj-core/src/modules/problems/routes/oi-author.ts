import {
  assertWorkspacePermission,
  loadWorkspace,
} from "../../access/policy.ts";
import { DEFAULT_DOMAIN_SLUG } from "../../../shared/workspace/types.ts";
import { Hono } from "hono";
import { authMiddleware } from "../../access/identity/middleware/auth.ts";
import { type AuthEnv } from "../../../shared/http/hono-env.ts";
import { userActorFromAuthenticatedId } from "../../access/contracts/actor.ts";
import { BadRequestError, NotFoundError } from "../../../shared/base/errors.ts";
import { parseOiArchive } from "../services/oi-archive.ts";
import { MAX_SUPPORT_PACKAGE_SIZE } from "../services/support-package.ts";
import { authorizeOiData, validateOiDataPath } from "../services/oi-data.ts";
import { getProblemDraft } from "../services/versioning/draft.ts";
import {
  listDraftOiFiles,
  loadOiDataFromDraft,
} from "../services/versioning/oi-draft.ts";
import { enforceProblemImportRateLimit } from "../../platform/contracts/cross-module/system_services_hardening-rate-limit.ts";

const router = new Hono<AuthEnv>();
router.use("*", authMiddleware);

async function archive(file: unknown) {
  if (
    !(file instanceof File) || !file.name.toLowerCase().endsWith(".zip") ||
    file.size > MAX_SUPPORT_PACKAGE_SIZE
  ) {
    throw new BadRequestError("请上传不超过 128 MiB 的 ZIP 题目包");
  }
  return parseOiArchive(new Uint8Array(await file.arrayBuffer()));
}

function preview(path: string, bytes: Uint8Array) {
  if (bytes.length > 1024 * 1024) {
    return { path, size: bytes.length, text: null, truncated: true };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return {
      path,
      size: bytes.length,
      text: text.includes("\0") ? null : text,
      truncated: false,
    };
  } catch {
    return { path, size: bytes.length, text: null, truncated: false };
  }
}

router.post("/preview", async (c) => {
  await enforceProblemImportRateLimit(c, c.get("userId"));
  const actor = userActorFromAuthenticatedId(c.var.userId);
  const form = await c.req.parseBody();
  if (typeof form.problem_id === "string") {
    await authorizeOiData(actor, form.problem_id);
  } else {
    assertWorkspacePermission(
      (await loadWorkspace(DEFAULT_DOMAIN_SLUG, actor, { write: true }))
        .context,
      "problem:create",
    );
  }
  const parsed = await archive(form.file);
  if (parsed.manifest.judge_type !== "oi") {
    throw new BadRequestError("需要 OI 题目包");
  }
  const path = typeof form.path === "string" ? form.path : undefined;
  if (path) {
    validateOiDataPath(path);
    const bytes = parsed.entries[path];
    if (!bytes) throw new NotFoundError("数据文件不存在");
    return c.json({ data: preview(path, bytes) });
  }
  return c.json({
    data: {
      manifest: parsed.manifest,
      description: parsed.statement ?? parsed.manifest.description,
      files: Object.entries(parsed.entries).filter(([name]) =>
        !name.endsWith("/")
      ).map(([path, bytes]) => ({ path, size: bytes.length })),
      warnings: [],
    },
  });
});

router.get("/:id/files", async (c) => {
  const { row } = await authorizeOiData(
    userActorFromAuthenticatedId(c.var.userId),
    c.req.param("id"),
  );
  const [draft, files] = await Promise.all([
    getProblemDraft(row.id, row),
    listDraftOiFiles(row.id),
  ]);
  return c.json({
    data: {
      // 草稿 revision 是唯一乐观锁（保存时必须原样回传）
      draft_revision: draft.revision,
      updated_at: draft.updated_at ?? row.updated_at,
      files,
    },
  });
});

router.get("/:id/file", async (c) => {
  const path = c.req.query("path");
  if (!path) throw new BadRequestError("缺少文件路径");
  validateOiDataPath(path);
  const { row } = await authorizeOiData(
    userActorFromAuthenticatedId(c.var.userId),
    c.req.param("id"),
  );
  const bytes = (await loadOiDataFromDraft(row.id))[path];
  if (!bytes) throw new NotFoundError("文件不存在");
  if (c.req.query("download") === "1") {
    return new Response(bytes as BodyInit, {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename*=UTF-8''${
          encodeURIComponent(path.split("/").at(-1)!)
        }`,
      },
    });
  }
  return c.json({ data: preview(path, bytes) });
});

export default router;
