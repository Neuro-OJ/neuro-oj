/**
 * 容器内 maintain 客户端单测（P1d）。
 *
 * 全部用例注入 fake fetch / 时钟 / sleep，不依赖真实网络与 Core。
 * 覆盖：成功、401、404→endpoint_unavailable、503→drain_unavailable、
 * 网络错误、无 token、wait 轮询成功与超时（not_drained）、--json 单文档输出。
 */

import { assertEquals } from "jsr:@std/assert@^1";
import {
  type MaintainFetch,
  type MaintainOptions,
  runMaintain,
} from "../../scripts/maintain.ts";

/** 采集 stdout/stderr 的测试输出器。 */
function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    write: (line: string) => stdout.push(line),
    writeError: (line: string) => stderr.push(line),
  };
}

/** 构造 JSON 响应。 */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 记录调用并按序返回响应的 fake fetch。 */
function sequentialFetch(
  responses: Array<() => Response | Promise<Response>>,
): {
  fetchImpl: MaintainFetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: MaintainFetch = (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("fake fetch 调用次数超出预期");
    return Promise.resolve(next());
  };
  return { fetchImpl, calls };
}

/** 基础注入选项（JSON 模式、显式 token/url，不读环境变量）。 */
function baseOptions(out: ReturnType<typeof capture>): MaintainOptions {
  return {
    url: "http://core:8000",
    token: "test-maintain-token",
    json: true,
    stdout: out.write,
    stderr: out.writeError,
  };
}

Deno.test("maintain: status 成功时输出单个 JSON 文档并退出 0", async () => {
  const out = capture();
  const statusData = {
    maintenance: true,
    drained: true,
    blockers: [] as string[],
    redis_ok: true,
  };
  const { fetchImpl, calls } = sequentialFetch([
    () => jsonResponse(200, { data: statusData }),
  ]);
  const code = await runMaintain("status", {
    ...baseOptions(out),
    fetchImpl,
  });
  assertEquals(code, 0);
  assertEquals(out.stdout.length, 1);
  assertEquals(JSON.parse(out.stdout[0]), { ok: true, data: statusData });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, "http://core:8000/api/v1/internal/drain/status");
  assertEquals(calls[0].init?.method, "GET");
  assertEquals(
    (calls[0].init?.headers as Record<string, string>).Authorization,
    "Bearer test-maintain-token",
  );
});

Deno.test("maintain: 401 映射 unauthorized 并退出 1", async () => {
  const out = capture();
  const { fetchImpl } = sequentialFetch([
    () =>
      jsonResponse(401, { error: "内部服务凭据无效", code: "UNAUTHORIZED" }),
  ]);
  const code = await runMaintain("status", { ...baseOptions(out), fetchImpl });
  assertEquals(code, 1);
  assertEquals(out.stdout.length, 1);
  const doc = JSON.parse(out.stdout[0]);
  assertEquals(doc.ok, false);
  assertEquals(doc.code, "unauthorized");
  assertEquals(doc.error, "内部服务凭据无效");
});

Deno.test("maintain: 404/405 映射 endpoint_unavailable（旧 Core 过渡识别）", async () => {
  for (const status of [404, 405]) {
    const out = capture();
    const { fetchImpl } = sequentialFetch([
      () => jsonResponse(status, { error: "not found" }),
    ]);
    const code = await runMaintain("status", {
      ...baseOptions(out),
      fetchImpl,
    });
    assertEquals(code, 1);
    assertEquals(JSON.parse(out.stdout[0]).code, "endpoint_unavailable");
  }
});

Deno.test("maintain: 503 drain_unavailable 与无 token 均映射 drain_unavailable", async () => {
  const out = capture();
  const { fetchImpl } = sequentialFetch([
    () => jsonResponse(503, { error: "未配置", code: "drain_unavailable" }),
  ]);
  const code = await runMaintain("status", { ...baseOptions(out), fetchImpl });
  assertEquals(code, 1);
  assertEquals(JSON.parse(out.stdout[0]).code, "drain_unavailable");

  const outNoToken = capture();
  let fetchCalled = false;
  const codeNoToken = await runMaintain("status", {
    ...baseOptions(outNoToken),
    token: "",
    fetchImpl: () => {
      fetchCalled = true;
      return Promise.resolve(jsonResponse(200, { data: {} }));
    },
  });
  assertEquals(codeNoToken, 1);
  assertEquals(fetchCalled, false);
  assertEquals(JSON.parse(outNoToken.stdout[0]).code, "drain_unavailable");
});

Deno.test("maintain: 网络错误映射 network_error", async () => {
  const out = capture();
  const code = await runMaintain("status", {
    ...baseOptions(out),
    fetchImpl: () => Promise.reject(new Error("connection refused")),
  });
  assertEquals(code, 1);
  const doc = JSON.parse(out.stdout[0]);
  assertEquals(doc.code, "network_error");
  assertEquals(doc.error.includes("connection refused"), true);
});

Deno.test("maintain: wait 轮询到 drained 后退出 0 并返回最终 status", async () => {
  const out = capture();
  const pending = {
    maintenance: true,
    drained: false,
    blockers: ["judge_queue_pending"],
  };
  const drained = {
    maintenance: true,
    drained: true,
    blockers: [] as string[],
  };
  const { fetchImpl, calls } = sequentialFetch([
    () => jsonResponse(200, { data: pending }),
    () => jsonResponse(200, { data: drained }),
  ]);
  const code = await runMaintain("wait", {
    ...baseOptions(out),
    fetchImpl,
    sleep: () => Promise.resolve(),
  });
  assertEquals(code, 0);
  assertEquals(calls.length, 2);
  assertEquals(JSON.parse(out.stdout[0]), { ok: true, data: drained });
});

Deno.test("maintain: wait 超时映射 not_drained 且附最近一次 status", async () => {
  const out = capture();
  const pending = {
    maintenance: true,
    drained: false,
    blockers: ["attempts_in_flight"],
  };
  const { fetchImpl, calls } = sequentialFetch([
    () => jsonResponse(200, { data: pending }),
  ]);
  let tick = 0;
  const code = await runMaintain("wait", {
    ...baseOptions(out),
    fetchImpl,
    timeoutSeconds: 5,
    intervalSeconds: 1,
    now: () => tick++ * 10_000,
    sleep: () => Promise.resolve(),
  });
  assertEquals(code, 1);
  assertEquals(calls.length, 1);
  const doc = JSON.parse(out.stdout[0]);
  assertEquals(doc.ok, false);
  assertEquals(["not_drained", "timeout"].includes(doc.code), true);
  assertEquals(doc.data, pending);
});

Deno.test("maintain: enter/exit 以 POST 调用对应端点", async () => {
  for (
    const [action, path] of [
      ["enter", "/api/v1/internal/drain/enter"],
      ["exit", "/api/v1/internal/drain/exit"],
    ] as const
  ) {
    const out = capture();
    const { fetchImpl, calls } = sequentialFetch([
      () => jsonResponse(200, { data: { maintenance: true, changed: true } }),
    ]);
    const code = await runMaintain(action, { ...baseOptions(out), fetchImpl });
    assertEquals(code, 0);
    assertEquals(calls[0].url, `http://core:8000${path}`);
    assertEquals(calls[0].init?.method, "POST");
    assertEquals(JSON.parse(out.stdout[0]), {
      ok: true,
      data: { maintenance: true, changed: true },
    });
  }
});

Deno.test("maintain: 人工模式输出中文进度", async () => {
  const out = capture();
  const { fetchImpl } = sequentialFetch([
    () =>
      jsonResponse(200, {
        data: {
          maintenance: true,
          drained: true,
          blockers: [],
          redis_ok: true,
          attempts: { in_flight: 0 },
          judge: { required: true, reporting: 1 },
        },
      }),
  ]);
  const code = await runMaintain("status", {
    ...baseOptions(out),
    json: false,
    fetchImpl,
  });
  assertEquals(code, 0);
  const text = out.stdout.join("\n");
  assertEquals(text.includes("维护模式"), true);
  assertEquals(text.includes("排空状态"), true);
  assertEquals(out.stderr.length, 0);
});
