/**
 * read-models 对外暴露的投影 revision 窄事务合同。
 *
 * `query_projection_revisions` 归 read-models 所有：它是缓存键与物化视图的
 * 失效依据，任何业务模块都只能在**自己的业务事务**里通过本文件递增它，
 * 不能直接 `insert(queryProjectionRevisions)`。
 *
 * 三个函数都只接收真实 `DbTx`、只写 read-models 拥有的表、不自开根事务，
 * 也不回退到默认根连接。
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbTx } from "../../../shared/db/executor.ts";
import { queryProjectionRevisions } from "../../../shared/db/schema.ts";

/** 全局作用域键：提交总数等聚合口径。 */
export function globalProjectionScopeKey(): string {
  return "global";
}

/** 题目作用域键。 */
export function problemProjectionScopeKey(problemId: string): string {
  return `problem:${problemId}`;
}

/** 竞赛作用域键。 */
export function contestProjectionScopeKey(contestId: string): string {
  return `contest:${contestId}`;
}

/** 使用域作用域键。 */
export function domainProjectionScopeKey(domainId: string): string {
  return `domain:${domainId}`;
}

/**
 * 递增（或创建）一个作用域的 `data_revision`，返回递增后的值。
 *
 * 必须在业务事务内调用：判定替换与策略切换都要让缓存键立即失效，
 * 不允许依赖 TTL 或异步刷新。`materialized_revision` 保持不变，由刷新方推进。
 */
export async function bumpQueryProjectionRevisionTx(
  tx: DbTx,
  scopeKey: string,
): Promise<number> {
  if (typeof scopeKey !== "string" || scopeKey.trim() === "") {
    throw new TypeError("投影作用域键不能为空");
  }
  const rows = await tx.insert(queryProjectionRevisions).values({
    scope_key: scopeKey,
    data_revision: 1,
    materialized_revision: 0,
  }).onConflictDoUpdate({
    target: queryProjectionRevisions.scope_key,
    set: {
      data_revision: sql`${queryProjectionRevisions.data_revision} + 1`,
    },
  }).returning({ data_revision: queryProjectionRevisions.data_revision });
  return rows[0]?.data_revision ?? 1;
}

/** 一次递增多个作用域；按调用方给出的顺序串行推进，避免自增竞争。 */
export async function bumpQueryProjectionRevisionsTx(
  tx: DbTx,
  scopeKeys: readonly string[],
): Promise<void> {
  for (const scopeKey of scopeKeys) {
    await bumpQueryProjectionRevisionTx(tx, scopeKey);
  }
}

/**
 * 读取作用域当前的数据版本；不存在按 0 处理（尚未产生任何投影变化）。
 *
 * 只读，供 application/read-models 组合层判断是否需要重新物化。
 */
export async function readQueryProjectionRevisionTx(
  tx: DbTx,
  scopeKey: string,
): Promise<number> {
  const [row] = await tx.select({
    data_revision: queryProjectionRevisions.data_revision,
  }).from(queryProjectionRevisions).where(
    eq(queryProjectionRevisions.scope_key, scopeKey),
  ).limit(1);
  return row?.data_revision ?? 0;
}

/** 批量读取多个作用域的当前数据版本；缺失的作用域不出现在结果中。 */
export async function readQueryProjectionRevisionsTx(
  tx: DbTx,
  scopeKeys: readonly string[],
): Promise<Map<string, number>> {
  const keys = [...new Set(scopeKeys)];
  const out = new Map<string, number>();
  const BATCH = 5_000;
  for (let offset = 0; offset < keys.length; offset += BATCH) {
    const rows = await tx.select({
      scope_key: queryProjectionRevisions.scope_key,
      data_revision: queryProjectionRevisions.data_revision,
    }).from(queryProjectionRevisions).where(
      inArray(
        queryProjectionRevisions.scope_key,
        keys.slice(offset, offset + BATCH),
      ),
    );
    for (const row of rows) out.set(row.scope_key, row.data_revision);
  }
  return out;
}

/**
 * 标记某作用域已被刷新到指定数据版本。
 *
 * 只有读模型刷新链可以调用；`materialized_revision` 不得超过 `data_revision`
 * （数据库 check 约束会拒绝非法值），因此这里先比较再写。
 */
export async function markQueryProjectionMaterializedTx(
  tx: DbTx,
  scopeKey: string,
  dataRevision: number,
  materializedAt: string,
): Promise<void> {
  await tx.update(queryProjectionRevisions).set({
    materialized_revision: dataRevision,
    materialized_at: materializedAt,
  }).where(and(
    eq(queryProjectionRevisions.scope_key, scopeKey),
    sql`${queryProjectionRevisions.data_revision} >= ${dataRevision}`,
  ));
}
