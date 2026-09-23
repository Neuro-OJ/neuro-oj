/**
 * TSA（RFC 3161 时间戳）Provider 测试。
 *
 * 覆盖：disabled 返回 null、未配置端点返回 null、成功解析 token+chain、
 * 网络错误/非 2xx 返回 null 且不抛（不阻塞发布）。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { resetDbForTest } from "../../../../shared/db/connection.ts";
import { updateSetting } from "./../../../system/services/system-settings.ts";
import { timestampHash, tsaEnabled } from "../../index.ts";

/** 临时替换全局 fetch。 */
function withFetch(
  impl: typeof fetch,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

Deno.test({
  name: "tsa: disabled 时 tsaEnabled=false 且不打戳",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    await updateSetting("tsa_provider", "disabled", "0");
    assertEquals(tsaEnabled(), false);
    assertEquals(await timestampHash("ab".repeat(32)), null);
  },
});

Deno.test({
  name: "tsa: 未配置自定义端点时返回 null",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    await updateSetting("tsa_provider", "custom", "0");
    await updateSetting("tsa_url", "", "0");
    assertEquals(tsaEnabled(), true);
    assertEquals(await timestampHash("ab".repeat(32)), null);
  },
});

Deno.test({
  name: "tsa: 成功时返回 token 与证书链",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    await updateSetting("tsa_provider", "custom", "0");
    await updateSetting("tsa_url", "https://tsa.example.test/tsr", "0");

    await withFetch(
      (() =>
        Promise.resolve(
          new Response(new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x01]), {
            status: 200,
            headers: { "Content-Type": "application/timestamp-reply" },
          }),
        )) as typeof fetch,
      async () => {
        const result = await timestampHash("ab".repeat(32));
        assertEquals(result?.provider, "custom");
        assertEquals(typeof result?.token, "string");
        assertEquals(result!.token.length > 0, true);
        assertEquals(typeof result?.chain, "string");
      },
    );
  },
});

Deno.test({
  name: "tsa: 网络错误返回 null 且不抛",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    await updateSetting("tsa_provider", "custom", "0");
    await updateSetting("tsa_url", "https://tsa.example.test/tsr", "0");

    await withFetch(
      (() => Promise.reject(new Error("network down"))) as typeof fetch,
      async () => {
        assertEquals(await timestampHash("ab".repeat(32)), null);
      },
    );
  },
});

Deno.test({
  name: "tsa: 非 2xx 返回 null",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    await updateSetting("tsa_provider", "custom", "0");
    await updateSetting("tsa_url", "https://tsa.example.test/tsr", "0");

    await withFetch(
      (() =>
        Promise.resolve(new Response("nope", { status: 500 }))) as typeof fetch,
      async () => {
        assertEquals(await timestampHash("ab".repeat(32)), null);
      },
    );
  },
});
