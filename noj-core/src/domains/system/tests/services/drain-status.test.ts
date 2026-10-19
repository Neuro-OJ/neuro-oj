/**
 * 排空状态服务单测（P1d）。
 *
 * 覆盖：
 * - computeDrainState 纯函数的 blockers 稳定取值（含 dead 队列不阻塞）；
 * - readDrainStatus 注入依赖后的响应结构（不依赖真实 DB/Redis）。
 */

import { assertEquals } from "jsr:@std/assert@^1";
import type { QueueHealthResponse } from "../../../submission/index.ts";
import {
  computeDrainState,
  type DrainJudgeNode,
  type DrainStateInput,
  readDrainStatus,
} from "../../services/drain-status.ts";

/** 空队列健康条目。 */
function emptyEntry() {
  return { queue_length: 0, processing_length: 0, dead_length: 0 };
}

/** 干净队列健康（Redis 可用、无积压）。 */
function cleanQueues(): QueueHealthResponse {
  return { judge: emptyEntry(), result: emptyEntry(), redis_ok: true };
}

/** 一个空闲且在线的 Judge Worker 报告。 */
function idleNode(instanceId = "judge-1"): DrainJudgeNode {
  return {
    instance_id: instanceId,
    judge_version: "0.10.5",
    active_tasks: 0,
    max_concurrent_tasks: 4,
  };
}

/** 构造默认「可排空」输入，overrides 覆盖单项。 */
function input(overrides: Partial<DrainStateInput> = {}): DrainStateInput {
  return {
    maintenance: true,
    queues: cleanQueues(),
    inFlightAttempts: 0,
    judgeRequired: true,
    judgeNodes: [idleNode()],
    ...overrides,
  };
}

Deno.test({
  name: "drain-status: 干净状态判定为已排空且无阻塞项",
  fn: () => {
    const state = computeDrainState(input());
    assertEquals(state.maintenance, true);
    assertEquals(state.blockers, []);
    assertEquals(state.drained, true);
  },
});

Deno.test({
  name: "drain-status: maintenance 未开启时以 maintenance_off 阻塞",
  fn: () => {
    const state = computeDrainState(input({ maintenance: false }));
    assertEquals(state.blockers, ["maintenance_off"]);
    assertEquals(state.drained, false);
  },
});

Deno.test({
  name: "drain-status: Redis 不可用与队列积压分别产生稳定 blocker",
  fn: () => {
    const queues = cleanQueues();
    queues.redis_ok = false;
    queues.judge = { queue_length: 1, processing_length: 2, dead_length: 3 };
    queues.result = { queue_length: 4, processing_length: 5, dead_length: 6 };
    const state = computeDrainState(input({ queues }));
    assertEquals(state.blockers, [
      "redis_unavailable",
      "judge_queue_pending",
      "judge_queue_processing",
      "result_queue_pending",
      "result_queue_processing",
    ]);
    assertEquals(state.drained, false);
  },
});

Deno.test({
  name: "drain-status: 在飞评测尝试阻塞排空",
  fn: () => {
    const state = computeDrainState(input({ inFlightAttempts: 2 }));
    assertEquals(state.blockers, ["attempts_in_flight"]);
    assertEquals(state.drained, false);
  },
});

Deno.test({
  name: "drain-status: judge 必需但无 worker 上报时阻塞，非必需时不阻塞",
  fn: () => {
    const required = computeDrainState(
      input({ judgeRequired: true, judgeNodes: [] }),
    );
    assertEquals(required.blockers, ["judge_workers_missing"]);
    assertEquals(required.drained, false);

    const optional = computeDrainState(
      input({ judgeRequired: false, judgeNodes: [] }),
    );
    assertEquals(optional.blockers, []);
    assertEquals(optional.drained, true);
  },
});

Deno.test({
  name: "drain-status: judge worker 有活跃任务时阻塞",
  fn: () => {
    const busyNode: DrainJudgeNode = {
      instance_id: "judge-busy",
      active_tasks: 2,
      max_concurrent_tasks: 4,
    };
    const state = computeDrainState(
      input({ judgeNodes: [idleNode(), busyNode] }),
    );
    assertEquals(state.blockers, ["judge_tasks_active"]);
    assertEquals(state.drained, false);
  },
});

Deno.test({
  name: "drain-status: dead 死信队列只报告不阻塞排空",
  fn: () => {
    const queues = cleanQueues();
    queues.judge.dead_length = 7;
    queues.result.dead_length = 9;
    const state = computeDrainState(input({ queues }));
    assertEquals(state.blockers, []);
    assertEquals(state.drained, true);
  },
});

Deno.test({
  name: "drain-status: readDrainStatus 注入依赖后返回完整响应结构",
  fn: async () => {
    const queues: QueueHealthResponse = {
      judge: { queue_length: 0, processing_length: 0, dead_length: 2 },
      result: { queue_length: 0, processing_length: 0, dead_length: 0 },
      redis_ok: true,
    };
    const nodes: DrainJudgeNode[] = [{
      instance_id: "judge-a",
      judge_version: "0.10.5",
      scheduling_version: 1,
      resource_group: "g1",
      active_tasks: 0,
      max_concurrent_tasks: 4,
      updated_at_ms: 123,
    }];
    const data = await readDrainStatus({
      getMaintenance: () => true,
      getQueueHealth: () => Promise.resolve(queues),
      countInFlightAttempts: () => Promise.resolve(3),
      readJudgeNodeReports: () => Promise.resolve(nodes),
      judgeRequired: () => true,
      now: () => "2026-10-20T00:00:00.000Z",
    });
    assertEquals(data.maintenance, true);
    assertEquals(data.drained, false);
    assertEquals(data.blockers, ["attempts_in_flight"]);
    assertEquals(data.checked_at, "2026-10-20T00:00:00.000Z");
    assertEquals(data.redis_ok, true);
    assertEquals(data.queues, queues);
    assertEquals(data.attempts, { in_flight: 3 });
    assertEquals(data.judge.required, true);
    assertEquals(data.judge.reporting, 1);
    assertEquals(data.judge.nodes, nodes);
  },
});
