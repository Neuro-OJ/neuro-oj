/**
 * 搜索索引任务的可靠登记（P4）。
 *
 * 替换旧的「提交后 LPUSH 失败只记日志」路径：
 * - **业务事务内**登记一条 `search.index` 任务（与业务事实一起提交或回滚）；
 * - handler 从最新数据库事实构造索引，因此任务乱序、重复执行都收敛到同一结果；
 * - 删除任务在源已不存在时仍可幂等清理索引；
 * - Redis 只作为唤醒提示（`notifySearchIndexTask`），任务事实始终在 PostgreSQL。
 *
 * 本文件只依赖 runtime 的任务合同与 shared 的事件类型，不反向依赖 read-models 服务。
 */
import type { DbTx } from "../../shared/db/executor.ts";
import type { SearchEntityType } from "../../shared/search-events.ts";
import {
  type EnqueueTaskInput,
  type EnqueueTaskResult,
  type TaskTargetKind,
} from "../runtime/tasks/contracts.ts";
import { enqueueTaskTx } from "../runtime/tasks/repository.ts";

/** 搜索实体类型 → 任务目标种类。 */
const TARGET_KIND_BY_ENTITY: Record<SearchEntityType, TaskTargetKind> = {
  problem: "problem",
  user: "domain",
  community_post: "problem",
  community_comment: "problem",
  contest: "problem",
  submission: "submission",
  message: "domain",
  announcement: "domain",
};

/** 索引动作；同一业务事件的重复登记合并，不同事件分别持久化。 */
export type SearchIndexTaskAction = "upsert" | "delete";

/**
 * 在业务事务内登记搜索索引任务。
 *
 * 去重键绑定不可变事件/版本 ID：重试同一事实可合并，后续版本不能被旧的
 * succeeded 或 leased 任务吞掉。handler 仍从最新事实构建索引。
 */
export async function enqueueSearchIndexTaskTx(
  tx: DbTx,
  entityType: SearchEntityType,
  entityId: string,
  action: SearchIndexTaskAction,
  eventId: string,
): Promise<EnqueueTaskResult> {
  if (!eventId.trim()) throw new TypeError("搜索任务需要不可变事件标识");
  const input: EnqueueTaskInput = {
    taskType: "search.index",
    targetKind: TARGET_KIND_BY_ENTITY[entityType],
    targetId: entityId,
    dedupeKey: `${entityType}:${action}:${eventId}`,
    payload: { entity_type: entityType, entity_id: entityId, action },
  };
  return await enqueueTaskTx(tx, input);
}
