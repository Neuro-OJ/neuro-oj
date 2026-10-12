/**
 * legal 域同意端点。
 *
 * POST /api/v1/legal/consent —— 登录用户对"当前版本"表示同意。
 *
 * 限流：按用户维度低频（政策变更不频繁），防止脚本刷写同意记录。
 */

import { Hono } from "hono";
import { type AuthEnv, authMiddleware } from "./../../identity/index.ts";
import { parseJsonBody } from "./../../../shared/http/request.ts";
import { ValidationError } from "./../../../shared/base/errors.ts";
import { enforceRateLimit } from "./../../system/index.ts";
import { getClientIp } from "./../../system/index.ts";
import {
  getCurrentDocument,
  isLegalKind,
  type LegalKind,
  recordConsent,
} from "../index.ts";

const router = new Hono<AuthEnv>();

/** 同意端点限流配置：每用户 30 秒内最多 10 次。 */
const CONSENT_LIMIT = { windowSec: 30, max: 10 };

/**
 * 记录对某份文档当前版本的同意。
 * POST /api/v1/legal/consent
 * body: { kind: "privacy" | "terms" }
 */
router.post("/consent", authMiddleware, async (c) => {
  const userId = c.get("userId") as string;
  await enforceRateLimit(`legal-consent:user:${userId}`, CONSENT_LIMIT);

  const body = await parseJsonBody<{ kind?: string }>(c);
  const kind = body.kind ?? "";
  if (!isLegalKind(kind)) {
    throw new ValidationError(`未知的法律文档类型：${kind}`);
  }

  const doc = await getCurrentDocument(kind as LegalKind);
  if (!doc) {
    throw new ValidationError("该文档尚未发布，无法记录同意");
  }

  await recordConsent(
    userId,
    kind as LegalKind,
    doc.version,
    doc.content_hash,
    getClientIp(c),
    c.req.header("user-agent") ?? null,
  );

  return c.json({ data: { kind, version: doc.version, agreed: true } }, 201);
});

export default router;
