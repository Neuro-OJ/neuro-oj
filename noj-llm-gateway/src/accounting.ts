/** 持久调用账本与 Redis 用量投影。 */
import type { Db } from "./db.ts";
import type { RedisClient } from "./redis.ts";
import type { EvalTokenPayload } from "./crypto.ts";
import { logger } from "./logger.ts";
import { recordUsage, type UsageEntry } from "./usage.ts";
import { accountingBaselineId } from "./accounting-baseline.ts";
import type { ManagedTask } from "./runtime.ts";
import { POLICY_RESERVATION_ADVISORY_LOCK } from "./policy-lock.ts";

export { POLICY_RESERVATION_ADVISORY_LOCK } from "./policy-lock.ts";

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
    // 共享锁覆盖整个“读政策 → 写入 ledger → Redis 预占 → 记录结果”边界。
    // 政策写入在事务内取得同一标识的排他锁，因此不能在预占已冻结其政策后插入。
    await connection`
      SELECT pg_advisory_lock_shared(
        ${POLICY_RESERVATION_ADVISORY_LOCK.classId},
        ${POLICY_RESERVATION_ADVISORY_LOCK.objectId}
      )
    `;
    await connection`SELECT pg_advisory_lock_shared(184789, 3)`;
    return await operation(connection as unknown as Db);
  } finally {
    try {
      await connection`SELECT pg_advisory_unlock_shared(184789, 3)`;
    } finally {
      try {
        await connection`
          SELECT pg_advisory_unlock_shared(
            ${POLICY_RESERVATION_ADVISORY_LOCK.classId},
            ${POLICY_RESERVATION_ADVISORY_LOCK.objectId}
          )
        `;
      } finally {
        connection.release();
      }
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

/** 记账 worker 每轮间隔：5 秒。持久结算依据不依赖进程游标，重启后自动继续。 */
export const ACCOUNTING_TICK_INTERVAL_MS = 5000;

/**
 * 连续失败轮数阈值：连续 3 轮（约 15 秒）失败即视为"持续失败"。
 *
 * 设计依据：worker 每 5 秒一轮。单轮抖动（连接池瞬时超时、Redis 短暂断连）不应把
 * 副本摘出流量；连续 3 轮失败意味着约 15 秒内无法完成真实的 DB/Redis 结算，多副本
 * 部署应转移流量。成功一轮后计数清零。
 */
export const ACCOUNTING_MAX_CONSECUTIVE_FAILURES = 3;

/**
 * 启动宽限期：worker 启动后 30 秒内尚无成功轮次也按健康处理（warming up）。
 *
 * 设计依据：首轮对账（ensureAccountingReady）可能因迁移/预热耗时较长；宽限期内允许
 * 首轮失败 1-2 次并重试。注意连续失败阈值优先于宽限期：首轮失败后每 5 秒重试，连续
 * 3 次即判不健康，不必等满 30 秒；宽限期只容纳"尚未跑完首轮"而非"反复失败"。
 */
export const ACCOUNTING_STARTUP_GRACE_MS = 30_000;

/** 记账 worker 的运行状态快照（只读，供 /health/ready 与运维观测使用）。 */
export interface AccountingWorkerStatus {
  /** 定时器是否仍在运行；stop() 之后为 false。 */
  running: boolean;
  /** worker 启动时刻（epoch 毫秒），用于首轮启动宽限期判定。 */
  startedAt: number;
  /** 最近一次整轮成功的时刻（epoch 毫秒）；从未成功过为 null。 */
  lastSuccessAt: number | null;
  /** 最近一次失败的错误信息（仅供日志/内部观测，不进入 /health/ready 响应体）。 */
  lastError: string | null;
  /** 自上次成功以来连续失败的轮数；成功一轮后清零。 */
  consecutiveFailures: number;
}

/** 记账 worker 健康判定结果；不健康时 reason 为稳定的非敏感类别代码。 */
export interface AccountingWorkerHealth {
  /** 该轮是否可视为健康（可继续接收流量）。 */
  healthy: boolean;
  /** 不健康类别（worker_stopped / worker_persistent_failures / worker_never_succeeded）；健康时为 null。 */
  reason: string | null;
}

/**
 * 判定记账 worker 是否健康（纯函数，便于按固定时钟测试阈值）。
 *
 * @param status 运行状态快照（startAccountingWorker 提供）
 * @param now 当前时刻（epoch 毫秒，测试注入）
 * @returns 健康判定；不健康时给出稳定的非敏感原因代码
 */
export function evaluateAccountingWorkerHealth(
  status: AccountingWorkerStatus,
  now: number = Date.now(),
): AccountingWorkerHealth {
  if (!status.running) {
    return { healthy: false, reason: "worker_stopped" };
  }
  // 连续失败优先于启动宽限期：反复失败已经证明依赖不可用，不能靠宽限期继续接流量。
  if (status.consecutiveFailures >= ACCOUNTING_MAX_CONSECUTIVE_FAILURES) {
    return { healthy: false, reason: "worker_persistent_failures" };
  }
  if (status.lastSuccessAt === null) {
    // 首轮尚未完成（或首轮失败 1-2 次、仍在重试）且仍在宽限期内：视为预热中。
    if (now - status.startedAt < ACCOUNTING_STARTUP_GRACE_MS) {
      return { healthy: true, reason: null };
    }
    // 超过宽限期仍无任何成功轮次（例如首轮对账卡死）：不能继续接流量。
    return { healthy: false, reason: "worker_never_succeeded" };
  }
  return { healthy: true, reason: null };
}

/** 记账 worker 句柄：停止后续轮次并读取状态（优雅关闭由 P5 接入）。 */
export interface AccountingWorkerHandle {
  /** 停止定时器（幂等）；已在执行的轮次允许完成，不中断在途 DB/Redis 操作。 */
  stop(): void;
  /** 停止后等待最后一轮 DB/Redis 操作完成。 */
  done: Promise<void>;
  /** 读取当前运行状态快照（副本，调用方修改不影响 worker 内部状态）。 */
  getStatus(): AccountingWorkerStatus;
}

/**
 * 启动持久结算后台 worker：启动即执行一轮，之后每 5 秒一轮。
 *
 * 状态记录（running / lastSuccessAt / lastError / consecutiveFailures）供
 * /health/ready 判定；本轮同时覆盖"记账就绪检查（ensureAccountingReady）"与
 * "结算重试（retrySettlements）"，任一失败都计入失败轮次。
 *
 * @returns 可停止、可查询状态的 worker 句柄
 */
export function startAccountingWorker(
  db: Db,
  redis: RedisClient,
): AccountingWorkerHandle {
  const status: AccountingWorkerStatus = {
    running: true,
    startedAt: Date.now(),
    lastSuccessAt: null,
    lastError: null,
    consecutiveFailures: 0,
  };
  let inFlight: Promise<void> | null = null;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const settleDone = (): void => {
    if (!status.running && inFlight === null) resolveDone();
  };
  const run = async (): Promise<void> => {
    if (!status.running) return;
    try {
      await ensureAccountingReady(db, redis);
      await retrySettlements(db, redis);
      status.lastSuccessAt = Date.now();
      status.lastError = null;
      status.consecutiveFailures = 0;
    } catch (error) {
      status.consecutiveFailures += 1;
      status.lastError = error instanceof Error ? error.message : String(error);
      logger.warn("LLM结算重试失败: {error}", { error: status.lastError });
    }
  };
  const startRound = (): void => {
    if (!status.running || inFlight !== null) return;
    const current = run();
    inFlight = current;
    current.finally(() => {
      if (inFlight === current) inFlight = null;
      settleDone();
    }).catch(() => {});
  };
  startRound();
  const timer = setInterval(startRound, ACCOUNTING_TICK_INTERVAL_MS);
  Deno.unrefTimer(timer);
  const handle: AccountingWorkerHandle & ManagedTask = {
    name: "gateway-accounting",
    stop() {
      status.running = false;
      clearInterval(timer);
      settleDone();
    },
    getStatus: () => ({ ...status }),
    done,
  };
  done.catch(() => {});
  return handle;
}
