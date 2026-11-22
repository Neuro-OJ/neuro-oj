import {
  type EmailDeliveryAdapter,
  EmailDeliveryAdapterError,
  type EmailDeliveryEvent,
  type EmailDeliveryEventType,
} from "./types.ts";

const MAX_CLOCK_SKEW_SECONDS = 300;
const MAX_BODY_BYTES = 32 * 1024;
const EVENT_TYPES = new Set<EmailDeliveryEventType>([
  "delivery",
  "temporary_failure",
  "permanent_bounce",
  "complaint",
]);

async function verifySignature(
  body: string,
  secret: string,
  timestamp: string,
  signature: string,
): Promise<boolean> {
  const timestampSeconds = Number(timestamp);
  if (!Number.isInteger(timestampSeconds)) return false;
  if (Math.abs(Date.now() / 1000 - timestampSeconds) > MAX_CLOCK_SKEW_SECONDS) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const expected = signature.startsWith("sha256=")
    ? signature.slice("sha256=".length)
    : signature;
  let encoded: Uint8Array;
  try {
    encoded = expected.match(/^[0-9a-f]{64}$/i)
      ? Uint8Array.from(
        expected.match(/.{2}/g)!.map((part) => parseInt(part, 16)),
      )
      : Uint8Array.from(atob(expected), (char) => char.charCodeAt(0));
  } catch {
    return false;
  }
  return await crypto.subtle.verify(
    "HMAC",
    key,
    encoded as unknown as BufferSource,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
}

/**
 * 仅供 fixture/本地演练使用的通用签名 JSON 适配器。
 *
 * 它不是阿里云或腾讯云协议实现；真实 Provider 必须提供自己的 adapter，
 * 以官方字段和签名文档替换本适配器，避免把猜测的 webhook 暴露到生产。
 */
export class SignedFixtureEmailDeliveryAdapter implements EmailDeliveryAdapter {
  readonly provider = "fixture";

  async parse(request: Request, secret: string): Promise<EmailDeliveryEvent> {
    if (!secret) {
      throw new EmailDeliveryAdapterError("fixture webhook secret 未配置");
    }
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
      throw new EmailDeliveryAdapterError("邮件事件请求体过大");
    }
    const timestamp = request.headers.get("x-noj-timestamp") ?? "";
    const signature = request.headers.get("x-noj-signature") ?? "";
    const providerEventId = request.headers.get("x-noj-event-id") ?? "";
    if (!timestamp || !signature || !providerEventId) {
      throw new EmailDeliveryAdapterError("邮件事件缺少签名、时间戳或事件 ID");
    }
    if (!(await verifySignature(body, secret, timestamp, signature))) {
      throw new EmailDeliveryAdapterError(
        "邮件事件签名无效",
        "EMAIL_EVENT_SIGNATURE_INVALID",
      );
    }

    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(body) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not object");
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      throw new EmailDeliveryAdapterError("邮件事件 JSON 无效");
    }
    const type = payload.type;
    const email = typeof payload.email === "string"
      ? payload.email.trim().toLowerCase()
      : "";
    const occurredAt = typeof payload.occurred_at === "string"
      ? payload.occurred_at
      : new Date(Number(timestamp) * 1000).toISOString();
    if (
      typeof type !== "string" ||
      !EVENT_TYPES.has(type as EmailDeliveryEventType) ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      !Number.isFinite(Date.parse(occurredAt))
    ) {
      throw new EmailDeliveryAdapterError("邮件事件字段无效");
    }
    return {
      provider: this.provider,
      providerEventId,
      type: type as EmailDeliveryEventType,
      email,
      occurredAt: new Date(occurredAt).toISOString(),
      reasonCode: typeof payload.reason_code === "string"
        ? payload.reason_code.slice(0, 128)
        : undefined,
      reason: typeof payload.reason === "string"
        ? payload.reason.slice(0, 512)
        : undefined,
    };
  }
}

/** 生产 Provider 协议未确认前，只注册 fixture；aliyun/tencent 明确返回 null。 */
export function getEmailDeliveryAdapter(
  provider: string,
): EmailDeliveryAdapter | null {
  return provider === "fixture"
    ? new SignedFixtureEmailDeliveryAdapter()
    : null;
}
