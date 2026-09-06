import { Hono } from "hono";
import {
  BadRequestError,
  ServiceUnavailableError,
  UnauthorizedError,
} from "../../../shared/base/errors.ts";
import { getSetting } from "../services/system-settings.ts";
import {
  getEmailDeliveryAdapter,
  SignedFixtureEmailDeliveryAdapter,
} from "../services/email-delivery/fixture-adapter.ts";
import {
  ingestEmailDeliveryEvent,
  normalizeEmailDeliveryEvent,
} from "../services/email-delivery/service.ts";
import { EmailDeliveryAdapterError } from "../services/email-delivery/types.ts";

/**
 * 邮件事件接收入口。
 *
 * 只有 fixture 适配器已实现；阿里云/腾讯云在官方回调协议确认前明确返回
 * 503，不把猜测的字段或签名算法暴露为生产接口。
 */
const router = new Hono();

router.post("/email-events/:provider", async (c) => {
  const provider = c.req.param("provider");
  if (provider === "fixture" && Deno.env.get("NOJ_ENV") === "production") {
    throw new ServiceUnavailableError(
      "fixture 邮件回调仅允许本地或测试环境使用",
    );
  }
  const adapter = getEmailDeliveryAdapter(provider);
  if (!adapter) {
    throw new ServiceUnavailableError(
      `Provider ${provider} 的邮件回调适配器尚未配置，请先按官方协议完成适配`,
    );
  }
  const secret = String(getSetting("email_webhook_secret")?.value ?? "");
  try {
    const event = await adapter.parse(c.req.raw, secret);
    const normalized = await normalizeEmailDeliveryEvent(event);
    const result = await ingestEmailDeliveryEvent(normalized);
    return c.json({ data: result }, result.duplicate ? 200 : 202);
  } catch (error) {
    if (error instanceof EmailDeliveryAdapterError) {
      if (error.code === "EMAIL_EVENT_SIGNATURE_INVALID") {
        throw new UnauthorizedError("邮件事件签名无效", error.code);
      }
      throw new BadRequestError(error.message, error.code);
    }
    throw error;
  }
});

/** Fixture 签名格式仅供测试/本地演练导出，避免误认为厂商协议。 */
export { SignedFixtureEmailDeliveryAdapter };

export default router;
