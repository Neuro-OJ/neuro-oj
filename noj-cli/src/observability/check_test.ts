import { assertEquals } from "@std/assert";
import type { HttpClient, HttpResult } from "./http.ts";
import { observabilityCheck } from "./check.ts";

function fakeHttp(
  routes: Record<string, HttpResult>,
  failingUrls: string[] = [],
): HttpClient {
  return {
    get(url) {
      if (failingUrls.includes(url)) {
        return Promise.reject(new Error("network down"));
      }
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

Deno.test("observabilityCheck: metrics 网络失败不中断命令", async () => {
  const base = "http://noj.test";
  const http = fakeHttp({
    [`${base}/health/live`]: { status: 200, body: '{"status":"alive"}' },
    [`${base}/health/ready`]: { status: 200, body: '{"status":"ready"}' },
    [`${base}/metrics`]: { status: 200, body: "noj_database_up 1\n" },
  }, [`${base}/metrics`]);
  const report = await observabilityCheck({ baseUrl: base, http });
  assertEquals(report.pass, false);
  assertEquals(report.items[2]?.ok, false);
  assertEquals(report.items[2]?.detail.includes("访问失败"), true);
});

Deno.test("observabilityCheck: Alertmanager 网络失败不中断命令", async () => {
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
  }, [`${am}/-/ready`]);
  const report = await observabilityCheck({
    baseUrl: base,
    checkNotifications: true,
    alertmanagerUrl: am,
    http,
  });
  assertEquals(report.pass, false);
  assertEquals(report.items[3]?.ok, false);
  assertEquals(report.items[3]?.detail.includes("访问失败"), true);
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

Deno.test("observabilityCheck: 默认 baseUrl/alertmanagerUrl 从环境变量读取", async () => {
  Deno.env.set("NOJ_OBSERVABILITY_BASE_URL", "http://env-base");
  Deno.env.set("ALERTMANAGER_URL", "http://env-am");
  try {
    const http = fakeHttp({
      "http://env-base/health/live": {
        status: 200,
        body: '{"status":"alive"}',
      },
      "http://env-base/health/ready": {
        status: 200,
        body: '{"status":"ready"}',
      },
      "http://env-base/metrics": {
        status: 200,
        body: "noj_database_up 1\nnoj_judge_workers 2\n",
      },
      "http://env-am/-/ready": { status: 200, body: "OK" },
    });
    const report = await observabilityCheck({
      checkNotifications: true,
      http,
    });
    assertEquals(report.pass, true);
    assertEquals(report.items.length, 4);
  } finally {
    Deno.env.delete("NOJ_OBSERVABILITY_BASE_URL");
    Deno.env.delete("ALERTMANAGER_URL");
  }
});

Deno.test("observabilityCheck: metrics 使用行首锚定匹配", async () => {
  const base = "http://noj.test";
  const http = fakeHttp({
    [`${base}/health/live`]: { status: 200, body: '{"status":"alive"}' },
    [`${base}/health/ready`]: { status: 200, body: '{"status":"ready"}' },
    [`${base}/metrics`]: {
      status: 200,
      body:
        "prefix noj_database_up 1\nnoj_database_up 1\nprefix noj_judge_workers 2\nnoj_judge_workers 2\n",
    },
  });
  const report = await observabilityCheck({ baseUrl: base, http });
  assertEquals(report.items[2]?.ok, true);
});
