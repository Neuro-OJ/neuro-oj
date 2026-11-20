/** 从实际旧 Redis 数值建立升级基线，不由审计记录猜测预占。 */
import type { Db } from "./db.ts";
import type { RedisClient } from "./redis.ts";
import { type AccountingCounter, settleLedgerRow } from "./accounting.ts";

/** 当前月唯一基线 ID；只在实例治理明确建立后生效。 */
export function accountingBaselineId(now = new Date()): string {
  return "baseline:" + now.toISOString().slice(0, 7);
}

function canonicalKey(key: string): string {
  // 旧平台的域内维度归入 main；全实例 global 键保持原名。
  const main = "00000000-0000-4000-8000-000000000001";
  return /^llm:(user|problem|user_problem|attempt|sub):/.test(key)
    ? key.replace(/^llm:/, "llm:domain:" + main + ":")
    : key;
}

/** 排他锁下测量现存计数、扣除新账本部分，保存一次幂等历史基线。 */
export async function bootstrapAccountingBaseline(
  db: Db,
  redis: RedisClient,
): Promise<{ id: string; counters: number; replayed: boolean }> {
  if (!redis.scan || !redis.pttl) {
    throw new Error("accounting_baseline_scan_unavailable");
  }
  return await db.begin(async (connection) => {
    const tx = connection as unknown as Db;
    await tx`SELECT pg_advisory_xact_lock(184789, 3)`;
    const now = Date.now(), id = accountingBaselineId();
    const [existing] = await tx`SELECT id FROM llm_call_ledger WHERE id=${id}`;
    if (existing) return { id, counters: 0, replayed: true };
    const marker = "llm:accounting:" + id;
    const cached = await redis.get(marker);
    if (cached) {
      // Redis 已执行但 DB 提交失败：复用同一测量，不再扫描相加旧/新键。
      const counters: AccountingCounter[] = JSON.parse(cached);
      await tx`INSERT INTO llm_call_ledger(id,domain_id,attempt_id,state,reservation,settlement,settlement_result,created_at,updated_at)
        VALUES(${id},'00000000-0000-4000-8000-000000000001','historical-baseline','settled',${
        JSON.stringify(counters)
      }::text::jsonb,
        '[]'::jsonb,'ok',${new Date(now).toISOString()},${
        new Date(now).toISOString()
      })`;
      return { id, counters: counters.length, replayed: true };
    }
    const month = new Date().toISOString().slice(0, 7),
      day = new Date().toISOString().slice(0, 10);
    const cutoff = month + "-01T00:00:00.000Z";
    const rows = await tx<Parameters<typeof settleLedgerRow>[2][]>`
      SELECT * FROM llm_call_ledger WHERE state <> 'denied'
      AND (created_at >= ${cutoff} OR state <> 'settled')`;
    // 不把新调用尚未应用的结算差额误记为历史余额。
    for (const row of rows) {
      if (row.state === "pending") await settleLedgerRow(tx, redis, row);
      if (row.state === "planned" || row.state === "unknown") {
        throw new Error("accounting_baseline_unresolved_calls");
      }
    }
    const known = new Map<string, number>();
    for (const row of rows) {
      const delta = new Map(
        row.settlement?.map((counter) => [counter.key, counter.inc]) ?? [],
      );
      for (const counter of row.reservation) {
        if (counter.expires_at > now) {
          known.set(
            counter.key,
            (known.get(counter.key) ?? 0) +
              Math.max(0, counter.inc + (delta.get(counter.key) ?? 0)),
          );
        }
      }
    }
    const measured = new Map<string, AccountingCounter>();
    const visited = new Set<string>();
    let cursor = "0";
    do {
      const scanned = await redis.scan!(cursor, "llm:*", 500);
      cursor = scanned[0];
      for (const rawKey of scanned[1]) {
        if (visited.has(rawKey)) continue;
        visited.add(rawKey);
        if (
          !/:(calls|tokens|cost)$/.test(rawKey) ||
          !/^llm:(global|domain|user|problem|user_problem|attempt|sub):/.test(
            rawKey,
          )
        ) continue;
        if (rawKey.includes(":day:") && !rawKey.includes(":day:" + day + ":")) {
          continue;
        }
        if (
          rawKey.includes(":month:") &&
          !rawKey.includes(":month:" + month + ":")
        ) continue;
        const rawValue = await redis.get(rawKey),
          ttl = await redis.pttl!(rawKey);
        if (rawValue === null || ttl === -2) continue;
        const value = Number(rawValue);
        if (!Number.isSafeInteger(value) || value < 0 || ttl <= 0) {
          throw new Error("accounting_baseline_counter_invalid");
        }
        const key = canonicalKey(rawKey), previous = measured.get(key);
        const residual = rawKey === key
          ? Math.max(0, value - (known.get(key) ?? 0))
          : value;
        measured.set(key, {
          key,
          inc: (previous?.inc ?? 0) + residual,
          limit: -1,
          expires_at: Math.max(previous?.expires_at ?? 0, now + ttl),
        });
      }
    } while (cursor !== "0");
    const counters = [...measured.values()].filter((counter) =>
      counter.inc > 0
    );
    const [legacy] =
      await tx`SELECT count(*)::integer AS count FROM llm_usage u LEFT JOIN llm_call_ledger l ON l.id=u.id
      WHERE l.id IS NULL AND u.created_at >= ${cutoff} AND (u.status IN ('ok','error') OR u.billed_total_tokens>0)`;
    if (
      legacy.count > 0 &&
      !counters.some((counter) => counter.key.endsWith(":calls"))
    ) throw new Error("accounting_baseline_counts_missing");
    await tx`INSERT INTO llm_call_ledger(id,domain_id,attempt_id,state,reservation,settlement,settlement_result,created_at,updated_at)
      VALUES(${id},'00000000-0000-4000-8000-000000000001','historical-baseline','settled',${
      JSON.stringify(counters)
    }::text::jsonb,
      '[]'::jsonb,'ok',${new Date(now).toISOString()},${
      new Date(now).toISOString()
    })`;
    const nextMonth = new Date();
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1, 1);
    nextMonth.setUTCHours(0, 0, 0, 0);
    await redis.eval(
      `local values=cjson.decode(ARGV[1]); for i=1,#KEYS-1 do redis.call('SET',KEYS[i],values[i].value);redis.call('PEXPIREAT',KEYS[i],values[i].expires_at) end;redis.call('SET',KEYS[#KEYS],ARGV[2]);redis.call('PEXPIREAT',KEYS[#KEYS],ARGV[3]);return 'ok'`,
      [...counters.map((counter) => counter.key), marker],
      [
        JSON.stringify(
          counters.map((counter) => ({
            value: counter.inc + (known.get(counter.key) ?? 0),
            expires_at: counter.expires_at,
          })),
        ),
        JSON.stringify(counters),
        nextMonth.getTime() + 60000,
      ],
    );
    return { id, counters: counters.length, replayed: false };
  }) as { id: string; counters: number; replayed: boolean };
}
