import { getRedis } from "./mq/connection.ts";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["noj", "search"]);

export type SearchEntityType =
  | "problem"
  | "user"
  | "community_post"
  | "community_comment"
  | "contest"
  | "submission"
  | "message"
  | "announcement";

export type SearchIndexAction = "upsert" | "delete";

export interface SearchIndexEvent {
  entityType: SearchEntityType;
  entityId: string;
  action: SearchIndexAction;
  occurredAt: string;
  requestId?: string;
}

export const SEARCH_INDEX_QUEUE = "noj:search:index";

/**
 * 发布搜索索引更新事件。
 * 源域在业务写事务成功提交后调用；发布失败只记录日志，不阻塞主流程。
 */
export async function publishSearchIndexEvent(
  entityType: SearchEntityType,
  entityId: string,
  action: SearchIndexAction,
  requestId?: string,
): Promise<void> {
  const event: SearchIndexEvent = {
    entityType,
    entityId,
    action,
    occurredAt: new Date().toISOString(),
    requestId,
  };
  try {
    const redis = getRedis();
    // 非阻塞发布：不等待 Redis LPUSH 完成，失败由 catch 记录日志。
    void redis.lpush(SEARCH_INDEX_QUEUE, JSON.stringify(event)).catch((err) => {
      logger.error("发布搜索索引事件失败", {
        entityType,
        entity_id: entityId,
        action,
        err,
      });
    });
  } catch (err) {
    logger.error("发布搜索索引事件失败", {
      entityType,
      entity_id: entityId,
      action,
      err,
    });
  }
  // 保持 async 签名以兼容现有 await 调用点，但只让出一个微任务，不等待 Redis。
  await Promise.resolve();
}
