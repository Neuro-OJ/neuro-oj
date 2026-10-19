/**
 * 容器内维护/排空 CLI 客户端（`noj maintain`）。
 *
 * 通过 HTTP 调用 noj-core 的内部排空端点：
 * - `GET  /api/v1/internal/drain/status`
 * - `POST /api/v1/internal/drain/enter`
 * - `POST /api/v1/internal/drain/exit`
 *
 * noj-cli 的自动排空通过
 * `docker compose run --rm --no-deps --entrypoint /app/bin/noj <compose> core maintain ... --json`
 * 调用本模块，因此约定：
 * - `--json` 时 stdout 只输出一个 JSON 文档（进度/错误人类信息走 stderr）；
 * - 退出码 0 = 成功，1 = 失败（包括等待排空超时）；
 * - 旧 Core（无 drain 端点）返回 404/405 → code=endpoint_unavailable，供 noj-cli
 *   过渡期识别后继续升级。
 *
 * 网络与时钟均可注入（fetchImpl/now/sleep/stdout/stderr），便于零依赖单测。
 */

/** 支持的维护子动作。 */
export type MaintainAction = "enter" | "status" | "wait" | "exit";

/**
 * maintain 失败码（稳定取值，noj-cli 据此决定是否中止升级）。
 *
 * - `endpoint_unavailable`：旧 Core 无 drain 端点（HTTP 404/405，过渡期可继续升级）；
 * - `unauthorized`：服务凭据错误（HTTP 401）；
 * - `drain_unavailable`：Core 未配置 NOJ_INTERNAL_SERVICE_TOKEN（HTTP 503）；
 * - `timeout`：单次 HTTP 请求超时；
 * - `not_drained`：wait 在超时时间内未等到排空完成（附最近一次 status data）；
 * - `network_error`：无法连接 Core 内部 API；
 * - `http_error`：其他非 2xx 响应。
 */
export type MaintainFailureCode =
  | "endpoint_unavailable"
  | "unauthorized"
  | "drain_unavailable"
  | "timeout"
  | "not_drained"
  | "network_error"
  | "http_error";

/** fetch 的最小可注入签名（默认使用全局 fetch）。 */
export type MaintainFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** 单次 maintain 调用的可注入选项。 */
export interface MaintainOptions {
  /** Core 内部 API 根地址；默认 env NOJ_CORE_INTERNAL_URL 或 http://core:8000 */
  url?: string;
  /** 服务凭据；默认 env NOJ_INTERNAL_SERVICE_TOKEN */
  token?: string;
  /** wait 超时秒数（默认 1800） */
  timeoutSeconds?: number;
  /** wait 轮询间隔秒数（默认 5） */
  intervalSeconds?: number;
  /** 输出单个 JSON 文档（stdout） */
  json?: boolean;
  /** 注入 fetch（单测用） */
  fetchImpl?: MaintainFetch;
  /** 注入时钟（单测用，毫秒时间戳） */
  now?: () => number;
  /** 注入 sleep（单测用） */
  sleep?: (ms: number) => Promise<void>;
  /** 注入 stdout（单测用；默认 console.log） */
  stdout?: (line: string) => void;
  /** 注入 stderr（单测用；默认 console.error） */
  stderr?: (line: string) => void;
}

/** JSON 模式成功输出文档。 */
export interface MaintainSuccessOutput {
  ok: true;
  data: unknown;
}

/** JSON 模式失败输出文档。 */
export interface MaintainFailureOutput {
  ok: false;
  code: MaintainFailureCode;
  error: string;
  /** 最近一次成功的 status data（wait 超时场景）。 */
  data?: unknown;
}

/** 单次动作的执行结果（内部使用）。 */
type MaintainOutcome =
  | MaintainSuccessOutput
  | MaintainFailureOutput;

/** 内部排空端点相对路径。 */
const DRAIN_STATUS_PATH = "/api/v1/internal/drain/status";
/** 内部进入维护端点相对路径。 */
const DRAIN_ENTER_PATH = "/api/v1/internal/drain/enter";
/** 内部退出维护端点相对路径。 */
const DRAIN_EXIT_PATH = "/api/v1/internal/drain/exit";

/** 构造失败结果。 */
function failure(
  code: MaintainFailureCode,
  message: string,
  data?: unknown,
): MaintainFailureOutput {
  return data === undefined
    ? { ok: false, code, error: message }
    : { ok: false, code, error: message, data };
}

/** 将 unknown 错误转为可读文本。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 宽松解析响应 JSON；非 JSON 返回 null。 */
function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 从错误响应体提取 `code` 字段。 */
function readResponseCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const code = (body as Record<string, unknown>).code;
  return typeof code === "string" ? code : null;
}

/** 从错误响应体提取 `error` 字段。 */
function readResponseError(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const message = (body as Record<string, unknown>).error;
  return typeof message === "string" && message ? message : null;
}

/** 提取响应体中的 `data`（兼容非封套响应）。 */
function readResponseData(body: unknown): unknown {
  if (typeof body === "object" && body !== null && "data" in body) {
    return (body as { data?: unknown }).data;
  }
  return body;
}

/**
 * 调用单个 drain 端点（GET status / POST enter / POST exit）。
 *
 * HTTP 状态到失败码的映射是 noj-cli 过渡逻辑的稳定契约：
 * 401 → unauthorized；404/405 → endpoint_unavailable；503+drain_unavailable →
 * drain_unavailable；网络异常 → network_error；其余非 2xx → http_error。
 */
async function callDrainEndpoint(
  fetchImpl: MaintainFetch,
  url: string,
  token: string,
  method: "GET" | "POST",
): Promise<MaintainOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
  } catch (error) {
    return failure(
      "network_error",
      `无法连接 Core 内部 API（${url}）：${errorMessage(error)}`,
    );
  }

  let text = "";
  try {
    text = await response.text();
  } catch (error) {
    return failure(
      "network_error",
      `读取 Core 内部 API 响应失败（${url}）：${errorMessage(error)}`,
    );
  }
  const body = parseJson(text);
  const bodyCode = readResponseCode(body);
  const bodyError = readResponseError(body);

  if (response.status === 401) {
    return failure("unauthorized", bodyError ?? "内部服务凭据无效");
  }
  if (response.status === 404 || response.status === 405) {
    return failure(
      "endpoint_unavailable",
      "当前 Core 版本未提供排空端点（可能是升级过渡期的旧版本）",
    );
  }
  if (response.status === 503 && bodyCode === "drain_unavailable") {
    return failure(
      "drain_unavailable",
      bodyError ??
        "Core 未配置 NOJ_INTERNAL_SERVICE_TOKEN，排空端点不可用",
    );
  }
  if (response.ok) {
    return { ok: true, data: readResponseData(body) };
  }
  return failure(
    "http_error",
    `Core 内部 API 返回 HTTP ${response.status}${
      bodyError ? `：${bodyError}` : ""
    }`,
  );
}

/** 解析运行配置（参数优先于环境变量）。 */
function resolveConfiguration(options: MaintainOptions): {
  url: string;
  token: string;
} {
  const rawUrl = options.url ?? Deno.env.get("NOJ_CORE_INTERNAL_URL") ??
    "http://core:8000";
  return {
    url: rawUrl.replace(/\/+$/, ""),
    token: options.token ?? Deno.env.get("NOJ_INTERNAL_SERVICE_TOKEN") ?? "",
  };
}

/**
 * 执行维护动作。
 *
 * @param action 维护子动作
 * @param options 可注入选项
 * @param report 人类可读进度回调（JSON 模式下为空操作）
 * @returns 执行结果（成功 data / 失败 code+error）
 */
async function executeMaintain(
  action: MaintainAction,
  options: MaintainOptions,
  report: (line: string) => void,
): Promise<MaintainOutcome> {
  const { url, token } = resolveConfiguration(options);
  if (!token) {
    return failure(
      "drain_unavailable",
      "未配置 NOJ_INTERNAL_SERVICE_TOKEN，无法调用 Core 排空端点",
    );
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const statusUrl = `${url}${DRAIN_STATUS_PATH}`;

  switch (action) {
    case "status":
      return await callDrainEndpoint(fetchImpl, statusUrl, token, "GET");
    case "enter":
      return await callDrainEndpoint(
        fetchImpl,
        `${url}${DRAIN_ENTER_PATH}`,
        token,
        "POST",
      );
    case "exit":
      return await callDrainEndpoint(
        fetchImpl,
        `${url}${DRAIN_EXIT_PATH}`,
        token,
        "POST",
      );
    case "wait": {
      const timeoutMs = Math.max(
        1,
        Math.round((options.timeoutSeconds ?? 1800) * 1000),
      );
      const intervalMs = Math.max(
        1,
        Math.round((options.intervalSeconds ?? 5) * 1000),
      );
      const startedAt = now();
      let lastData: unknown;
      let attempts = 0;
      while (true) {
        const current = await callDrainEndpoint(
          fetchImpl,
          statusUrl,
          token,
          "GET",
        );
        if (!current.ok) return current;
        lastData = current.data;
        attempts += 1;
        const status = current.data as
          | { drained?: boolean; blockers?: unknown }
          | null;
        if (status?.drained === true) {
          report(`[maintain] 已排空（第 ${attempts} 次检查）`);
          return { ok: true, data: current.data };
        }
        if (now() - startedAt >= timeoutMs) {
          return failure(
            "not_drained",
            `等待排空超时（${Math.round(timeoutMs / 1000)}s）`,
            lastData,
          );
        }
        const blockers = Array.isArray(status?.blockers)
          ? status.blockers.join(", ")
          : "unknown";
        report(
          `[maintain] 第 ${attempts} 次检查：尚未排空（blockers: ${blockers}），` +
            `${Math.round(intervalMs / 1000)}s 后重试`,
        );
        await sleep(intervalMs);
      }
    }
  }
}

/** 人类可读模式下的成功输出。 */
function printHumanSuccess(
  action: MaintainAction,
  data: unknown,
  stdout: (line: string) => void,
): void {
  switch (action) {
    case "enter":
    case "exit": {
      const change = data as
        | { maintenance?: boolean; changed?: boolean }
        | null;
      stdout(
        `[maintain] 维护模式已${change?.maintenance ? "进入" : "退出"}` +
          `（changed=${change?.changed === true}）`,
      );
      return;
    }
    case "wait":
    case "status": {
      const status = data as
        | {
          maintenance?: boolean;
          drained?: boolean;
          blockers?: unknown;
          redis_ok?: boolean;
          judge?: { required?: boolean; reporting?: number };
          attempts?: { in_flight?: number };
        }
        | null;
      stdout(`[maintain] 维护模式：${status?.maintenance ? "开启" : "关闭"}`);
      stdout(`[maintain] 排空状态：${status?.drained ? "已排空" : "未排空"}`);
      const blockers = Array.isArray(status?.blockers) && status.blockers.length
        ? status.blockers.join(", ")
        : "无";
      stdout(`[maintain] 阻塞项：${blockers}`);
      stdout(`[maintain] Redis：${status?.redis_ok ? "可用" : "不可用"}`);
      stdout(
        `[maintain] 在飞评测尝试：${status?.attempts?.in_flight ?? 0}；` +
          `Judge Workers：${status?.judge?.reporting ?? 0}（required=${
            status?.judge?.required === true
          }）`,
      );
      return;
    }
  }
}

/**
 * 运行 maintain 子命令（对外唯一入口，返回退出码）。
 *
 * `--json` 时 stdout 只输出一个 JSON 文档：成功 `{ok:true,data}`，
 * 失败 `{ok:false,code,error,data?}`；人工模式输出中文进度。
 *
 * @param action 维护子动作
 * @param options 可注入选项
 * @returns 进程退出码（0 成功 / 1 失败）
 */
export async function runMaintain(
  action: MaintainAction,
  options: MaintainOptions = {},
): Promise<number> {
  const json = options.json === true;
  const stdout = options.stdout ?? ((line: string) => console.log(line));
  const stderr = options.stderr ?? ((line: string) => console.error(line));
  const report = json ? () => {} : stdout;

  const outcome = await executeMaintain(action, options, report);
  if (json) {
    stdout(JSON.stringify(outcome));
  } else if (outcome.ok) {
    printHumanSuccess(action, outcome.data, stdout);
  } else {
    stderr(`[maintain] 失败（${outcome.code}）：${outcome.error}`);
    if (outcome.data !== undefined) {
      stderr(`[maintain] 最近一次 status：${JSON.stringify(outcome.data)}`);
    }
  }
  return outcome.ok ? 0 : 1;
}
