/** 持久调用账本与 Redis 用量投影。 */
import type { Db } from "./db.ts";
import type { RedisClient } from "./redis.ts";
import type { EvalTokenPayload } from "./crypto.ts";
import { logger } from "./logger.ts";
import { recordUsage, type UsageEntry } from "./usage.ts";
import { accountingBaselineId } from "./accounting-baseline.ts";

export interface AccountingCounter {
  key: string;
  limit: number;
  inc: number;
  expires_at: number;
}
interface LedgerRow {
  id: string;
  domain_id: string;
  state: string;
  reservation: AccountingCounter[];
  settlement: AccountingCounter[] | null;
  settlement_result: string | null;
}

/** 保存计划先于 Redis 预占，进程退出仍能定位不确定的调用。 */
export async function saveReservation(
  db: Db,
  id: string,
  payload: EvalTokenPayload,
  counters: AccountingCounter[],
): Promise<void> {
  const now = new Date().toISOString();
  await db`INSERT INTO llm_call_ledger(id,domain_id,attempt_id,state,reservation,created_at,updated_at)
    VALUES(${id},${payload.domain_id},${payload.attempt_id},'planned',${
    JSON.stringify(counters)
  }::text::jsonb,${now},${now})
    ON CONFLICT(id) DO NOTHING`;
}

/** 预占/结算共享锁与整批对账排他锁协调，状态放 DB，不使用进程锁。 */
export async function withAccounting<T>(
  db: Db,
  operation: (tx: Db) => Promise<T>,
): Promise<T> {
  return await db.begin(async (connection) => {
    await connection`SELECT pg_advisory_xact_lock_shared(184789, 3)`;
    return await operation(connection as unknown as Db);
  }) as T;
}

/** 预占计划须先提交，但对账不能插入计划与 Redis 受理之间。 */
export async function withReservationLock<T>(
  db: Db,
  operation: (connection: Db) => Promise<T>,
): Promise<T> {
  const connection = await db.reserve();
  try {
    await connection`SELECT pg_advisory_lock_shared(184789, 3)`;
    return await operation(connection as unknown as Db);
  } finally {
    try {
      await connection`SELECT pg_advisory_unlock_shared(184789, 3)`;
    } finally {
      connection.release();
    }
  }
}

/** 已确认 Redis 受理/拒绝；不自动重发未知上游调用。 */
export async function recordReservationResult(
  db: Db,
  id: string,
  accepted: boolean,
): Promise<void> {
  await db`UPDATE llm_call_ledger SET state=${
    accepted ? "reserved" : "denied"
  },updated_at=${new Date().toISOString()} WHERE id=${id} AND state='planned'`;
}

/** 已知实际用量先持久化；重复登记不改写结算依据。 */
export async function queueSettlement(
  db: Db,
  id: string,
  counters: AccountingCounter[],
): Promise<void> {
  await db`UPDATE llm_call_ledger SET state='pending',settlement=${
    JSON.stringify(counters)
  }::text::jsonb,updated_at=${new Date().toISOString()}
    WHERE id=${id} AND state IN ('reserved','unknown') AND settlement IS NULL`;
}

/** 实际用量与待结算依据同事务保存，调用返回之前已有可重放事实。 */
export async function persistCallUsage(
  db: Db,
  id: string,
  entry: UsageEntry,
  actualTokens: number,
  actualCost: number,
): Promise<void> {
  await withAccounting(db, async (tx) => {
    const [row] = await tx<
      LedgerRow[]
    >`SELECT * FROM llm_call_ledger WHERE id=${id} FOR UPDATE`;
    if (!row) throw new Error("call_not_found");
    const counters = row.reservation.filter((counter) =>
      !counter.key.endsWith(":calls")
    )
      .map((counter) => ({
        ...counter,
        inc: (counter.key.endsWith(":tokens") ? actualTokens : actualCost) -
          counter.inc,
      }));
    await recordUsage(tx, { ...entry, id });
    await queueSettlement(tx, id, counters);
  });
}

/** 网络/响应中断不能证明上游未计费；保留预占与不确定事实供核对。 */
export async function recordUnknownCall(db: Db, id: string): Promise<void> {
  await withAccounting(db, async (tx) => {
    await tx`UPDATE llm_call_ledger SET state='unknown',updated_at=${
      new Date().toISOString()
    } WHERE id=${id} AND state='reserved'`;
  });
}

function settlementMarker(row: Pick<LedgerRow, "id" | "domain_id">): string {
  return `llm:accounting:${row.domain_id}:${row.id}:settled`;
}
/** 调用 ID 的预占确认标记，与幂等 Lua 同步写入。 */
export function reservationMarker(domainId: string, id: string): string {
  return `llm:accounting:${domainId}:${id}:reserved`;
}

const SETTLE_ONCE = `
local cached = redis.call('GET', KEYS[#KEYS])
if cached then return cached end
local meta = cjson.decode(ARGV[1])
local now = tonumber(ARGV[2])
local result = 'ok'
local marker_expiry = now + 60
for i=1,#KEYS-1 do
  local counter = meta[i]
  local expiry = tonumber(counter.expires_at)
  if expiry > marker_expiry then marker_expiry = expiry end
  if expiry > now then
    local value = redis.call('INCRBY', KEYS[i], tonumber(counter.inc))
    if value < 0 then redis.call('SET', KEYS[i], '0'); value = 0 end
    redis.call('PEXPIREAT', KEYS[i], expiry)
    local limit = tonumber(counter.limit)
    if limit == 0 or (limit > 0 and value > limit) then result = 'limit_exceeded' end
  end
end
redis.call('SET', KEYS[#KEYS], result)
redis.call('PEXPIREAT', KEYS[#KEYS], marker_expiry + 60000)
return result
`;

/** 使用调用 ID 幂等结算；Redis 应答丢失或 DB 更新失败可重放同一笔。 */
export async function settleLedgerRow(
  db: Db,
  redis: RedisClient,
  row: LedgerRow,
): Promise<string> {
  if (row.state === "settled") return row.settlement_result ?? "ok";
  if (row.state !== "pending" || !row.settlement) {
    throw new Error("settlement_not_ready");
  }
  const result = String(
    await redis.eval(SETTLE_ONCE, [
      ...row.settlement.map((counter) => counter.key),
      settlementMarker(row),
    ], [JSON.stringify(row.settlement), Date.now()]),
  );
  await db`UPDATE llm_call_ledger SET state='settled',settlement_result=${result},updated_at=${
    new Date().toISOString()
  } WHERE id=${row.id}`;
  if (result !== "ok") {
    await db`UPDATE llm_usage SET status='rejected',error_code=${result} WHERE id=${row.id}`;
  }
  return result;
}

/** 即时结算与后台重试使用同一持久依据。 */
export async function settleCall(
  db: Db,
  redis: RedisClient,
  id: string,
): Promise<string> {
  return await withAccounting(db, async (tx) => {
    const [row] = await tx<
      LedgerRow[]
    >`SELECT * FROM llm_call_ledger WHERE id=${id} FOR UPDATE`;
    if (!row) throw new Error("call_not_found");
    return await settleLedgerRow(tx, redis, row);
  });
}

/** 各副本分批领取待结算记录；故障保留 pending，重启自动继续。 */
export async function retrySettlements(
  db: Db,
  redis: RedisClient,
  limit = 100,
): Promise<number> {
  return await withAccounting(db, async (tx) => {
    // 上游请求最多 120 秒；进程退出留下的预占在 3 分钟后显式列为未知。
    const cutoff = new Date(Date.now() - 180_000).toISOString();
    await tx`UPDATE llm_call_ledger SET state='unknown',updated_at=${
      new Date().toISOString()
    }
      WHERE state IN ('planned','reserved') AND updated_at < ${cutoff}`;
    const rows = await tx<
      LedgerRow[]
    >`SELECT * FROM llm_call_ledger WHERE state='pending'
      ORDER BY created_at,id LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
    for (const row of rows) await settleLedgerRow(tx, redis, row);
    return rows.length;
  });
}

const REBUILD = `
local meta = cjson.decode(ARGV[1])
for i=1,#KEYS do
  redis.call('SET', KEYS[i], meta[i].value)
  redis.call('PEXPIREAT', KEYS[i], meta[i].expires_at)
end
return 'ok'
`;

/** 从持久预占/实际用量重建本账本覆盖的活动计数，修复 Redis 丢失及重复结算。 */
export async function reconcileAccounting(
  db: Db,
  redis: RedisClient,
): Promise<{ calls: number; counters: number; unknown: number }> {
  return await db.begin(async (connection) => {
    const tx = connection as unknown as Db;
    await tx`SELECT pg_advisory_xact_lock(184789, 3)`;
    // 月窗口是最长聚合窗口；未结算/不确定记录不受日期过滤。
    const cutoff = new Date();
    cutoff.setUTCDate(1);
    cutoff.setUTCHours(0, 0, 0, 0);
    const [legacy] = await tx`SELECT count(*)::integer AS count FROM llm_usage u
      LEFT JOIN llm_call_ledger l ON l.id=u.id WHERE l.id IS NULL AND u.created_at >= ${cutoff.toISOString()}
      AND (u.status IN ('ok','error') OR u.billed_total_tokens > 0)`;
    // 旧记录没有预占快照，不能把现有窗口计数直接归零；治理需先核对基线。
    if (legacy.count > 0) {
      const [baseline] =
        await tx`SELECT id FROM llm_call_ledger WHERE id=${accountingBaselineId()}`;
      if (!baseline) {
        throw new Error("accounting_legacy_window_requires_baseline");
      }
    }
    const rows = await tx<
      LedgerRow[]
    >`SELECT * FROM llm_call_ledger WHERE state <> 'denied'
      AND (created_at >= ${cutoff.toISOString()} OR state <> 'settled') ORDER BY id FOR UPDATE`;
    const now = Date.now();
    const totals = new Map<string, { value: number; expires_at: number }>();
    let unknown = 0;
    for (const row of rows) {
      if (row.state === "planned") {
        const reserved = await redis.get(
          reservationMarker(row.domain_id, row.id),
        );
        // 标记丢失无法证明上游没被调用，保守保留预占并公开 unknown 状态。
        row.state = reserved ? "reserved" : "unknown";
        await tx`UPDATE llm_call_ledger SET state=${row.state},updated_at=${
          new Date().toISOString()
        } WHERE id=${row.id}`;
      }
      if (row.state === "unknown") unknown++;
      const actual = new Map(
        row.settlement?.map((counter) => [counter.key, counter.inc]) ?? [],
      );
      for (const counter of row.reservation) {
        if (counter.expires_at <= now) continue;
        const total = totals.get(counter.key) ??
          { value: 0, expires_at: counter.expires_at };
        total.value += Math.max(
          0,
          counter.inc + (actual.get(counter.key) ?? 0),
        );
        total.expires_at = Math.max(total.expires_at, counter.expires_at);
        totals.set(counter.key, total);
      }
    }
    const keys = [...totals.keys()];
    const values: { value: string; expires_at: number }[] = [...totals.values()]
      .map((value) => ({ ...value, value: String(value.value) }));
    for (const row of rows) {
      const expiry = Math.max(
        now + 60_000,
        ...row.reservation.map((counter) => counter.expires_at),
      ) + 60_000;
      keys.push(reservationMarker(row.domain_id, row.id));
      values.push({ value: "ok", expires_at: expiry });
      if (!row.settlement) continue;
      const exceeds = row.settlement.some((counter) =>
        counter.expires_at > now &&
        (counter.limit === 0 ||
          counter.limit > 0 &&
            (totals.get(counter.key)?.value ?? 0) > counter.limit)
      );
      const result = row.settlement_result ??
        (exceeds ? "limit_exceeded" : "ok");
      keys.push(settlementMarker(row));
      values.push({ value: result, expires_at: expiry });
      if (row.state === "pending") {
        await tx`UPDATE llm_call_ledger SET state='settled',settlement_result=${result},updated_at=${
          new Date().toISOString()
        } WHERE id=${row.id}`;
      }
    }
    if (keys.length) {
      await redis.eval(REBUILD, keys, [JSON.stringify(values)]);
    }
    return { calls: rows.length, counters: totals.size, unknown };
  }) as { calls: number; counters: number; unknown: number };
}

/** Redis 重启或整库丢失后先重建持久投影，再允许新调用。 */
export async function ensureAccountingReady(
  db: Db,
  redis: RedisClient,
): Promise<void> {
  if (!redis.serverId) throw new Error("redis_server_identity_unavailable");
  const server = await redis.serverId();
  const key = "llm:accounting:ready:v1";
  if (await redis.get(key) === server) return;
  await reconcileAccounting(db, redis);
  await redis.eval("redis.call('SET', KEYS[1], ARGV[1]); return 'ok'", [key], [
    server,
  ]);
}

/** 每 5 秒继续持久结算，重启不依赖进程游标。 */
export function startAccountingWorker(db: Db, redis: RedisClient): () => void {
  const run = () =>
    ensureAccountingReady(db, redis).then(() => retrySettlements(db, redis))
      .catch((error) =>
        logger.warn("LLM结算重试失败: {error}", {
          error: error instanceof Error ? error.message : String(error),
        })
      );
  void run();
  const timer = setInterval(() => void run(), 5000);
  Deno.unrefTimer(timer);
  return () => clearInterval(timer);
}
