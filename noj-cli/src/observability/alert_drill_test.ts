import { assertEquals, assertRejects } from "@std/assert";
import type { HttpClient, HttpResult } from "./http.ts";
import { alertDrill } from "./alert_drill.ts";

function recordingHttp(
  calls: { url: string; body: string }[],
  results: Array<HttpResult | Error> = [],
): HttpClient {
  let idx = 0;
  return {
    get(url) {
      return Promise.resolve({ status: 200, body: url });
    },
    postJson(url, body) {
      calls.push({ url, body });
      const item = results[idx++] ?? { status: 200, body: "" };
      if (item instanceof Error) return Promise.reject(item);
      return Promise.resolve(item);
    },
  };
}

Deno.test("alertDrill: 注入并恢复告警", async () => {
  const calls: { url: string; body: string }[] = [];
  const http = recordingHttp(calls);
  const report = await alertDrill({
    alertmanagerUrl: "http://alertmanager:9093",
    holdSeconds: 0,
    http,
  });
  assertEquals(report.injected, true);
  assertEquals(report.resolved, true);
  assertEquals(calls.length, 2);
  assertEquals(calls[0]?.url, "http://alertmanager:9093/api/v2/alerts");
  assertEquals(calls[1]?.url, "http://alertmanager:9093/api/v2/alerts");
  assertEquals(calls[0]?.body.includes("NojNotificationDrill"), true);
});

Deno.test("alertDrill: 首次恢复失败后二次恢复成功", async () => {
  const calls: { url: string; body: string }[] = [];
  const http = recordingHttp(calls, [
    { status: 200, body: "" },
    { status: 500, body: "boom" },
    { status: 200, body: "" },
  ]);
  const report = await alertDrill({
    alertmanagerUrl: "http://alertmanager:9093",
    holdSeconds: 0,
    http,
  });
  assertEquals(report.resolved, true);
  assertEquals(calls.length, 3);
});

Deno.test("alertDrill: 恢复持续失败时报错并提示手动清理", async () => {
  const calls: { url: string; body: string }[] = [];
  const http = recordingHttp(calls, [
    { status: 200, body: "" },
    { status: 500, body: "boom" },
    new Error("network down"),
  ]);
  await assertRejects(
    () =>
      alertDrill({
        alertmanagerUrl: "http://alertmanager:9093",
        holdSeconds: 0,
        http,
      }),
    Error,
    "手动清理",
  );
  assertEquals(calls.length, 3);
});

Deno.test("alertDrill: 默认 alertmanagerUrl 从 ALERTMANAGER_URL 读取", async () => {
  Deno.env.set("ALERTMANAGER_URL", "http://env-am:9093");
  try {
    const calls: { url: string; body: string }[] = [];
    const http = recordingHttp(calls);
    const report = await alertDrill({ holdSeconds: 0, http });
    assertEquals(report.resolved, true);
    assertEquals(calls[0]?.url, "http://env-am:9093/api/v2/alerts");
  } finally {
    Deno.env.delete("ALERTMANAGER_URL");
  }
});
