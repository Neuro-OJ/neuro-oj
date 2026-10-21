import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  SignedFixtureEmailDeliveryAdapter,
} from "../../services/email-delivery/fixture-adapter.ts";
import {
  clearEmailSuppression,
  hashEmail,
  ingestEmailDeliveryEvent,
  isEmailSuppressed,
  listEmailSuppressions,
  maskEmail,
  normalizeEmailDeliveryEvent,
} from "../../services/email-delivery/service.ts";
import { EmailDeliveryAdapterError } from "../../services/email-delivery/types.ts";

async function signFixture(
  body: string,
  secret: string,
  timestamp: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

Deno.test("email delivery: 地址只生成稳定哈希和脱敏值", async () => {
  assertEquals(
    await hashEmail(" User@Example.COM "),
    await hashEmail("user@example.com"),
  );
  assertEquals(maskEmail("User@Example.COM"), "u***@example.com");
});

Deno.test("email delivery: fixture 适配器验证签名、时间戳和事件字段", async () => {
  const adapter = new SignedFixtureEmailDeliveryAdapter();
  const secret = "fixture-secret";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({
    type: "permanent_bounce",
    email: "bad@example.com",
    reason_code: "mailbox_not_found",
  });
  const signature = await signFixture(body, secret, timestamp);
  const request = new Request("http://localhost/email-events/fixture", {
    method: "POST",
    body,
    headers: {
      "x-noj-timestamp": timestamp,
      "x-noj-signature": signature,
      "x-noj-event-id": "evt-1",
    },
  });
  const invalidRequest = request.clone();
  const event = await adapter.parse(request, secret);
  assertEquals(event.provider, "fixture");
  assertEquals(event.type, "permanent_bounce");
  assertEquals(event.providerEventId, "evt-1");

  await assertRejects(
    () => adapter.parse(invalidRequest, "wrong-secret"),
    EmailDeliveryAdapterError,
    "签名无效",
  );
});

Deno.test("email delivery: 永久退信建立抑制且重复事件幂等", async () => {
  const event = await normalizeEmailDeliveryEvent({
    provider: "fixture",
    providerEventId: `evt-${crypto.randomUUID()}`,
    type: "permanent_bounce",
    email: "bounce@example.com",
    occurredAt: new Date().toISOString(),
    reasonCode: "mailbox_not_found",
  });
  const first = await ingestEmailDeliveryEvent(event);
  const duplicate = await ingestEmailDeliveryEvent(event);
  assertEquals(first, { duplicate: false, suppressed: true });
  assertEquals(duplicate, { duplicate: true, suppressed: true });
  assertEquals(await isEmailSuppressed("bounce@example.com"), true);

  const rows = await listEmailSuppressions();
  const row = rows.find((item) => item.recipient_masked === "b***@example.com");
  assert(row);
  assertEquals(await clearEmailSuppression(row.id, "admin-test"), true);
  assertEquals(await isEmailSuppressed("bounce@example.com"), false);
});

Deno.test("email delivery: 临时失败不建立永久抑制", async () => {
  const event = await normalizeEmailDeliveryEvent({
    provider: "fixture",
    providerEventId: `evt-${crypto.randomUUID()}`,
    type: "temporary_failure",
    email: "temporary@example.com",
    occurredAt: new Date().toISOString(),
  });
  const result = await ingestEmailDeliveryEvent(event);
  assertEquals(result.suppressed, false);
  assertEquals(await isEmailSuppressed("temporary@example.com"), false);
});
