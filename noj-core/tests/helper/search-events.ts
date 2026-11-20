import { assertEquals } from "jsr:@std/assert@^1";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../src/shared/db/connection.ts";
import { backgroundTasks } from "../../src/shared/db/schema.ts";

/**
 * 查询是否已登记指定实体的 `search.index` 任务（#698 N1：索引事件改为
 * PostgreSQL 后台任务，不再写 Redis 列表）。
 */
export async function hasSearchIndexTask(
  entityType: string,
  entityId: string,
  action: "upsert" | "delete",
): Promise<boolean> {
  const rows = await getDb().select({ id: backgroundTasks.id }).from(
    backgroundTasks,
  ).where(and(
    eq(backgroundTasks.task_type, "search.index"),
    eq(backgroundTasks.target_id, entityId),
    sql`${backgroundTasks.payload}->>'entity_type' = ${entityType}`,
    sql`${backgroundTasks.payload}->>'action' = ${action}`,
  )).limit(1);
  return rows.length > 0;
}

/**
 * 断言已登记指定实体的搜索索引任务。
 *
 * 任务与业务写入在调用返回前同步登记，无需轮询；按唯一 entityId 查找，
 * 不受并行测试影响。
 */
export async function assertSearchEventPublished(
  entityType: string,
  entityId: string,
  action: "upsert" | "delete",
): Promise<void> {
  assertEquals(
    await hasSearchIndexTask(entityType, entityId, action),
    true,
    `未找到搜索索引任务 ${entityType}:${entityId}:${action}`,
  );
}
