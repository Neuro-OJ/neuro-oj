import { assertEquals } from "jsr:@std/assert@^1";
import { getRedis } from "../../src/shared/mq/connection.ts";
import { SEARCH_INDEX_QUEUE } from "../../src/shared/search-events.ts";

export async function assertSearchEventPublished(
  entityType: string,
  entityId: string,
  action: "upsert" | "delete",
): Promise<void> {
  const redis = getRedis();
  const deadline = Date.now() + 2000;
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
