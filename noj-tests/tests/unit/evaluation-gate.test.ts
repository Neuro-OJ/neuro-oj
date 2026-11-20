/**
 * 显式同步屏障客户端的零依赖单测。
 *
 * 契约主体用真实本地 Python 协调服务验证（并发等待、nonce 去重、取消、超时、
 * 服务缺失），错误分类与地址校验用注入 fetch 覆盖。
 *
 * 运行：deno test -A noj-tests/tests/unit/evaluation-gate.test.ts
 */

import {
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "jsr:@std/assert@^1.0.13";
import {
  createEvaluationGate,
  DEFAULT_EVALUATION_GATE_EVALUATOR_URL,
  DEFAULT_EVALUATION_GATE_HOST_URL,
  deleteEvaluationGate,
  EVALUATION_GATE_WAIT_LIMIT_MS,
  EvaluationGateError,
  type EvaluationGatePlacement,
  readEvaluationGate,
  releaseEvaluationGate,
  resolveEvaluationGatePlacement,
  waitForEvaluationGate,
  waitForEvaluationGateArrival,
} from "../../fixtures/evaluation-gate.ts";

const COORDINATOR_SCRIPT = new URL(
  "../../../scripts/e2e/test_coordinator.py",
  import.meta.url,
).pathname;

interface RunningCoordinator {
  placement: EvaluationGatePlacement;
  stop(): Promise<void>;
}

/** 启动真实本地协调服务；端口 0 由系统分配，地址从标准输出读取。 */
async function startCoordinator(): Promise<RunningCoordinator> {
  const child = new Deno.Command("python3", {
    args: ["-B", COORDINATOR_SCRIPT, "--host", "127.0.0.1", "--port", "0"],
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const stdout = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!buffer.includes("\n")) {
      const { value, done } = await stdout.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
  } finally {
    await stdout.cancel();
  }
  const match = buffer.match(/listening on (http:\/\/\S+)/);
  if (!match) {
    child.kill("SIGTERM");
    await child.status;
    throw new Error(`协调服务未打印监听地址：${buffer}`);
  }
  const hostUrl = match[1];
  return {
    placement: { hostUrl, evaluatorUrl: DEFAULT_EVALUATION_GATE_EVALUATOR_URL },
    async stop() {
      child.kill("SIGTERM");
      await child.status;
    },
  };
}

async function withCoordinator(
  fn: (coordinator: RunningCoordinator) => Promise<void>,
): Promise<void> {
  const coordinator = await startCoordinator();
  try {
    await fn(coordinator);
  } finally {
    await coordinator.stop();
  }
}

function waitUntil<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 5_000,
): Promise<T> {
  return (async () => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await read();
      if (done(value)) return value;
      if (Date.now() >= deadline) {
        throw new Error(`等待条件超时（${timeoutMs}ms）`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  })();
}

Deno.test("evaluation-gate: 默认地址主机侧 loopback、evaluator 侧为容器网络地址", () => {
  const placement = resolveEvaluationGatePlacement(() => undefined);
  assertEquals(placement.hostUrl, DEFAULT_EVALUATION_GATE_HOST_URL);
  assertEquals(
    placement.hostUrl.startsWith("http://127.0.0.1:"),
    true,
    "管理地址必须是 loopback",
  );
  assertEquals(placement.evaluatorUrl, DEFAULT_EVALUATION_GATE_EVALUATOR_URL);
  assertEquals(
    placement.evaluatorUrl.includes("127.0.0.1"),
    false,
    "不能把主机 loopback 写进 evaluator 地址",
  );
  assertEquals(
    resolveEvaluationGatePlacement((key) =>
      key === "E2E_TEST_COORDINATOR_URL" ? "http://localhost:9000/" : undefined
    ).hostUrl,
    "http://localhost:9000",
    "允许 localhost 且去掉尾部斜杠",
  );
});

Deno.test("evaluation-gate: 管理地址不是 loopback 时拒绝启动", () => {
  const error = assertThrowsGateError(
    () =>
      resolveEvaluationGatePlacement((key) =>
        key === "E2E_TEST_COORDINATOR_URL"
          ? "http://noj-e2e-test-coordinator:8010"
          : undefined
      ),
  );
  assertEquals(error.kind, "configuration");
});

function assertThrowsGateError(fn: () => unknown): EvaluationGateError {
  try {
    fn();
  } catch (error) {
    if (error instanceof EvaluationGateError) return error;
    throw error;
  }
  throw new Error("预期抛出 EvaluationGateError");
}

Deno.test("evaluation-gate: 创建/读取/重复创建 409/删除后 404", async () => {
  await withCoordinator(async ({ placement }) => {
    const gateId = `unit-lifecycle-${crypto.randomUUID()}`;
    const created = await createEvaluationGate(placement, {
      id: gateId,
      runId: gateId,
    });
    assertEquals(created.id, gateId);
    assertEquals(created.arrivals, 0);
    assertEquals(created.released, false);
    assertEquals(created.cancelled, false);

    const conflict = await assertRejects(
      () => createEvaluationGate(placement, { id: gateId, runId: gateId }),
      EvaluationGateError,
    );
    assertEquals(conflict.kind, "conflict");

    assertEquals((await readEvaluationGate(placement, gateId)).arrivals, 0);
    const missing = await assertRejects(
      () => readEvaluationGate(placement, "unit-missing"),
      EvaluationGateError,
    );
    assertEquals(missing.kind, "missing");

    await deleteEvaluationGate(placement, gateId);
    const deleted = await assertRejects(
      () => readEvaluationGate(placement, gateId),
      EvaluationGateError,
    );
    assertEquals(deleted.kind, "missing");
  });
});

Deno.test("evaluation-gate: 两个并发等待都能被 release 唤醒（服务必须多线程）", async () => {
  await withCoordinator(async ({ placement }) => {
    const gateId = `unit-concurrent-${crypto.randomUUID()}`;
    await createEvaluationGate(placement, { id: gateId, runId: gateId });
    const first = waitForEvaluationGate(placement, {
      id: gateId,
      arrival: "arrival-one",
    });
    const second = waitForEvaluationGate(placement, {
      id: gateId,
      arrival: "arrival-two",
    });
    const arrived = await waitUntil(
      () => readEvaluationGate(placement, gateId),
      (status) => status.arrivals === 2,
    );
    assertEquals(arrived.released, false);
    // 等待请求阻塞时读取仍能返回，否则说明服务被单线程阻塞。
    const released = await releaseEvaluationGate(placement, gateId);
    assertEquals(released.released, true);
    const results = await Promise.all([first, second]);
    for (const result of results) {
      assertEquals(result.released, true);
      assertEquals(result.timedOut, false);
      assertEquals(result.arrivals, 2);
    }
    // 幂等释放 + 已释放的 gate 立即通过。
    assertEquals(
      (await releaseEvaluationGate(placement, gateId)).released,
      true,
    );
    const startedAt = Date.now();
    const later = await waitForEvaluationGate(placement, {
      id: gateId,
      arrival: "arrival-three",
    });
    assertEquals(later.released, true);
    assertEquals(later.arrivals, 3);
    assertEquals(
      Date.now() - startedAt < 2_000,
      true,
      "已释放的 gate 必须立即通过",
    );
    await deleteEvaluationGate(placement, gateId);
  });
});

Deno.test("evaluation-gate: 相同 nonce 不重复计数", async () => {
  await withCoordinator(async ({ placement }) => {
    const gateId = `unit-nonce-${crypto.randomUUID()}`;
    await createEvaluationGate(placement, { id: gateId, runId: gateId });
    const first = waitForEvaluationGate(placement, {
      id: gateId,
      arrival: "same-nonce",
    });
    const second = waitForEvaluationGate(placement, {
      id: gateId,
      arrival: "same-nonce",
    });
    const arrived = await waitUntil(
      () => readEvaluationGate(placement, gateId),
      (status) => status.arrivals >= 1,
    );
    // 第二个等待已发出但 nonce 相同：仍只计 1 次到达。
    await new Promise((resolve) => setTimeout(resolve, 200));
    assertEquals((await readEvaluationGate(placement, gateId)).arrivals, 1);
    assertEquals(arrived.arrivals, 1);
    await releaseEvaluationGate(placement, gateId);
    const results = await Promise.all([first, second]);
    for (const result of results) assertEquals(result.arrivals, 1);
    await deleteEvaluationGate(placement, gateId);
  });
});

Deno.test("evaluation-gate: 等待超时与 45 秒上限", async () => {
  assertEquals(EVALUATION_GATE_WAIT_LIMIT_MS, 45_000);
  await withCoordinator(async ({ placement }) => {
    const gateId = `unit-timeout-${crypto.randomUUID()}`;
    await createEvaluationGate(placement, { id: gateId, runId: gateId });
    const error = await assertRejects(
      () =>
        waitForEvaluationGate(
          placement,
          { id: gateId, arrival: "slow" },
          { timeoutMs: 300 },
        ),
      EvaluationGateError,
    );
    assertEquals(error.kind, "timeout");
    const status = await readEvaluationGate(placement, gateId);
    assertEquals(status.released, false);
    assertEquals(status.cancelled, false);
    assertEquals(status.arrivals, 1);
    await deleteEvaluationGate(placement, gateId);
  });
});

Deno.test("evaluation-gate: 等待到达超时报 timeout，删除后报 missing", async () => {
  await withCoordinator(async ({ placement }) => {
    const gateId = `unit-arrival-${crypto.randomUUID()}`;
    await createEvaluationGate(placement, { id: gateId, runId: gateId });
    const error = await assertRejects(
      () => waitForEvaluationGateArrival(placement, gateId, { timeoutMs: 300 }),
      EvaluationGateError,
    );
    assertEquals(error.kind, "timeout");
    const missing = await assertRejects(
      () => waitForEvaluationGateArrival(placement, "unit-missing-gate"),
      EvaluationGateError,
    );
    assertEquals(
      missing.kind,
      "missing",
      "gate 不存在必须立即失败，不能当成超时",
    );
    await deleteEvaluationGate(placement, gateId);
  });
});

Deno.test("evaluation-gate: DELETE 取消等待者并清理", async () => {
  await withCoordinator(async ({ placement }) => {
    const gateId = `unit-cancel-${crypto.randomUUID()}`;
    await createEvaluationGate(placement, { id: gateId, runId: gateId });
    const waiting = waitForEvaluationGate(
      placement,
      { id: gateId, arrival: "cancelled-arrival" },
      { timeoutMs: 10_000 },
    );
    await waitUntil(
      () => readEvaluationGate(placement, gateId),
      (status) => status.arrivals === 1,
    );
    await deleteEvaluationGate(placement, gateId);
    const error = await assertRejects(() => waiting, EvaluationGateError);
    assertEquals(error.kind, "cancelled");
    const missing = await assertRejects(
      () => readEvaluationGate(placement, gateId),
      EvaluationGateError,
    );
    assertEquals(missing.kind, "missing");
  });
});

Deno.test("evaluation-gate: AbortSignal 取消等待", async () => {
  await withCoordinator(async ({ placement }) => {
    const gateId = `unit-abort-${crypto.randomUUID()}`;
    await createEvaluationGate(placement, { id: gateId, runId: gateId });
    const controller = new AbortController();
    const waiting = waitForEvaluationGate(
      placement,
      { id: gateId, arrival: "aborted-arrival" },
      { timeoutMs: 2_000, signal: controller.signal },
    );
    await waitUntil(
      () => readEvaluationGate(placement, gateId),
      (status) => status.arrivals === 1,
    );
    controller.abort();
    const error = await assertRejects(() => waiting, EvaluationGateError);
    assertEquals(error.kind, "cancelled");
    await releaseEvaluationGate(placement, gateId);
    await deleteEvaluationGate(placement, gateId);
  });
});

Deno.test("evaluation-gate: 协调服务缺失分类为 unavailable", async () => {
  const coordinator = await startCoordinator();
  await coordinator.stop();
  const error = await assertRejects(
    () =>
      createEvaluationGate(coordinator.placement, {
        id: "down",
        runId: "down",
      }),
    EvaluationGateError,
  );
  assertEquals(error.kind, "unavailable");
});

Deno.test("evaluation-gate: 注入 fetch 覆盖协议错误分类", async () => {
  const placement: EvaluationGatePlacement = {
    hostUrl: "http://127.0.0.1:1",
    evaluatorUrl: DEFAULT_EVALUATION_GATE_EVALUATOR_URL,
  };
  const serverError = await assertRejects(
    () =>
      readEvaluationGate(placement, "any", {
        fetchImpl: () =>
          Promise.resolve(new Response("<html>", { status: 500 })),
      }),
    EvaluationGateError,
  );
  assertEquals(serverError.kind, "protocol");
  assertEquals(serverError.status, 500);

  const badJson = await assertRejects(
    () =>
      readEvaluationGate(placement, "any", {
        fetchImpl: () =>
          Promise.resolve(new Response("not json", { status: 200 })),
      }),
    EvaluationGateError,
  );
  assertEquals(badJson.kind, "protocol");

  const network = await assertRejects(
    () =>
      readEvaluationGate(placement, "any", {
        fetchImpl: () => Promise.reject(new TypeError("connection refused")),
      }),
    EvaluationGateError,
  );
  assertEquals(network.kind, "unavailable");

  const missing = await assertRejects(
    () =>
      readEvaluationGate(placement, "any", {
        fetchImpl: () =>
          Promise.resolve(
            new Response(JSON.stringify({ error: "gate 不存在" }), {
              status: 404,
            }),
          ),
      }),
    EvaluationGateError,
  );
  assertEquals(missing.kind, "missing");

  const invalidPayload = await assertRejects(
    () =>
      readEvaluationGate(placement, "any", {
        fetchImpl: () =>
          Promise.resolve(
            new Response(JSON.stringify({ id: 1 }), { status: 200 }),
          ),
      }),
    EvaluationGateError,
  );
  assertEquals(invalidPayload.kind, "protocol");

  assertNotEquals(EVALUATION_GATE_WAIT_LIMIT_MS, 60_000);
});
