import { assertEquals } from "@std/assert";
import type { HttpClient, HttpResult } from "./http.ts";
import { observabilityCheck } from "./check.ts";

function fakeHttp(routes: Record<string, HttpResult>): HttpClient {
  return {
    get(url) {
      const res = routes[url];
      if (!res) return Promise.resolve({ status: 404, body: "not found" });
      return Promise.resolve(res);
    },
    postJson(_url, _body) {
      return Promise.resolve({ status: 200, body: "" });
    },
  };
}

Deno.test("observabilityCheck: 全部通过", async () => {
  const base = "http://noj.test";
  const http = fakeHttp({
    [`${base}/health/live`]: { status: 200, body: '{"status":"alive"}' },
    [`${base}/health/ready`]: { status: 200, body: '{"status":"ready"}' },
    [`${base}/metrics`]: {
      status: 200,
      body: "noj_database_up 1\nnoj_judge_workers 2\n",
    },
  });
  const report = await observabilityCheck({ baseUrl: base, http });
  assertEquals(report.pass, true);
  assertEquals(report.items.length, 3);
});

Deno.test("observabilityCheck: readiness 失败导致整体失败", async () => {
  const base = "http://noj.test";
  const http = fakeHttp({
    [`${base}/health/live`]: { status: 200, body: '{"status":"alive"}' },
    [`${base}/health/ready`]: { status: 503, body: '{"status":"not_ready"}' },
    [`${base}/metrics`]: { status: 200, body: "noj_database_up 1\n" },
  });
  const report = await observabilityCheck({ baseUrl: base, http });
  assertEquals(report.pass, false);
  assertEquals(report.items[1]?.ok, false);
});

Deno.test("observabilityCheck: --check-notifications 验证 Alertmanager", async () => {
  const base = "http://noj.test";
  const am = "http://alertmanager:9093";
  const http = fakeHttp({
    [`${base}/health/live`]: { status: 200, body: '{"status":"alive"}' },
    [`${base}/health/ready`]: { status: 200, body: '{"status":"ready"}' },
    [`${base}/metrics`]: {
      status: 200,
      body: "noj_database_up 1\nnoj_judge_workers 2\n",
    },
    [`${am}/-/ready`]: { status: 200, body: "OK" },
  });
  const report = await observabilityCheck({
    baseUrl: base,
    checkNotifications: true,
    alertmanagerUrl: am,
    http,
  });
  assertEquals(report.pass, true);
  assertEquals(report.items.length, 4);
});
