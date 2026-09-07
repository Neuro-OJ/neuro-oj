import { assertEquals } from "@std/assert";
import type { HttpClient } from "./http.ts";
import { alertDrill } from "./alert_drill.ts";

function recordingHttp(calls: { url: string; body: string }[]): HttpClient {
  return {
    get(url) {
      return Promise.resolve({ status: 200, body: url });
    },
    postJson(url, body) {
      calls.push({ url, body });
      return Promise.resolve({ status: 200, body: "" });
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
