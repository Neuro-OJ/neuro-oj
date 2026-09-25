/**
 * legal 域公开路由。
 *
 * 挂载前缀 /api/v1/legal（见 app.ts），本文件内为相对路径。
 * 均为只读端点，无需认证与限流。
 */

import { Hono } from "hono";
import {
  getCurrentDocument,
  LEGAL_KINDS,
  type LegalKind,
  listVersions,
} from "../index.ts";
import { ValidationError } from "./../../../shared/base/errors.ts";

const router = new Hono();

/**
 * 当前政策文档（隐私政策 + 服务条款）。
 * GET /api/v1/legal/documents
 * 未发布的文档返回 null。
 */
router.get("/documents", async (c) => {
  const data: Record<string, unknown> = {};
  for (const kind of LEGAL_KINDS) {
    data[kind] = await getCurrentDocument(kind);
  }
  return c.json({ data });
});

/**
 * 某类文档的版本历史（不含正文）。
 * GET /api/v1/legal/documents/:kind/versions
 */
router.get("/documents/:kind/versions", async (c) => {
  const kind = c.req.param("kind");
  if (!(LEGAL_KINDS as readonly string[]).includes(kind)) {
    throw new ValidationError(`未知的法律文档类型：${kind}`);
  }
  const versions = await listVersions(kind as LegalKind);
  return c.json({ data: versions });
});

export default router;
