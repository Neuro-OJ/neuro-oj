import { assertEquals } from "jsr:@std/assert@^1";
import { getRedis } from "../../src/shared/mq/connection.ts";
import { SEARCH_INDEX_QUEUE } from "../../src/shared/search-events.ts";

export async function assertSearchEventPublished(
  entityType: string,
  entityId: string,
  action: "upsert" | "delete",
): Promise<void> {
  const redis = getRedis();
  // 轮询窗口 5s（原 2s）：搜索索引事件是 fire-and-forget LPUSH（见
  // shared/search-events.ts），在并行分片 + 高负载下 2s 不足以稳定观测，
  // 曾造成“事件其实已发布但断言失败”的假失败。窗口放宽不削弱判定强度——
  // 事件始终不到达时仍会失败。
  const deadline = Date.now() + 5000;
  let found = false;
  while (Date.now() < deadline) {
    const raw = await redis.lrange(SEARCH_INDEX_QUEUE, 0, -1);
    found = raw.some((item) => {
      try {
        const parsed = JSON.parse(item) as {
          entityType?: string;
          entityId?: string;
          action?: string;
        };
        return parsed.entityType === entityType &&
          parsed.entityId === entityId &&
          parsed.action === action;
      } catch {
        return false;
      }
    });
    if (found) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assertEquals(
    found,
    true,
    `未找到搜索索引事件 ${entityType}:${entityId}:${action}`,
  );
}
