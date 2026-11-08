import { Hono } from "hono";
import { authMiddleware } from "../../access/identity/middleware/auth.ts";
import { type AuthEnv } from "../../../shared/http/hono-env.ts";
import { userActorFromAuthenticatedId } from "../../access/contracts/actor.ts";
import { BadRequestError, NotFoundError } from "../../../shared/base/errors.ts";
import { authorizeOiData, validateOiDataPath } from "../services/oi-data.ts";
import { getProblemDraft } from "../services/versioning/draft.ts";
import {
  listDraftOiFiles,
  loadOiDataFromDraft,
} from "../services/versioning/oi-draft.ts";

const router = new Hono<AuthEnv>();
router.use("*", authMiddleware);

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
