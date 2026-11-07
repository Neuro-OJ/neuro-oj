/**
 * 评测任务派发标记。
 *
 * DB 写入与 Redis 入队无法放进同一个事务：进程可能在任务已经入队后、提交状态
 * 更新前退出。用 run_id 建立短期 Redis 标记，让恢复器能识别“已入队但状态尚未
 * 更新”的任务，避免重复派发；标记由结果消费或任务取消时清理，过期后仍可由
 * sweeper 重新接管长期失联的任务。
 */

import { getRedis } from "../../../shared/mq/connection.ts";

export const JUDGE_TASK_MARKER_PREFIX = "noj:judge:dispatch:";
/** 正常评测不应超过此窗口；过期后允许恢复器重新接管。 */
export const JUDGE_TASK_MARKER_TTL_SECONDS = 24 * 60 * 60;
const DISPATCH_CLAIM_TTL_SECONDS = 60;
const RELEASE_DISPATCH_SCRIPT = `
if redis.call('GET',KEYS[1]) == ARGV[1] then
  return redis.call('DEL',KEYS[1])
end
return 0
`;

export type JudgeTaskMarkerState = "queued" | "dispatching";

export type JudgeTaskDispatchClaim =
  | { status: "claimed" }
  | { status: "already"; marker: JudgeTaskMarkerState | "unknown" };

export function judgeTaskMarkerKey(runId: string): string {
  return `${JUDGE_TASK_MARKER_PREFIX}${runId}`;
}

async function readyRedis() {
  const redis = getRedis();
  if (redis.status !== "ready") await redis.connect();
  return redis;
}

/**
 * 为恢复动作抢占一个短期派发锁。
 *
 * 正常生产者由入队 Lua 脚本直接写入 queued；恢复器先写 dispatching，避免多个
 * core 副本同时发现同一孤儿后重复入队。锁只在恢复器的构建/入队窗口内存在。
 */
export async function claimJudgeTaskDispatch(
  runId: string,
): Promise<JudgeTaskDispatchClaim> {
  const redis = await readyRedis();
  const key = judgeTaskMarkerKey(runId);
  const claimed = await redis.set(
    key,
    "dispatching",
    "EX",
    DISPATCH_CLAIM_TTL_SECONDS,
    "NX",
  );
  if (claimed === "OK") return { status: "claimed" };

  const marker = await redis.get(key);
  return {
    status: "already",
    marker: marker === "queued" || marker === "dispatching"
      ? marker
      : "unknown",
  };
}

/** 恢复动作失败时释放 dispatching 锁；queued 标记不会被误删。 */
export async function releaseJudgeTaskDispatch(runId: string): Promise<void> {
  const redis = await readyRedis();
  await redis.eval(
    RELEASE_DISPATCH_SCRIPT,
    1,
    judgeTaskMarkerKey(runId),
    "dispatching",
  );
}

/** 批量查询哪些 run_id 仍有派发标记（任意状态），返回有标记的集合。 */
export async function findJudgeTaskMarkers(
  runIds: readonly string[],
): Promise<Set<string>> {
  if (runIds.length === 0) return new Set();
  const redis = await readyRedis();
  const values = await redis.mget(...runIds.map(judgeTaskMarkerKey));
  return new Set(runIds.filter((_, index) => values[index] != null));
}

/**
 * 为仍在 Redis 列表中的任务补写 queued 标记，返回在列表中找到的 run_id。
 *
 * 标记引入前入队的任务（或滚动升级期间旧副本入队的任务）没有标记；恢复器把
 * “无标记”判为孤儿前必须用列表内容复核一次，否则会重复派发。只在出现候选孤儿时
 * 调用，列表长度受队列容量约束。
 */
export async function markInFlightJudgeTasks(
  queues: readonly string[],
  runIds: ReadonlySet<string>,
): Promise<Set<string>> {
  const found = new Set<string>();
  if (runIds.size === 0) return found;
  const redis = await readyRedis();
  for (const queue of queues) {
    for (const raw of await redis.lrange(queue, 0, -1)) {
      let parsed: { run_id?: unknown; attempt_id?: unknown };
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      const runId = typeof parsed?.run_id === "string"
        ? parsed.run_id
        : typeof parsed?.attempt_id === "string"
        ? parsed.attempt_id
        : null;
      if (runId && runIds.has(runId)) found.add(runId);
    }
  }
  for (const runId of found) {
    await redis.set(
      judgeTaskMarkerKey(runId),
      "queued",
      "EX",
      JUDGE_TASK_MARKER_TTL_SECONDS,
      "NX",
    );
  }
  return found;
}

/** 评测结果已持久化后清理任务标记；失败由调用方决定是否记录但不重投结果。 */
export async function clearJudgeTaskMarker(runId: string): Promise<void> {
  const redis = await readyRedis();
  await redis.del(judgeTaskMarkerKey(runId));
}
