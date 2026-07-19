/**
 * 结构化日志与脱敏工具。
 *
 * 提供统一的轻量 logger（零外部依赖），支持：
 * - 级别控制：`LOG_LEVEL`（debug/info/warn/error），默认生产 info、开发 debug
 * - 输出格式：`LOG_FORMAT`（json/pretty），默认生产 json、开发 pretty
 * - 结构化字段优先（借鉴 noj-judge 的 tracing 风格）
 * - 内置脱敏：生产环境自动截断 *_id、隐藏 score、抹除 code/token/secret 等
 * - 自动附带 request_id（通过 AsyncLocalStorage，无需逐层透传）
 * - 可注入 sink，便于测试捕获输出（替代重写 console.*）
 *
 * 所有涉及 submission_id / score / code / token 等敏感字段的日志，
 * 均应通过本模块的 `logger`，由 logger 统一脱敏，避免散落实现导致泄露。
 */

import { AsyncLocalStorage } from "node:async_hooks";

// ── 级别 ──────────────────────────────────────────────────────────────

/** 日志级别。 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * 判断当前是否为生产环境。
 * 通过 NOJ_ENV 环境变量识别；非 production 视为开发/测试环境。
 */
export function isProduction(): boolean {
  return Deno.env.get("NOJ_ENV") === "production";
}

/**
 * 解析当前生效的日志级别。
 *
 * 优先读取 `LOG_LEVEL`；非法或未设置时按环境回退
 * （生产 info，开发/测试 debug）。每次调用重新解析，便于测试动态切换。
 */
function resolveLevel(): LogLevel {
  const raw = Deno.env.get("LOG_LEVEL")?.trim().toLowerCase();
  if (raw && Object.prototype.hasOwnProperty.call(LEVEL_ORDER, raw)) {
    return raw as LogLevel;
  }
  return isProduction() ? "info" : "debug";
}

/** 输出格式。 */
type LogFormat = "json" | "pretty";

/**
 * 解析当前生效的输出格式。
 *
 * 优先读取 `LOG_FORMAT`；非法或未设置时按环境回退
 * （生产 json，开发/测试 pretty）。
 */
function resolveFormat(): LogFormat {
  const raw = Deno.env.get("LOG_FORMAT")?.trim().toLowerCase();
  if (raw === "json" || raw === "pretty") return raw;
  return isProduction() ? "json" : "pretty";
}

// ── 请求上下文（AsyncLocalStorage） ──────────────────────────────────

interface RequestContext {
  requestId: string;
}

const requestStore = new AsyncLocalStorage<RequestContext>();

/**
 * 在带有 request_id 的上下文中执行 `fn`。
 *
 * 由 request-context 中间件在每个 HTTP 请求最外层调用，
 * 使其内部（含 service 层）的所有 logger 调用自动附带同一 request_id。
 */
export function runWithRequestContext<T>(requestId: string, fn: () => T): T {
  return requestStore.run({ requestId }, fn);
}

/** 读取当前请求上下文的 request_id（不在请求上下文中时返回 undefined）。 */
export function getRequestId(): string | undefined {
  return requestStore.getStore()?.requestId;
}

// ── 脱敏 ──────────────────────────────────────────────────────────────

/**
 * 截断 ID 用于日志展示，保留前缀可识别性但避免完整泄露。
 *
 * @example
 * redactId("550e8400-e29b-41d4-a716-446655440000") // "550e8400..."
 */
export function redactId(id: string, visiblePrefix = 8): string {
  if (!id || id.length <= visiblePrefix) return "[redacted]";
  return `${id.slice(0, visiblePrefix)}...`;
}

/** 完全脱敏的敏感字段（值不进入日志）。 */
const SENSITIVE_KEYS = new Set([
  "password",
  "password_hash",
  "token",
  "token_hash",
  "secret",
  "code",
  "email",
  "authorization",
  "cookie",
  "jwt",
]);

/** 需要截断展示的 ID 字段。 */
const ID_KEYS = new Set([
  "submission_id",
  "user_id",
  "problem_id",
  "conversation_id",
  "message_id",
]);

/**
 * 将字段值序列化为可安全 JSON 化的形式。
 * Error 转为 `{name, message}`（开发环境附带 stack）。
 */
function serializeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return isProduction()
      ? { name: value.name, message: value.message }
      : { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

/**
 * 对字段做环境相关脱敏。
 *
 * 开发/测试环境：原样返回（便于本地调试）。
 * 生产环境：敏感 key 抹除、score 隐藏、*_id 截断。
 */
function redactFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  if (!isProduction()) return fields;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lower)) {
      out[key] = "[redacted]";
      continue;
    }
    if (lower === "score") {
      // 分值在生产日志中隐藏（沿用既有策略）
      continue;
    }
    if (ID_KEYS.has(lower) || lower.endsWith("_id")) {
      out[key] = typeof value === "string" ? redactId(value) : value;
      continue;
    }
    out[key] = value;
  }
  return out;
}

// ── Sink（输出目的地） ────────────────────────────────────────────────

/** 结构化日志记录。 */
export interface LogRecord {
  ts: string;
  level: LogLevel;
  msg: string;
  request_id?: string;
  fields: Record<string, unknown>;
}

/** 日志输出目的地。默认写 console；测试可替换以捕获记录。 */
export type LogSink = (record: LogRecord) => void;

/** 格式化 pretty 模式下的单个字段值。 */
function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return /\s/.test(value) ? JSON.stringify(value) : value;
  }
  if (value === null || value === undefined) return String(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** 默认 sink：按 LOG_FORMAT 格式化后写入 console。 */
function defaultSink(record: LogRecord): void {
  let line: string;
  if (resolveFormat() === "json") {
    line = JSON.stringify({
      ts: record.ts,
      level: record.level,
      msg: record.msg,
      ...(record.request_id ? { request_id: record.request_id } : {}),
      ...record.fields,
    });
  } else {
    const time = record.ts.slice(11, 23); // HH:MM:SS.mmm
    const rid = record.request_id
      ? ` rid=${record.request_id.slice(0, 8)}`
      : "";
    const fieldStr = Object.entries(record.fields)
      .map(([k, v]) => `${k}=${formatValue(v)}`)
      .join(" ");
    line = `[${time}] ${record.level.toUpperCase().padEnd(5)} ${record.msg}` +
      `${rid}${fieldStr ? " " + fieldStr : ""}`;
  }

  // warn/error 走 stderr，其余走 stdout
  if (record.level === "warn" || record.level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

let currentSink: LogSink = defaultSink;

/** 替换日志 sink（测试用，用于捕获日志记录）。 */
export function setLogSink(sink: LogSink): void {
  currentSink = sink;
}

/** 恢复默认 sink（测试清理用）。 */
export function resetLogSink(): void {
  currentSink = defaultSink;
}

// ── 核心 emit + logger ────────────────────────────────────────────────

function emit(
  level: LogLevel,
  msg: string,
  fields?: Record<string, unknown>,
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[resolveLevel()]) return;

  const serialized: Record<string, unknown> = {};
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      serialized[k] = serializeValue(v);
    }
  }

  const record: LogRecord = {
    ts: new Date().toISOString(),
    level,
    msg,
    request_id: getRequestId(),
    fields: redactFields(serialized),
  };
  currentSink(record);
}

/**
 * 结构化 logger。
 *
 * @example
 * logger.info("评测任务入队", { submission_id, queue_length });
 * logger.error("推送失败", { err, submission_id });
 */
export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) =>
    emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) =>
    emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) =>
    emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) =>
    emit("error", msg, fields),
};

// ── 向后兼容的具名日志函数（内部改走 logger） ────────────────────────

/**
 * 输出评测任务入队日志。
 * 脱敏由 logger 统一处理（生产环境截断 submission_id）。
 */
export function logJudgeTaskEnqueued(
  submissionId: string,
  queueLength: number,
  messageBytes: number,
): void {
  logger.info("评测任务入队", {
    submission_id: submissionId,
    queue_length: queueLength,
    size_bytes: messageBytes,
  });
}

/**
 * 输出评测结果接收日志。
 * 脱敏由 logger 统一处理（生产环境截断 submission_id、隐藏 score）。
 */
export function logJudgeResultReceived(
  submissionId: string,
  status: string,
  score: number,
): void {
  logger.info("收到评测结果", {
    submission_id: submissionId,
    status,
    score,
  });
}
