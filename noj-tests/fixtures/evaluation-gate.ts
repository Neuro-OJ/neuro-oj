/**
 * E2E 显式同步屏障客户端（零依赖）。
 *
 * LLM 治理 Browser 用例需要「evaluator 已经到达、但还没有调用真实 LLM」这一确定
 * 状态：等待方是 evaluator 内生成的 Python 脚本，测试进程负责观察到达计数、在
 * 中途经 UI 修改模型别名，然后释放屏障。这样替代原来的固定 20 秒休眠，既不白等
 * 也不受机器快慢影响。
 *
 * 地址分两套，不能混用：
 * - `hostUrl`：测试进程（宿主机）访问的管理地址，只允许 loopback；
 * - `evaluatorUrl`：写进容器内评测脚本的地址，必须是 evaluator 所在 Docker 网络
 *   内可达的服务名（E2E 为 `noj-eval-net` 上的 `noj-e2e-test-coordinator`）。
 *
 * 错误一律以 `EvaluationGateError` 抛出并带 `kind`，让用例区分「服务缺失」「gate
 * 不存在」「等待超时」等情况，而不是都变成一个超时字符串。
 */

/** 屏障等待上限：必须短于 evaluator 的 60 秒总时限。 */
export const EVALUATION_GATE_WAIT_LIMIT_MS = 45_000;

/** 单次 HTTP 请求的默认超时（不含阻塞等待）。 */
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * 主机侧管理地址默认值。
 *
 * docker-compose.e2e.yml 只把它绑定在宿主 loopback，端口与容器内的 8010 故意
 * 不同：主机地址和 evaluator 地址是两套东西，弄混会把容器网络名写进测试进程。
 */
export const DEFAULT_EVALUATION_GATE_HOST_URL = "http://127.0.0.1:18010";

/** evaluator 容器内的协调服务地址（`noj-eval-net` 网络内服务名）。 */
export const DEFAULT_EVALUATION_GATE_EVALUATOR_URL =
  "http://noj-e2e-test-coordinator:8010";

/** 屏障地址对：主机侧管理与 evaluator 侧调用。 */
export interface EvaluationGatePlacement {
  hostUrl: string;
  evaluatorUrl: string;
}

/** 屏障失败分类。 */
export type EvaluationGateErrorKind =
  /** 连不上协调服务（未启动、端口错误、网络不可达）。 */
  | "unavailable"
  /** gate 不存在（未创建，或已被 DELETE 清理）。 */
  | "missing"
  /** gate ID 已被占用。 */
  | "conflict"
  /** 等待超出屏障上限。 */
  | "timeout"
  /** 调用方主动取消（AbortSignal）。 */
  | "cancelled"
  /** 响应格式或配置不符合约定。 */
  | "protocol"
  /** 地址配置非法（例如把非 loopback 地址当成管理地址）。 */
  | "configuration";

/** 屏障调用失败；`kind` 决定用例如何报错。 */
export class EvaluationGateError extends Error {
  readonly kind: EvaluationGateErrorKind;
  readonly gateId: string | undefined;
  readonly status: number | undefined;

  constructor(
    kind: EvaluationGateErrorKind,
    message: string,
    details: { gateId?: string; status?: number; cause?: unknown } = {},
  ) {
    super(
      message,
      details.cause === undefined ? undefined : {
        cause: details.cause,
      },
    );
    this.name = "EvaluationGateError";
    this.kind = kind;
    this.gateId = details.gateId;
    this.status = details.status;
  }
}

/** 协调服务返回的 gate 状态。 */
export interface EvaluationGateStatus {
  id: string;
  runId: string;
  /** 已到达的等待方数量（相同 nonce 只算一次）。 */
  arrivals: number;
  released: boolean;
  cancelled: boolean;
  /** 当前仍在阻塞的等待请求数，仅用于排查。 */
  waiting: number;
}

/** 阻塞等待的结果。 */
export interface EvaluationGateWaitResult extends EvaluationGateStatus {
  arrival: string;
  timedOut: boolean;
  elapsedMs: number;
}

/** 可替换的 fetch 实现（单测注入用）。 */
export type EvaluationGateFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** 单次调用选项。 */
export interface EvaluationGateRequestOptions {
  /** 单次请求超时；阻塞等待另有 45 秒上限。 */
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: EvaluationGateFetch;
}

/** 阻塞等待选项。 */
export interface EvaluationGateWaitOptions
  extends EvaluationGateRequestOptions {
  /** 覆盖屏障上限（只能缩短，不会超过 45 秒）。 */
  timeoutMs?: number;
}

/** 等待到达的轮询选项。 */
export interface EvaluationGateArrivalOptions
  extends EvaluationGateRequestOptions {
  /** 至少多少个 evaluator 到达后才返回；默认 1（Judge 并发 1 时等两个会死锁）。 */
  minArrivals?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1" ||
    host === "[::1]";
}

/**
 * 解析屏障地址对。
 *
 * @param read 环境变量读取函数（默认 `Deno.env.get`，单测可注入）
 */
export function resolveEvaluationGatePlacement(
  read: (key: string) => string | undefined = (key) => Deno.env.get(key),
): EvaluationGatePlacement {
  const hostUrl = read("E2E_TEST_COORDINATOR_URL") ??
    DEFAULT_EVALUATION_GATE_HOST_URL;
  const evaluatorUrl = read("E2E_TEST_COORDINATOR_EVALUATOR_URL") ??
    DEFAULT_EVALUATION_GATE_EVALUATOR_URL;
  let parsed: URL;
  try {
    parsed = new URL(hostUrl);
  } catch {
    throw new EvaluationGateError(
      "configuration",
      `协调服务管理地址非法：${hostUrl}`,
    );
  }
  if (!isLoopbackHost(parsed.hostname)) {
    // 管理端口只发布在宿主 loopback；指向别处通常是把容器网络地址误当管理地址。
    throw new EvaluationGateError(
      "configuration",
      `协调服务管理地址必须是 loopback：${hostUrl}`,
    );
  }
  return {
    hostUrl: stripTrailingSlash(hostUrl),
    evaluatorUrl: stripTrailingSlash(evaluatorUrl),
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function errorMessage(payload: unknown): string {
  if (
    payload !== null && typeof payload === "object" &&
    typeof (payload as { error?: unknown }).error === "string"
  ) {
    return (payload as { error: string }).error;
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toStatus(payload: unknown, gateId: string): EvaluationGateStatus {
  if (!isRecord(payload)) {
    throw new EvaluationGateError(
      "protocol",
      `协调服务响应不是对象：${gateId}`,
      {
        gateId,
      },
    );
  }
  const { id, run_id: runId, arrivals, released, cancelled, waiting } = payload;
  if (
    typeof id !== "string" || typeof arrivals !== "number" ||
    typeof released !== "boolean" || typeof cancelled !== "boolean" ||
    typeof waiting !== "number"
  ) {
    throw new EvaluationGateError(
      "protocol",
      `协调服务 gate 状态字段非法：${JSON.stringify(payload)}`,
      { gateId },
    );
  }
  return {
    id,
    runId: typeof runId === "string" ? runId : "",
    arrivals,
    released,
    cancelled,
    waiting,
  };
}

interface SendOptions {
  method: string;
  path: string;
  body?: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
  fetchImpl?: EvaluationGateFetch;
  gateId?: string;
}

async function sendJson(
  baseUrl: string,
  options: SendOptions,
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  let timerFired = false;
  const timer = setTimeout(() => {
    timerFired = true;
    controller.abort();
  }, Math.max(1, options.timeoutMs));
  const onAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    let status: number;
    let text: string;
    try {
      const response = await fetchImpl(`${baseUrl}${options.path}`, {
        method: options.method,
        headers: options.body === undefined
          ? undefined
          : { "content-type": "application/json" },
        body: options.body === undefined
          ? undefined
          : JSON.stringify(options.body),
        signal: controller.signal,
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      if (options.signal?.aborted) {
        throw new EvaluationGateError(
          "cancelled",
          `协调服务调用被取消：${options.method} ${options.path}`,
          { gateId: options.gateId, cause: error },
        );
      }
      if (timerFired) {
        throw new EvaluationGateError(
          "timeout",
          `协调服务请求超时（${options.timeoutMs}ms）：${options.method} ${options.path}`,
          { gateId: options.gateId, cause: error },
        );
      }
      throw new EvaluationGateError(
        "unavailable",
        `协调服务不可用：${baseUrl}（${describeError(error)}）`,
        { gateId: options.gateId, cause: error },
      );
    }
    let payload: unknown = null;
    if (text !== "") {
      try {
        payload = JSON.parse(text);
      } catch (error) {
        throw new EvaluationGateError(
          "protocol",
          `协调服务响应不是合法 JSON（${status}）：${text.slice(0, 200)}`,
          { gateId: options.gateId, status, cause: error },
        );
      }
    }
    if (status >= 200 && status < 300) return { status, body: payload };
    const detail = errorMessage(payload);
    const suffix = detail === "" ? "" : `：${detail}`;
    if (status === 404) {
      throw new EvaluationGateError("missing", `gate 不存在${suffix}`, {
        gateId: options.gateId,
        status,
      });
    }
    if (status === 409) {
      throw new EvaluationGateError("conflict", `gate 已存在${suffix}`, {
        gateId: options.gateId,
        status,
      });
    }
    throw new EvaluationGateError(
      "protocol",
      `协调服务返回 ${status}${suffix}`,
      { gateId: options.gateId, status },
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

function gatePath(gateId: string, suffix = ""): string {
  return `/gates/${encodeURIComponent(gateId)}${suffix}`;
}

/** 创建关闭状态的 gate；重复 ID 抛 `conflict`。 */
export async function createEvaluationGate(
  placement: EvaluationGatePlacement,
  spec: { id: string; runId: string },
  options: EvaluationGateRequestOptions = {},
): Promise<EvaluationGateStatus> {
  const { body } = await sendJson(placement.hostUrl, {
    method: "POST",
    path: "/gates",
    body: { id: spec.id, run_id: spec.runId },
    timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
    gateId: spec.id,
  });
  return toStatus(body, spec.id);
}

/** 读取到达数量/释放/取消状态。 */
export async function readEvaluationGate(
  placement: EvaluationGatePlacement,
  gateId: string,
  options: EvaluationGateRequestOptions = {},
): Promise<EvaluationGateStatus> {
  const { body } = await sendJson(placement.hostUrl, {
    method: "GET",
    path: gatePath(gateId),
    timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
    gateId,
  });
  return toStatus(body, gateId);
}

/** 轮询等待至少 `minArrivals` 个 evaluator 到达；超时抛 `timeout`。 */
export async function waitForEvaluationGateArrival(
  placement: EvaluationGatePlacement,
  gateId: string,
  options: EvaluationGateArrivalOptions = {},
): Promise<EvaluationGateStatus> {
  const minArrivals = options.minArrivals ?? 1;
  const budget = Math.min(
    options.timeoutMs ?? EVALUATION_GATE_WAIT_LIMIT_MS,
    EVALUATION_GATE_WAIT_LIMIT_MS,
  );
  const deadline = Date.now() + budget;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  let last: EvaluationGateStatus | undefined;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    last = await readEvaluationGate(placement, gateId, {
      timeoutMs: Math.min(REQUEST_TIMEOUT_MS, remaining),
      signal: options.signal,
      fetchImpl: options.fetchImpl,
    });
    if (last.arrivals >= minArrivals) return last;
    const rest = deadline - Date.now();
    if (rest <= 0) break;
    await delay(Math.min(pollIntervalMs, rest), options.signal);
  }
  throw new EvaluationGateError(
    "timeout",
    `等待 evaluator 到达超时（${budget}ms）：gate=${gateId}` +
      ` arrivals=${last?.arrivals ?? 0} 需要=${minArrivals}`,
    { gateId },
  );
}

/**
 * 阻塞等待 gate 被释放（供 evaluator 侧或定向单测使用）。
 *
 * 上限固定为 45 秒：比 evaluator 的 60 秒总时限短，留出真实 LLM 调用与收尾。
 */
export async function waitForEvaluationGate(
  placement: EvaluationGatePlacement,
  spec: { id: string; arrival: string },
  options: EvaluationGateWaitOptions = {},
): Promise<EvaluationGateWaitResult> {
  const budget = Math.min(
    options.timeoutMs ?? EVALUATION_GATE_WAIT_LIMIT_MS,
    EVALUATION_GATE_WAIT_LIMIT_MS,
  );
  const seconds = (budget / 1000).toFixed(3);
  const { body } = await sendJson(placement.hostUrl, {
    method: "GET",
    path: `${gatePath(spec.id, "/wait")}?arrival=${
      encodeURIComponent(spec.arrival)
    }&timeout=${seconds}`,
    timeoutMs: budget + REQUEST_TIMEOUT_MS,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
    gateId: spec.id,
  });
  const status = toStatus(body, spec.id);
  const payload = body as Record<string, unknown>;
  const timedOut = payload.timed_out === true;
  if (status.cancelled) {
    throw new EvaluationGateError("cancelled", `gate 已被取消：${spec.id}`, {
      gateId: spec.id,
    });
  }
  if (timedOut) {
    throw new EvaluationGateError(
      "timeout",
      `屏障等待超时（${budget}ms）：gate=${spec.id} arrival=${spec.arrival}`,
      { gateId: spec.id },
    );
  }
  return {
    ...status,
    arrival: typeof payload.arrival === "string"
      ? payload.arrival
      : spec.arrival,
    timedOut,
    elapsedMs: typeof payload.elapsed_ms === "number" ? payload.elapsed_ms : 0,
  };
}

/** 幂等释放；释放后新到的等待方立即通过，直到删除。 */
export async function releaseEvaluationGate(
  placement: EvaluationGatePlacement,
  gateId: string,
  options: EvaluationGateRequestOptions = {},
): Promise<EvaluationGateStatus> {
  const { body } = await sendJson(placement.hostUrl, {
    method: "POST",
    path: gatePath(gateId, "/release"),
    body: {},
    timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
    gateId,
  });
  return toStatus(body, gateId);
}

/** 取消等待者并清理 gate。 */
export async function deleteEvaluationGate(
  placement: EvaluationGatePlacement,
  gateId: string,
  options: EvaluationGateRequestOptions = {},
): Promise<void> {
  await sendJson(placement.hostUrl, {
    method: "DELETE",
    path: gatePath(gateId),
    timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
    gateId,
  });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new EvaluationGateError("cancelled", "等待被取消"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new EvaluationGateError("cancelled", "等待被取消"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
