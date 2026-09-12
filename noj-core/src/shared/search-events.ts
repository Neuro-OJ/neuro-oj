import { connectRedis, getRedis } from "./mq/connection.ts";
import { logger } from "./base/logging.ts";

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
    // 连接未就绪时先"确保连接"（2026-09-12 修复静默丢事件）：
    // 共享连接是 lazyConnect，若调用方尚未建立连接（生产由启动期 connectRedis()
    // 保证，测试进程则不一定），原实现会因 enableOfflineQueue 语义直接失败并只记日志
    // → 索引事件被**静默丢弃**，搜索索引无对账地落后（架构评审 §2.5 的隐患）。
    // 这里仅在非 ready 时补一次幂等连接，ready 路径不增加任何等待。
    if ((redis.status as string) !== "ready") {
      try {
        await connectRedis();
      } catch (err) {
        logger.warn("搜索索引事件发布前连接 Redis 失败，本次事件可能丢失", {
          entityType,
          entity_id: entityId,
          err,
        });
      }
    }
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
