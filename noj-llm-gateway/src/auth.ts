/**
 * noj-llm-gateway 内部管理 API 鉴权中间件。
 */
import type { MiddlewareHandler } from "hono";

function safeCompare(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBuf = enc.encode(a);
  const bBuf = enc.encode(b);
  if (aBuf.byteLength !== bBuf.byteLength) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < aBuf.byteLength; i++) {
    diff |= aBuf[i] ^ bBuf[i];
  }
  return diff === 0;
}

/** 校验 `Authorization: Bearer <token>` 与服务间密钥一致，否则返回 401。 */
export function requireServiceToken(expected: string): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.req.header("Authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token || !safeCompare(token, expected)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}
