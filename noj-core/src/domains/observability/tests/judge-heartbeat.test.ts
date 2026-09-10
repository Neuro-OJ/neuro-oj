import { readJudgeHeartbeats } from "../services/judge-heartbeat.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

interface FakeRedis {
  scan(
    cursor: string | number,
    ...args: (string | number)[]
  ): Promise<[string, string[]]>;
  get(key: string): Promise<string | null>;
}

Deno.test("judge-heartbeat: 聚合有效心跳并忽略 malformed", async () => {
  const redis: FakeRedis = {
    scan: () =>
      Promise.resolve(["0", ["noj:observability:judge:worker-1"]] as [
        string,
        string[],
      ]),
    get: (key) => {
      if (key === "noj:observability:judge:worker-1") {
        return Promise.resolve(JSON.stringify({
          active_tasks: 2,
          max_concurrent_tasks: 4,
          completed_tasks_total: 10,
          failed_tasks_total: 1,
          result_push_failures_total: 0,
          orphan_containers: 0,
          cache_items: 3,
          cache_bytes: 1024,
          work_dir_bytes: 2048,
          updated_at_ms: Date.now(),
        }));
      }
      return Promise.resolve(null);
    },
  };
  const aggregate = await readJudgeHeartbeats(
    redis as ReturnType<
      typeof import("../../../shared/mq/connection.ts").getRedis
    >,
  );
  assert(aggregate.workers === 1, "应聚合 1 个 worker");
  assert(aggregate.active_tasks === 2, "活跃任务应为 2");
});
