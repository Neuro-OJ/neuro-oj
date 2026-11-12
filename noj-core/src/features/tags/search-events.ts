/**
 * 标签写操作后的搜索索引事件登记（best-effort）。
 *
 * 标签增删改/合并会改变题目的可见标签，需让题目搜索索引重新构建。语义与原
 * `application/search-tasks.ts` 的 `enqueueSearchIndexTask` 一致：独立事务登记一条
 * `search.index` 任务，失败只记日志、不阻断业务。这里经 `modules/runtime` 出口
 * 直接登记，避免功能目录依赖 `modules/application/index.ts` 形成运行时环。
 */
import { getLogger } from "@logtape/logtape";
import { getDb } from "../../shared/db/connection.ts";
import { enqueueTaskTx } from "../../modules/runtime/index.ts";

const logger = getLogger(["noj", "catalog"]);

/** 为题目登记一次搜索索引 upsert（task 载荷与原 enqueueSearchIndexTask 一致）。 */
export async function enqueueProblemSearchUpsert(problemId: string) {
  const eventId = crypto.randomUUID();
  try {
    await getDb().transaction((tx) =>
      enqueueTaskTx(tx, {
        taskType: "search.index",
        targetKind: "problem",
        targetId: problemId,
        dedupeKey: `problem:upsert:${eventId}`,
        payload: {
          entity_type: "problem",
          entity_id: problemId,
          action: "upsert",
        },
      })
    );
  } catch (err) {
    logger.error("登记标签关联题目搜索索引任务失败，索引可能落后", {
      problem_id: problemId,
      err,
    });
  }
}
