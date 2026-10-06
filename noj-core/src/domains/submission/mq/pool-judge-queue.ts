import { getRedis } from "../../../shared/mq/connection.ts";
import {
  isOiRuntimeConfig,
  validateOiRuntimeConfig,
  validateRuntimeConfig,
} from "../../catalog/index.ts";
import {
  buildJudgeQueues,
  JUDGE_QUEUE_LAYOUT,
  JUDGE_QUEUE_PREFIX,
  JUDGE_RESOURCE_POOLS,
} from "../../../shared/mq/judge-queues.ts";
import {
  buildJudgeTask,
  type BuildJudgeTaskInput,
  type JudgeTaskPriority,
} from "../types/index.ts";

/** 只补充调度契约，不改变源码、标准、运行配置或评测轮次。 */
export function normalizePoolTask(
  raw: string,
  priority: JudgeTaskPriority,
): string | null {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    for (
      const key of [
        "submission_id",
        "problem_id",
        "user_id",
        "language",
        "code",
      ]
    ) {
      if (typeof value[key] !== "string" || (key !== "code" && !value[key])) {
        return null;
      }
    }
    if (!value.runtime_config || typeof value.runtime_config !== "object") {
      return null;
    }
    if (isOiRuntimeConfig(value.runtime_config)) {
      validateOiRuntimeConfig(
        value.runtime_config,
        value.submission_id.startsWith("st_"),
      );
    } else {
      validateRuntimeConfig(value.runtime_config);
    }
    if (
      value.priority !== undefined &&
      !["high", "medium", "low"].includes(value.priority)
    ) return null;
    const task = buildJudgeTask(
      { ...value, priority: value.priority ?? priority } as BuildJudgeTaskInput,
    );
    return JSON.stringify(task);
  } catch {
    return null;
  }
}

/** 必须排空旧 processing 后迁移；逐条搬运，保持 FIFO，可重复执行。 */
export async function migratePoolJudgeQueues(
  prefix = JUDGE_QUEUE_PREFIX,
): Promise<void> {
  if (JUDGE_QUEUE_LAYOUT === "legacy") return;
  const redis = getRedis();
  const legacyQueues = buildJudgeQueues(prefix);
  const poolQueues = Object.fromEntries(
    JUDGE_RESOURCE_POOLS.map(
      (pool) => [pool, buildJudgeQueues(`${prefix}:${pool}`)],
    ),
  );
  const lock = `${prefix}:pool-migration-lock`;
  const token = crypto.randomUUID();
  const acquired = await redis.eval(
    "return redis.call('SET',KEYS[1],ARGV[1],'EX',60,'NX')",
    1,
    lock,
    token,
  );
  if (!acquired) {
    throw new Error("另一 Core 正在迁移资源池队列，请等待迁移完成后启动");
  }
  try {
    const sources = [
      [prefix, "medium"],
      ...Object.entries(legacyQueues).map((
        [priority, queue],
      ) => [queue, priority]),
    ] as [string, JudgeTaskPriority][];
    for (const [source] of sources) {
      if (await redis.llen(`${source}:processing`) > 0) {
        throw new Error("旧 Judge processing 尚未排空，禁止迁移资源池队列");
      }
    }
    for (const [source, priority] of sources) {
      while (true) {
        const raw = (await redis.lrange(source, -1, -1))[0];
        if (raw === undefined) break;
        const migrated = normalizePoolTask(raw, priority);
        const task = migrated ? JSON.parse(migrated) : null;
        const destination = task
          ? poolQueues[
            task.resource_pool as keyof typeof poolQueues
          ][task.priority as JudgeTaskPriority]
          : `${source}:dead`;
        const moved = await redis.eval(
          `
          if redis.call('GET',KEYS[3])~=ARGV[3] then return -1 end
          redis.call('EXPIRE',KEYS[3],60)
          if redis.call('LINDEX',KEYS[1],-1)~=ARGV[1] then return 0 end
          redis.call('RPOP',KEYS[1]); redis.call('LPUSH',KEYS[2],ARGV[2]); return 1
        `,
          3,
          source,
          destination,
          lock,
          raw,
          migrated ?? raw,
          token,
        );
        if (Number(moved) < 0) throw new Error("资源池迁移锁已失效，停止迁移");
      }
    }
    await redis.set(`${prefix}:layout`, "pools");
  } finally {
    await redis.eval(
      "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",
      1,
      lock,
      token,
    );
  }
}
