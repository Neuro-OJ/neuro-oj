/**
 * 真实 PostgreSQL 屏障测试的**原生连接**工具（2026-10-11 复审问题 5）。
 *
 * 背景：并发/锁序用例需要绕过 preload 的事务包装、自己控制连接与事务。
 * 但裸 `postgres(DATABASE_URL)` **不会带上 `TEST_SCHEMA` 的 search_path**，
 * 于是在分片/独立 schema 下会去操作另一套表（本地表现为域用例批量失败）。
 *
 * 本模块统一：
 * - 让所有原生连接复用 `buildConnectionOptions()`（含 `-csearch_path=...` 与 JIT 设置）；
 * - 提供 `withRawTransaction()` 保证「读检查 + 写引用」在同一真实事务内完成；
 * - 连接由调用方显式 `await client.end()` 关闭（或使用 withRawClient 自动关闭）。
 */
import postgres from "postgres";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { buildConnectionOptions } from "../../src/shared/db/connection.ts";
import * as schema from "../../src/shared/db/schema.ts";
import type { Executor } from "../../src/shared/db/executor.ts";

/** 测试用连接参数：与主连接池一致的 search_path / JIT，仅连接数不同。 */
export function rawConnectionOptions() {
  const testSchema = Deno.env.get("TEST_SCHEMA") || "";
  const jitDisabled = Deno.env.get("DATABASE_JIT")?.trim().toLowerCase() !==
    "on";
  return buildConnectionOptions(testSchema, jitDisabled);
}

/** 新建一条原生连接（`max: 1`，与测试主连接同 search_path）。 */
export function createRawClient() {
  const url = Deno.env.get("DATABASE_URL");
  if (!url) throw new Error("DATABASE_URL 未设置：真实 PG 用例不应执行");
  return postgres(url, {
    max: 1,
    connection: rawConnectionOptions(),
  });
}

/** 新建一条原生 drizzle 连接（调用方负责 `end()`）。 */
export function createRawDb() {
  const client = createRawClient();
  return {
    client,
    db: drizzlePg(client, { schema }) as unknown as Executor,
  };
}

/** 在**同一条原生连接**的**同一个真实事务**内执行回调。 */
export async function withRawTransaction<T>(
  fn: (tx: Executor) => Promise<T>,
): Promise<T> {
  const { client, db } = createRawDb();
  try {
    return await db.transaction(async (tx) => await fn(tx as Executor));
  } finally {
    await client.end({ timeout: 5 });
  }
}

/** 在一条原生连接上执行只读/单语句回调后自动关闭连接。 */
export async function withRawClient<T>(
  fn: (client: ReturnType<typeof postgres>) => Promise<T>,
): Promise<T> {
  const client = createRawClient();
  try {
    return await fn(client);
  } finally {
    await client.end({ timeout: 5 });
  }
}
