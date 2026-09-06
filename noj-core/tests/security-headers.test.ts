import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../src/app.ts";

Deno.test("core 直连响应包含基础安全头且不伪造 HSTS", async () => {
  const response = await createApp().request("/health/live");

  assertEquals(response.headers.get("x-content-type-options"), "nosniff");
  assertEquals(response.headers.get("x-frame-options"), "DENY");
  assertEquals(
    response.headers.get("referrer-policy"),
    "strict-origin-when-cross-origin",
  );
  assertEquals(
    response.headers.get("permissions-policy"),
    "camera=(), microphone=(), geolocation=()",
  );
  assertEquals(response.headers.has("strict-transport-security"), false);
});
