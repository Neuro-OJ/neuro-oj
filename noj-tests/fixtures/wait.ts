/**
 * 统一异步等待原语（P1-A）。
 *
 * E2E 测试原先各自实现"轮询 + 固定 sleep"，既无法把请求耗时计入总预算，也会在
 * 探测失败时静默跳过。本模块把轮询语义收敛为一处：
 *
 * 1. 首次立即读取；未完成时依次等待 100 / 250 / 500 / 1000 毫秒，此后每秒读取；
 * 2. 使用绝对截止时间，单次请求默认最多 5 秒且不超过剩余预算；
 * 3. 请求、JSON 解析与等待全部计入预算，成功后不再创建计时器或发起请求；
 * 4. 401/403/404 等确定性错误立即抛出；网络故障与 5xx 在预算内重试并保留最后错误；
 * 5. 超时错误携带资源 ID、最后状态、最后 HTTP 状态、读取次数与实际耗时；
 * 6. 支持 AbortSignal 取消（包括正在进行的单次请求）。
 *
 * 本模块只依赖 Web 标准 API，便于零依赖单测。
 */

/** 默认退避序列（毫秒）：100、250、500、1000，之后固定每秒。 */
export const DEFAULT_WAIT_BACKOFF_MS = [100, 250, 500, 1000] as const;

/** 单次读取的默认上限（毫秒），且永不超过剩余总预算。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

/** 轮询参数。 */
export interface WaitOptions<T> {
  /** 总预算（毫秒），从调用时刻开始计算。 */
  timeoutMs: number;
  /** 单次读取上限（毫秒），默认 5000，且不超过剩余预算。 */
  requestTimeoutMs?: number;
  /** 取消信号；在读取或等待期间取消都会立即结束。 */
  signal?: AbortSignal;
  /** 资源标识（如 submission ID），用于超时诊断。 */
  resourceId?: string;
  /** 把未完成的值描述成短状态，用于超时诊断。 */
  describe?: (value: T) => string;
  /** 测试注入：自定义退避序列。 */
  backoffMs?: readonly number[];
  /** 测试注入：时钟（默认 performance.now）。 */
  now?: () => number;
}

/** 读取返回的确定性 HTTP 错误：401/403/404 等直接失败，不重试。 */
export class WaitHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "WaitHttpError";
    this.status = status;
  }
}

/** 单次请求超时：属于可重试故障，最终由总预算决定是否失败。 */
export class WaitRequestTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`单次读取超时（${timeoutMs}ms）`);
    this.name = "WaitRequestTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** 总预算耗尽。字段刻意结构化，便于测试与故障归因。 */
export class WaitTimeoutError extends Error {
  readonly resourceId: string;
  readonly lastState: string;
  readonly lastHttpStatus: number;
  readonly reads: number;
  readonly elapsedMs: number;
  readonly lastError?: unknown;

  constructor(input: {
    resourceId: string;
    lastState: string;
    lastHttpStatus: number;
    reads: number;
    elapsedMs: number;
    timeoutMs: number;
    lastError?: unknown;
  }) {
    const errorDetail = input.lastError === undefined
      ? ""
      : `，最后错误：${
        input.lastError instanceof Error
          ? input.lastError.message
          : String(input.lastError)
      }`;
    super(
      `等待 ${input.resourceId} 超时（预算 ${input.timeoutMs}ms，实际 ${input.elapsedMs}ms，` +
        `${input.reads} 次读取），最后状态 ${input.lastState}，最后 HTTP ${
          input.lastHttpStatus || "(未取得)"
        }${errorDetail}`,
    );
    this.name = "WaitTimeoutError";
    this.resourceId = input.resourceId;
    this.lastState = input.lastState;
    this.lastHttpStatus = input.lastHttpStatus;
    this.reads = input.reads;
    this.elapsedMs = input.elapsedMs;
    this.lastError = input.lastError;
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ??
    new DOMException("等待已被取消", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

/** 4xx（408/425/429 除外）视为确定性错误：重试不会改变结果。 */
function isFatalWaitError(error: unknown): boolean {
  if (!(error instanceof WaitHttpError)) return false;
  const status = error.status;
  if (status === 408 || status === 425 || status === 429) return false;
  return status >= 400 && status < 500;
}

/** 可取消的 sleep；计时器在取消时清理。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 读取与取消信号竞速：读取不响应 signal 时也不会拖住调用方。 */
function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * 轮询直到 `isDone` 返回 true。
 *
 * 首次读取立即执行；未完成时按退避序列等待。读取抛出的 `WaitHttpError`
 * 决定是否重试：4xx（408/425/429 除外）立即失败，5xx 与网络错误在预算内重试。
 *
 * @param read 读取函数；接收的 signal 会在单次请求超时或外部取消时触发
 * @param isDone 判定是否完成
 * @param options 总预算、单次上限、取消信号与诊断标签
 */
export async function waitUntil<T>(
  read: (signal: AbortSignal) => Promise<T>,
  isDone: (value: T) => boolean,
  options: WaitOptions<T>,
): Promise<T> {
  const now = options.now ?? (() => performance.now());
  const timeoutMs = Math.max(0, options.timeoutMs);
  const started = now();
  const deadline = started + timeoutMs;
  const backoff = options.backoffMs ?? DEFAULT_WAIT_BACKOFF_MS;
  const resourceId = options.resourceId ?? "资源";
  const signal = options.signal;

  let reads = 0;
  let lastState = "(未取得)";
  let lastHttpStatus = 0;
  let lastError: unknown;

  const timeoutError = (): WaitTimeoutError =>
    new WaitTimeoutError({
      resourceId,
      lastState,
      lastHttpStatus,
      reads,
      elapsedMs: Math.max(0, Math.round(now() - started)),
      timeoutMs,
      ...(lastError === undefined ? {} : { lastError }),
    });

  throwIfAborted(signal);

  while (true) {
    const remaining = deadline - now();
    if (remaining <= 0) throw timeoutError();

    const requestBudget = Math.max(
      1,
      Math.min(
        options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        remaining,
      ),
    );
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort(abortReason(signal!));
    signal?.addEventListener("abort", onOuterAbort, { once: true });
    const requestTimer = setTimeout(
      () => controller.abort(new WaitRequestTimeoutError(requestBudget)),
      requestBudget,
    );
    reads++;

    let value: T;
    try {
      const pending = read(controller.signal);
      // 读取自身的同步异常也要走统一分类。
      value = await raceWithAbort(pending, controller.signal);
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      if (error instanceof WaitHttpError) lastHttpStatus = error.status;
      lastError = error;
      if (isFatalWaitError(error)) throw error;
      if (now() >= deadline) throw timeoutError();
      const delay = backoff[Math.min(reads - 1, backoff.length - 1)] ?? 1000;
      await sleep(Math.min(delay, Math.max(0, deadline - now())), signal);
      continue;
    } finally {
      clearTimeout(requestTimer);
      signal?.removeEventListener("abort", onOuterAbort);
    }

    if (isDone(value)) return value;

    lastState = options.describe?.(value) ?? "(未完成)";
    lastError = undefined;
    const remainingAfterRead = deadline - now();
    if (remainingAfterRead <= 0) throw timeoutError();
    const delay = backoff[Math.min(reads - 1, backoff.length - 1)] ?? 1000;
    // 下一次读取至少要等 delay：预算不够就现在失败，避免无意义地睡过截止时间。
    if (remainingAfterRead <= delay) throw timeoutError();
    await sleep(delay, signal);
  }
}
