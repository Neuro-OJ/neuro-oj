/**
 * 内部维护/排空路由测试（P1d）。
 *
 * 覆盖：
 * - 凭据语义：未配置 → 503 drain_unavailable；错误 → 401；正确 → 200；
 * - enter/exit 幂等与 maintenance 设置真实变化（PGlite，不依赖真实 PG/Redis）；
 * - status 结构与 blockers（注入 fake 依赖，不依赖真实 Redis）。
 */

import { assertEquals } from "jsr:@std/assert@^1";
import { Hono } from "hono";
import { AppError } from "../../../../shared/base/errors.ts";
import { resetDbForTest } from "../../../../shared/db/connection.ts";
import type { QueueHealthResponse } from "../../../submission/index.ts";
import {
  _resetSystemSettingsForTest,
  getSetting,
  initSystemSettings,
  updateSetting,
} from "../../index.ts";
import { createInternalDrainRouter } from "../../routes/internal-drain.ts";
import type {
  DrainJudgeNode,
  DrainStatusDeps,
} from "../../services/drain-status.ts";
import {
  _resetEnvSnapshotForTest,
  snapshotEnv,
} from "../../services/env-snapshot.ts";

const TOKEN = "test-internal-drain-token-0123456789";

/** 构造带全局错误处理的测试应用（仅挂载 drain 路由）。 */
function makeApp(deps: Partial<DrainStatusDeps> = {}): Hono {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json(
        { error: error.message, code: error.code },
        error.statusCode as 401,
      );
    }
    return c.json({ error: "内部错误", code: "INTERNAL" }, 500);
  });
  app.route("/api/v1", createInternalDrainRouter(deps));
  return app;
}

/** 内部凭据请求头。 */
function authHeaders(token = TOKEN): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

/** 设置测试凭据并返回恢复函数（含 env 快照重置）。 */
function useToken(token = TOKEN): () => void {
  const previous = Deno.env.get("NOJ_INTERNAL_SERVICE_TOKEN");
  Deno.env.set("NOJ_INTERNAL_SERVICE_TOKEN", token);
  _resetEnvSnapshotForTest();
  snapshotEnv();
  return () => {
    if (previous === undefined) Deno.env.delete("NOJ_INTERNAL_SERVICE_TOKEN");
    else Deno.env.set("NOJ_INTERNAL_SERVICE_TOKEN", previous);
    _resetEnvSnapshotForTest();
    snapshotEnv();
  };
}

/** 空队列条目。 */
function emptyEntry() {
  return { queue_length: 0, processing_length: 0, dead_length: 0 };
}

/** 干净队列健康。 */
function cleanQueues(): QueueHealthResponse {
  return { judge: emptyEntry(), result: emptyEntry(), redis_ok: true };
}

/** 默认可排空的注入依赖（maintenance 读真实设置）。 */
function drainDeps(
  overrides: Partial<DrainStatusDeps> = {},
): Partial<DrainStatusDeps> {
  return {
    getMaintenance: () => getSetting("maintenance_mode")?.value === true,
    getQueueHealth: () => Promise.resolve(cleanQueues()),
    countInFlightAttempts: () => Promise.resolve(0),
    readJudgeNodeReports: () =>
      Promise.resolve([{
        instance_id: "judge-1",
        judge_version: "0.10.5",
        active_tasks: 0,
        max_concurrent_tasks: 4,
      }]),
    judgeRequired: () => true,
    now: () => "2026-10-20T00:00:00.000Z",
    ...overrides,
  };
}

Deno.test({
  name:
    "internal-drain: 未配置凭据返回 503 drain_unavailable，错误凭据返回 401",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const previous = Deno.env.get("NOJ_INTERNAL_SERVICE_TOKEN");
    Deno.env.delete("NOJ_INTERNAL_SERVICE_TOKEN");
    _resetEnvSnapshotForTest();
    snapshotEnv();
    try {
      const app = makeApp();
      for (
        const [method, path] of [
          ["GET", "/api/v1/internal/drain/status"],
          ["POST", "/api/v1/internal/drain/enter"],
          ["POST", "/api/v1/internal/drain/exit"],
        ] as const
      ) {
        const res = await app.request(path, { method });
        assertEquals(res.status, 503, `未配置凭据时 ${method} ${path}`);
        const body = await res.json();
        assertEquals(body.code, "drain_unavailable");
      }

      Deno.env.set("NOJ_INTERNAL_SERVICE_TOKEN", TOKEN);
      const statusPath = "/api/v1/internal/drain/status";
      // 长度不同与长度相同（走 timingSafeEqual）两种错误凭据都必须 401
      for (const wrong of ["bad", "x".repeat(TOKEN.length)]) {
        const res = await app.request(statusPath, {
          headers: authHeaders(wrong),
        });
        assertEquals(res.status, 401);
        assertEquals((await res.json()).code, "UNAUTHORIZED");
      }
      const ok = await app.request(statusPath, { headers: authHeaders() });
      assertEquals(ok.status, 200);
    } finally {
      if (previous === undefined) {
        Deno.env.delete("NOJ_INTERNAL_SERVICE_TOKEN");
      } else {
        Deno.env.set("NOJ_INTERNAL_SERVICE_TOKEN", previous);
      }
      _resetEnvSnapshotForTest();
      snapshotEnv();
    }
  },
});

Deno.test({
  name: "internal-drain: enter/exit 幂等并真实切换 maintenance 设置",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const restoreToken = useToken();
    await resetDbForTest();
    _resetSystemSettingsForTest();
    await initSystemSettings();
    try {
      const app = makeApp(drainDeps());
      const post = (path: string) =>
        app.request(path, { method: "POST", headers: authHeaders() });

      const firstEnter = await post("/api/v1/internal/drain/enter");
      assertEquals(firstEnter.status, 200);
      assertEquals(await firstEnter.json(), {
        data: { maintenance: true, changed: true },
      });
      assertEquals(getSetting("maintenance_mode")?.value, true);

      const secondEnter = await post("/api/v1/internal/drain/enter");
      assertEquals(await secondEnter.json(), {
        data: { maintenance: true, changed: false },
      });

      const statusWhileOn = await app.request(
        "/api/v1/internal/drain/status",
        { headers: authHeaders() },
      );
      assertEquals(statusWhileOn.status, 200);
      const onBody = await statusWhileOn.json();
      assertEquals(onBody.data.maintenance, true);
      assertEquals(onBody.data.drained, true);
      assertEquals(onBody.data.blockers, []);
      assertEquals(
        statusWhileOn.headers.get("Cache-Control"),
        "no-store",
      );

      const firstExit = await post("/api/v1/internal/drain/exit");
      assertEquals(await firstExit.json(), {
        data: { maintenance: false, changed: true },
      });
      assertEquals(getSetting("maintenance_mode")?.value, false);
      const secondExit = await post("/api/v1/internal/drain/exit");
      assertEquals(await secondExit.json(), {
        data: { maintenance: false, changed: false },
      });

      const statusWhileOff = await app.request(
        "/api/v1/internal/drain/status",
        { headers: authHeaders() },
      );
      const offBody = await statusWhileOff.json();
      assertEquals(offBody.data.maintenance, false);
      assertEquals(offBody.data.drained, false);
      assertEquals(offBody.data.blockers, ["maintenance_off"]);
    } finally {
      if (getSetting("maintenance_mode")?.value === true) {
        await updateSetting("maintenance_mode", false, "0");
      }
      restoreToken();
    }
  },
});

Deno.test({
  name: "internal-drain: status 结构完整且 blockers 覆盖队列/尝试/judge",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const restoreToken = useToken();
    try {
      const nodes: DrainJudgeNode[] = [{
        instance_id: "judge-a",
        judge_version: "0.10.5",
        scheduling_version: 1,
        resource_group: "g1",
        active_tasks: 2,
        max_concurrent_tasks: 4,
        updated_at_ms: 123,
      }];
      const queues: QueueHealthResponse = {
        judge: { queue_length: 1, processing_length: 2, dead_length: 7 },
        result: { queue_length: 3, processing_length: 4, dead_length: 9 },
        redis_ok: true,
      };
      const app = makeApp({
        getMaintenance: () => true,
        getQueueHealth: () => Promise.resolve(queues),
        countInFlightAttempts: () => Promise.resolve(2),
        readJudgeNodeReports: () => Promise.resolve(nodes),
        judgeRequired: () => true,
        now: () => "2026-10-20T00:00:00.000Z",
      });
      const res = await app.request("/api/v1/internal/drain/status", {
        headers: authHeaders(),
      });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.data.maintenance, true);
      assertEquals(body.data.drained, false);
      assertEquals(body.data.blockers, [
        "judge_queue_pending",
        "judge_queue_processing",
        "result_queue_pending",
        "result_queue_processing",
        "attempts_in_flight",
        "judge_tasks_active",
      ]);
      assertEquals(body.data.checked_at, "2026-10-20T00:00:00.000Z");
      assertEquals(body.data.redis_ok, true);
      assertEquals(body.data.queues, queues);
      assertEquals(body.data.attempts, { in_flight: 2 });
      assertEquals(body.data.judge.required, true);
      assertEquals(body.data.judge.reporting, 1);
      assertEquals(body.data.judge.nodes, nodes);

      // judge 必需但无 worker 上报 → judge_workers_missing（其余依赖用干净 fake，
      // 避免落到保守降级默认值而引入 redis_unavailable）
      const missingApp = makeApp({
        getMaintenance: () => true,
        getQueueHealth: () => Promise.resolve(cleanQueues()),
        readJudgeNodeReports: () => Promise.resolve([]),
        judgeRequired: () => true,
      });
      const missingBody = await (await missingApp.request(
        "/api/v1/internal/drain/status",
        { headers: authHeaders() },
      )).json();
      assertEquals(missingBody.data.blockers, ["judge_workers_missing"]);
      assertEquals(missingBody.data.judge.reporting, 0);
    } finally {
      restoreToken();
    }
  },
});
