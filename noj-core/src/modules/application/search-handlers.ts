/**
 * 搜索索引任务处理器（P4）。
 *
 * handler 只做两件事：从**最新数据库事实**构造索引、幂等写入或删除。
 * 因此：
 * - 任务乱序、重复执行都收敛到同一结果；
 * - 源已不存在时 `delete` 仍然幂等清理索引；
 * - 业务事务里登记的只是"哪个实体变了"，不携带索引内容。
 *
 * 该 handler 由 application 注入 runtime worker；runtime 本身不导入 read-models。
 */
import { getLogger } from "@logtape/logtape";
import type { ClaimedTask } from "../runtime/tasks/contracts.ts";
import { processSearchIndexEvent } from "../../domains/search/services/index-writer.ts";
import type { SearchEntityType } from "../../shared/search-events.ts";

const logger = getLogger(["noj", "application", "search-tasks"]);

const KNOWN_ENTITY_TYPES = new Set<SearchEntityType>([
  "problem",
  "user",
  "community_post",
  "community_comment",
  "contest",
  "submission",
  "message",
  "announcement",
]);

/**
 * 处理一条 `search.index` 任务。
 *
 * payload 缺失或非法时抛错 → 由 worker 记失败并退避；这属于程序错误，
 * 不应静默跳过（否则索引会无声落后）。
 */
export async function handleSearchIndexTask(
  task: ClaimedTask,
): Promise<Record<string, unknown>> {
  const entityType = task.payload.entity_type;
  const entityId = task.payload.entity_id;
  const action = task.payload.action;
  if (
    typeof entityType !== "string" ||
    !KNOWN_ENTITY_TYPES.has(entityType as SearchEntityType)
  ) {
    throw new TypeError(`搜索任务实体类型非法：${String(entityType)}`);
  }
  if (typeof entityId !== "string" || entityId.length === 0) {
    throw new TypeError("搜索任务缺少实体 ID");
  }
  if (action !== "upsert" && action !== "delete") {
    throw new TypeError(`搜索任务动作非法：${String(action)}`);
  }
  await processSearchIndexEvent(entityType, entityId, action);
  logger.debug("搜索索引任务完成", {
    entity_type: entityType,
    entity_id: entityId,
    action,
  });
  return { entity_type: entityType, action };
}
