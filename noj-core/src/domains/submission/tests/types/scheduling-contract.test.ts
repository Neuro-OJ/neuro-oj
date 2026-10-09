import { assertEquals } from "jsr:@std/assert@^1";
import { normalizePoolTask } from "../../mq/pool-judge-queue.ts";
import { buildJudgeQueues } from "../../../../shared/mq/judge-queues.ts";
import { judgeResourcePool } from "../../types/index.ts";
import { matchingResourceWaitReason } from "../../services/queue.ts";
import fixture from "../../../../../../noj-tests/fixtures/judge-task.contract.json" with {
  type: "json",
};
import oiFixture from "../../../../../../noj-tests/fixtures/judge-task-oi.contract.json" with {
  type: "json",
};
import type { ProblemRuntimeConfig } from "../../../catalog/index.ts";

Deno.test("等待原因：评测轮次隔离，不接受未知原因或旧消息", () => {
  const task = { run_id: "current", rejudge_seq: 2 };
  assertEquals(
    matchingResourceWaitReason(task, { ...task, reason: "memory" }),
    "memory",
  );
  assertEquals(
    matchingResourceWaitReason(task, { ...task, reason: "user_busy" }),
    "user_busy",
  );
  assertEquals(
    matchingResourceWaitReason(task, {
      ...task,
      run_id: "old",
      reason: "memory",
    }),
    null,
  );
  assertEquals(
    matchingResourceWaitReason(task, {
      ...task,
      rejudge_seq: 1,
      reason: "memory",
    }),
    null,
  );
  assertEquals(
    matchingResourceWaitReason(task, { ...task, reason: "arbitrary" }),
    null,
  );
  assertEquals(matchingResourceWaitReason(task, null), null);
});

Deno.test("调度契约：资源池只由规范化后端推导，三级优先级名称保持对应", () => {
  assertEquals(judgeResourcePool(fixture.runtime_config), "ai");
  assertEquals(
    judgeResourcePool(oiFixture.runtime_config as ProblemRuntimeConfig),
    "oi-wasm",
  );
  assertEquals(
    judgeResourcePool(
      {
        ...oiFixture.runtime_config,
        backend: "native",
      } as ProblemRuntimeConfig,
    ),
    "oi-native",
  );
  assertEquals(buildJudgeQueues("custom:oi-wasm"), {
    high: "custom:oi-wasm:high",
    medium: "custom:oi-wasm:medium",
    low: "custom:oi-wasm:low",
  });
});

Deno.test("调度迁移：保留源码、轮次、标准与优先级，不信任伪造的资源池", () => {
  const legacy = {
    ...oiFixture,
    resource_pool: "ai",
    scheduling_version: 999,
    priority: "high",
    rejudge_seq: 7,
    run_id: "same-attempt",
  };
  const normalized = JSON.parse(
    normalizePoolTask(JSON.stringify(legacy), "medium")!,
  );
  assertEquals(normalized.resource_pool, "oi-wasm");
  assertEquals(normalized.scheduling_version, 1);
  assertEquals(normalized.priority, "high");
  assertEquals(normalized.rejudge_seq, 7);
  assertEquals(normalized.run_id, "same-attempt");
  assertEquals(normalized.code, legacy.code);
  assertEquals(normalized.runtime_config, legacy.runtime_config);
  assertEquals(normalized.oi_cost_profile, legacy.oi_cost_profile);
  assertEquals(normalizePoolTask("not JSON", "medium"), null);
  assertEquals(
    normalizePoolTask(
      JSON.stringify({ ...legacy, priority: "urgent" }),
      "medium",
    ),
    null,
  );
  assertEquals(
    normalizePoolTask(JSON.stringify({ ...legacy, code: 1 }), "medium"),
    null,
  );
});
