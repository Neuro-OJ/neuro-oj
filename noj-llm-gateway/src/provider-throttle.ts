/**
 * Provider 级上游速率控制（RPM / TPM）与超限排队。
 *
 * 上游（如 SiliconFlow / OpenAI）按账号限制每分钟请求数与 token 数，超出即 429。
 * gateway 在转发前按 Provider 的 `rpm_limit` / `tpm_limit` 自行节流：超限的请求
 * **排队等待**而不是直接失败，等待超过 `NOJ_LLM_PROVIDER_QUEUE_TIMEOUT_SECONDS`
 * 才返回 429。
 *
 * 实现要点（多副本安全，全部状态在 Redis，无进程内可变状态）：
 * - 滑动窗口：`rpm` ZSET（member=请求 ID）与 `tpm` ZSET（member=`<ID>|<tokens>`），
 *   score 为放行时刻（毫秒，取 Redis `TIME`，避免各副本时钟漂移）；
 * - 公平排队：`queue` ZSET 按自增票号排序，只有队首可以占用额度（FIFO，
 *   大请求不会被小请求持续插队饿死）；
 * - 失联清理：等待者每次轮询刷新 `hb` 心跳，队首心跳超时（副本崩溃 / 进程被杀）
 *   即被移出队列，不会永久堵塞；
 * - TPM 先按估算值（prompt 估算 + max_tokens）占用，响应后用上游实际用量修正。
 */
import type { RedisClient } from "./redis.ts";

/** 默认滑动窗口：1 分钟。 */
const WINDOW_MS = 60_000;
/** 等待者心跳超时：超过该时长未轮询的队首视为失联。 */
const STALE_MS = 5_000;
/** 非队首等待者的轮询间隔。 */
const QUEUE_POLL_MS = 200;
/** 队首等待额度释放时的最短 / 最长轮询间隔（须明显小于 STALE_MS）。 */
const MIN_POLL_MS = 20;
const MAX_POLL_MS = 1_000;

/**
 * 原子完成：清理过期窗口 → 登记排队与心跳 → 清理失联队首 → 队首检查额度并占用。
 *
 * KEYS: rpm, tpm, queue, hb, seq
 * ARGV: id, tokens, rpmLimit, tpmLimit, staleMs, windowMs
 * 返回 `{admitted(0|1), waitMs, rank}`：
 * - `{1, 0, 0}` 已放行并计入窗口；
 * - `{0, 0, rank}` 前面还有 rank 个等待者；
 * - `{0, waitMs, 0}` 已是队首，最早 waitMs 毫秒后窗口才有足够余量。
 */
const ACQUIRE_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local id = ARGV[1]
local tokens = tonumber(ARGV[2])
local rpm = tonumber(ARGV[3])
local tpm = tonumber(ARGV[4])
local stale = tonumber(ARGV[5])
local window = tonumber(ARGV[6])
local ttl = math.ceil(window / 1000) * 2 + 60

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - window)

if not redis.call('ZSCORE', KEYS[3], id) then
  local seq = redis.call('INCR', KEYS[5])
  redis.call('ZADD', KEYS[3], seq, id)
end
redis.call('HSET', KEYS[4], id, now)
redis.call('EXPIRE', KEYS[3], ttl)
redis.call('EXPIRE', KEYS[4], ttl)
redis.call('EXPIRE', KEYS[5], ttl)

while true do
  local head = redis.call('ZRANGE', KEYS[3], 0, 0)[1]
  if (not head) or head == id then break end
  local seen = tonumber(redis.call('HGET', KEYS[4], head) or '0')
  if seen >= now - stale then break end
  redis.call('ZREM', KEYS[3], head)
  redis.call('HDEL', KEYS[4], head)
end

local rank = redis.call('ZRANK', KEYS[3], id)
if rank > 0 then return {0, 0, rank} end

local wait = 0
if rpm > 0 then
  local count = redis.call('ZCARD', KEYS[1])
  if count >= rpm then
    local entry = redis.call('ZRANGE', KEYS[1], count - rpm, count - rpm, 'WITHSCORES')
    wait = math.max(wait, tonumber(entry[2]) + window - now)
  end
end
if tpm > 0 then
  local entries = redis.call('ZRANGE', KEYS[2], 0, -1, 'WITHSCORES')
  local used = 0
  for i = 1, #entries, 2 do
    used = used + tonumber(string.match(entries[i], '|(%d+)$') or '0')
  end
  -- 窗口为空时即使单个请求超过 TPM 也放行，否则会永久阻塞
  if used > 0 and used + tokens > tpm then
    local freed = 0
    for i = 1, #entries, 2 do
      freed = freed + tonumber(string.match(entries[i], '|(%d+)$') or '0')
      if used - freed + tokens <= tpm or used - freed == 0 then
        wait = math.max(wait, tonumber(entries[i + 1]) + window - now)
        break
      end
    end
  end
end
if wait > 0 then return {0, wait, 0} end

redis.call('ZADD', KEYS[1], now, id)
redis.call('ZADD', KEYS[2], now, id .. '|' .. tokens)
redis.call('EXPIRE', KEYS[1], ttl)
redis.call('EXPIRE', KEYS[2], ttl)
redis.call('ZREM', KEYS[3], id)
redis.call('HDEL', KEYS[4], id)
return {1, 0, 0}
`;

/** 退出排队（超时 / 客户端断开）。KEYS: queue, hb；ARGV: id */
const LEAVE_QUEUE_SCRIPT = `
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
return 1
`;

/** 归还已占用的窗口额度（请求未真正发往上游）。KEYS: rpm, tpm；ARGV: id, tokens */
const RELEASE_SCRIPT = `
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1] .. '|' .. ARGV[2])
return 1
`;

/** 用实际 token 修正 TPM 窗口记录，保留原放行时刻。KEYS: tpm；ARGV: id, old, new */
const SETTLE_SCRIPT = `
local old = ARGV[1] .. '|' .. ARGV[2]
local score = redis.call('ZSCORE', KEYS[1], old)
if score then
  redis.call('ZREM', KEYS[1], old)
  redis.call('ZADD', KEYS[1], score, ARGV[1] .. '|' .. ARGV[3])
end
return 1
`;

/** 某 Provider 的限流键（hash tag 保证 Redis Cluster 下同槽）。 */
export function providerThrottleKeys(providerId: string): {
  rpm: string;
  tpm: string;
  queue: string;
  hb: string;
  seq: string;
} {
  const base = `llm:provider:{${providerId}}`;
  return {
    rpm: `${base}:rpm`,
    tpm: `${base}:tpm`,
    queue: `${base}:queue`,
    hb: `${base}:queue-hb`,
    seq: `${base}:queue-seq`,
  };
}

/** 排队超时：调用方应返回 429，并提示 `retryAfterSeconds` 后重试。 */
export class ProviderQueueTimeoutError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super("provider_queue_timeout");
    this.name = "ProviderQueueTimeoutError";
  }
}

/** 排队期间客户端断开（请求已中止），调用方无需再响应。 */
export class ProviderQueueAbortedError extends Error {
  constructor() {
    super("provider_queue_aborted");
    this.name = "ProviderQueueAbortedError";
  }
}

/** 已放行的一次上游调用占用的额度；无限制时为空操作。 */
export interface ProviderSlot {
  /** 本次请求在排队中等待的毫秒数（未排队为 0） */
  waitedMs: number;
  /** 请求未发往上游（如额度校验拒绝）时归还窗口额度 */
  release(): Promise<void>;
  /** 用上游返回的实际 token 数修正 TPM 记录 */
  settle(actualTokens: number): Promise<void>;
}

/** 等待 Provider 速率额度的参数。 */
export interface AcquireProviderSlotOptions {
  providerId: string;
  /** 每分钟请求数上限（0 = 不限） */
  rpmLimit: number;
  /** 每分钟 token 上限（0 = 不限） */
  tpmLimit: number;
  /** 本次请求预估占用的 token（prompt 估算 + max_tokens） */
  tokens: number;
  /** 最长排队毫秒数；0 表示不排队，超限立即超时 */
  timeoutMs: number;
  /** 客户端断开时中止排队 */
  signal?: AbortSignal;
  /** 滑动窗口长度（测试注入；默认 60 秒） */
  windowMs?: number;
}

const NOOP_SLOT: ProviderSlot = {
  waitedMs: 0,
  release: () => Promise.resolve(),
  settle: () => Promise.resolve(),
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ProviderQueueAbortedError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProviderQueueAbortedError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function parseAcquireResult(raw: unknown): {
  admitted: boolean;
  waitMs: number;
  rank: number;
} {
  const arr = Array.isArray(raw) ? raw.map(Number) : [];
  return {
    admitted: arr[0] === 1,
    waitMs: Number.isFinite(arr[1]) ? Math.max(0, arr[1]) : 0,
    rank: Number.isFinite(arr[2]) ? Math.max(0, arr[2]) : 0,
  };
}

/**
 * 按 Provider 的 RPM / TPM 上限获取一次上游调用额度；超限时排队等待。
 *
 * 两个上限都为 0 时直接放行，不访问 Redis。
 *
 * @throws {ProviderQueueTimeoutError} 等待超过 timeoutMs
 * @throws {ProviderQueueAbortedError} 排队期间 signal 中止（客户端断开）
 */
export async function acquireProviderSlot(
  redis: RedisClient,
  opts: AcquireProviderSlotOptions,
): Promise<ProviderSlot> {
  const rpmLimit = Math.max(0, Math.floor(opts.rpmLimit || 0));
  const tpmLimit = Math.max(0, Math.floor(opts.tpmLimit || 0));
  if (rpmLimit === 0 && tpmLimit === 0) return NOOP_SLOT;

  const keys = providerThrottleKeys(opts.providerId);
  const id = crypto.randomUUID();
  const tokens = Math.max(0, Math.floor(opts.tokens || 0));
  const windowMs = opts.windowMs ?? WINDOW_MS;
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(0, opts.timeoutMs);

  const leaveQueue = () =>
    redis.eval(LEAVE_QUEUE_SCRIPT, [keys.queue, keys.hb], [id])
      .catch(() => undefined);

  while (true) {
    const result = parseAcquireResult(
      await redis.eval(
        ACQUIRE_SCRIPT,
        [keys.rpm, keys.tpm, keys.queue, keys.hb, keys.seq],
        [id, tokens, rpmLimit, tpmLimit, STALE_MS, windowMs],
      ),
    );
    if (result.admitted) {
      let settledTokens = tokens;
      return {
        waitedMs: Date.now() - startedAt,
        release: async () => {
          await redis.eval(RELEASE_SCRIPT, [keys.rpm, keys.tpm], [
            id,
            settledTokens,
          ]);
        },
        settle: async (actualTokens: number) => {
          const next = Math.max(0, Math.floor(actualTokens || 0));
          if (next === settledTokens) return;
          await redis.eval(SETTLE_SCRIPT, [keys.tpm], [
            id,
            settledTokens,
            next,
          ]);
          settledTokens = next;
        },
      };
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      await leaveQueue();
      const retryAfterMs = result.waitMs > 0 ? result.waitMs : 1_000;
      throw new ProviderQueueTimeoutError(Math.ceil(retryAfterMs / 1000));
    }
    const pollMs = result.rank > 0
      ? QUEUE_POLL_MS
      : Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, result.waitMs));
    try {
      await sleep(Math.min(pollMs, remaining), opts.signal);
    } catch (err) {
      await leaveQueue();
      throw err;
    }
  }
}
