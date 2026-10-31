import { assertEquals } from "jsr:@std/assert@^1";
import { Hono } from "hono";
import emailDelivery from "../../routes/email-delivery.ts";
import { AppError } from "../../../../../shared/base/errors.ts";
import {
  initRedisForTest,
  jsonRequest,
} from "../../../../../../tests/helper.ts";

await initRedisForTest();

/** 与 src/app.ts 等价的 onError：AppError 走自身状态码，其余 500。 */
function createTestApp() {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof AppError) {
      const response = c.json(
        { error: err.message, code: err.code, request_id: crypto.randomUUID() },
        err.statusCode as 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503,
      );
      // 与 src/app.ts 一致：限流错误携带 Retry-After / X-RateLimit-* 响应头。
      const extra = (err as { headers?: Record<string, string> }).headers;
      for (const [k, v] of Object.entries(extra ?? {})) {
        response.headers.set(k, v);
      }
      return response;
    }
    console.error("未处理的错误:", err);
    return c.json({ error: "服务器内部错误" }, 500);
  });
  app.route("/api/v1", emailDelivery);
  return app;
}

/**
 * 邮件投递回执是**对公网开放**的写端点（厂商回调），必须有自己的写窗口。
 *
 * 探针选择「适配器未配置」的 provider：`getEmailDeliveryAdapter` 返回 undefined 后
 * 立刻抛 503，请求不会触达 DB 与签名解析。因此本用例验证的是限流器本身——
 * 计数窗口 60s/120、边界放行、超额 429，且限流先于任何业务副作用。
 *
 * 每个请求都带同一个 `X-Forwarded-For`，使来源 IP 在用例内稳定；不直接断言 Redis
 * 键名（键由 `getClientIp` 与归一化规则决定，属实现细节，断言边界行为更可靠）。
 */
Deno.test({
  name:
    "邮件回执限流 HTTP：按来源 IP 计数，窗口内最后一次放行、超额 429 带 Retry-After",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const previous = Deno.env.get("RATE_LIMIT_ENABLED");
    const app = createTestApp();
    const request = () =>
      jsonRequest(app, "/api/v1/email-events/unknown-provider", {
        method: "POST",
        headers: { "X-Forwarded-For": "203.0.113.77" },
      });
    try {
      Deno.env.set("RATE_LIMIT_ENABLED", "true");
      for (let i = 0; i < 120; i++) {
        const allowed = await request();
        assertEquals(
          allowed.status,
          503,
          `第 ${i + 1} 次回执应在窗口内放行到业务处理（未配置 provider → 503）`,
        );
      }
      const blocked = await request();
      assertEquals(blocked.status, 429, "第 121 次回执应被限流");
      assertEquals(
        blocked.headers.get("retry-after") !== null,
        true,
        "限流响应需带 Retry-After",
      );
    } finally {
      if (previous === undefined) Deno.env.delete("RATE_LIMIT_ENABLED");
      else Deno.env.set("RATE_LIMIT_ENABLED", previous);
    }
  },
});
