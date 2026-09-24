/**
 * legal 域管理路由。
 *
 * 挂载到 `/api/v1/admin/legal`（见 admin/index.ts）。
 * 细粒度权限：`legal:manage`。
 *
 * - GET  /documents/:kind                      当前版本 + 版本历史
 * - POST /documents/:kind/versions             发布新版本
 * - GET  /data-requests                        请求列表（可按状态过滤）
 * - PATCH /data-requests/:id                   更新请求状态
 */

import { Hono } from "hono";
import {
  assertPermission,
  type AuthEnv,
  authMiddleware,
} from "./../../identity/index.ts";
import { parseJsonBody } from "./../../../shared/http/request.ts";
import { ValidationError } from "./../../../shared/base/errors.ts";
import { enforceRateLimit } from "./../../system/index.ts";
import {
  getCurrentDocument,
  getVersionTsa,
  listVersions,
  publishVersion,
} from "../services/documents.ts";
import { verifyTimestamp } from "../services/tsa.ts";
import { isLegalKind } from "../types.ts";
import type { LegalKind } from "../types.ts";
import { getSetting } from "../../system/index.ts";
import {
  DATA_REQUEST_STATUSES,
  type DataRequestStatus,
  listAllDataRequests,
  updateDataRequestStatus,
} from "../services/data-requests.ts";

const router = new Hono<AuthEnv>();

/** 断言 kind 合法（路由层 400）。 */
function requireKind(raw: string | undefined): LegalKind {
  if (!raw || !isLegalKind(raw)) {
    throw new ValidationError(`未知的法律文档类型：${raw}`);
  }
  return raw;
}
/** 当前版本 + 版本历史。 */
router.get("/documents/:kind", authMiddleware, async (c) => {
  await assertPermission(c, "legal:manage");
  const kind = requireKind(c.req.param("kind"));
  const current = await getCurrentDocument(kind);
  const versions = await listVersions(kind);
  return c.json({ data: { current, versions } });
});

/** 发布新版本。 */
router.post("/documents/:kind/versions", authMiddleware, async (c) => {
  await assertPermission(c, "legal:manage");
  await enforceRateLimit(
    `legal-publish:user:${c.get("userId") as string}`,
    { windowSec: 60, max: 20 },
  );
  const kind = requireKind(c.req.param("kind"));
  const body = await parseJsonBody<{
    content?: string;
    change_summary?: string | null;
    is_material?: boolean;
  }>(c);

  const version = await publishVersion(
    kind,
    body.content ?? "",
    body.change_summary ?? null,
    body.is_material === true,
    c.get("userId") as string,
  );
  return c.json({ data: { kind, version } }, 201);
});

/** 验证某版本的时间戳（离线复核 CMS 签名与 imprint）。 */
router.post(
  "/documents/:kind/versions/:version/verify-tsa",
  authMiddleware,
  async (c) => {
    await assertPermission(c, "legal:manage");
    await enforceRateLimit(
      `legal-verify:user:${c.get("userId") as string}`,
      { windowSec: 60, max: 20 },
    );
    const kind = requireKind(c.req.param("kind"));
    const version = Number(c.req.param("version"));
    const record = await getVersionTsa(kind, version);
    if (!record) {
      throw new ValidationError("该版本不存在");
    }
    if (!record.token || !record.chain) {
      return c.json({
        data: {
          ok: false,
          reason: "该版本未保存时间戳（或为旧格式缺少证书链）",
        },
      });
    }
    const rootCert = String(getSetting("tsa_root_cert")?.value ?? "").trim();
    const result = await verifyTimestamp(
      record.content_hash,
      { token: record.token, chain: record.chain },
      rootCert || undefined,
    );
    return c.json({
      data: {
        ...result,
        provider: record.provider,
        saved_timestamp: record.timestamp,
      },
    });
  },
);

/** 请求列表。 */
router.get("/data-requests", authMiddleware, async (c) => {
  await assertPermission(c, "legal:manage");
  const status = c.req.query("status");
  // 2026-09-25 评审：非法状态此前原样进 `eq()`，静默返回空列表——管理端把参数
  // 拼错时会误判为"已清空"。读路径与写路径统一为 400。
  if (status !== undefined && status !== "") {
    if (!DATA_REQUEST_STATUSES.includes(status as DataRequestStatus)) {
      throw new ValidationError(
        `未知的请求状态：${status}（可选：${
          DATA_REQUEST_STATUSES.join(" / ")
        }）`,
      );
    }
  }
  const rows = await listAllDataRequests(status || undefined);
  return c.json({ data: rows });
});

/** 更新请求状态。 */
router.patch("/data-requests/:id", authMiddleware, async (c) => {
  await assertPermission(c, "legal:manage");
  await enforceRateLimit(
    `legal-request:user:${c.get("userId") as string}`,
    { windowSec: 60, max: 30 },
  );
  const body = await parseJsonBody<{
    status?: string;
    resolution?: string | null;
  }>(c);
  await updateDataRequestStatus(
    c.req.param("id") ?? "",
    body.status ?? "",
    c.get("userId") as string,
    body.resolution ?? null,
  );
  return c.json({ data: { updated: true } });
});

export default router;
