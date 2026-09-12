/**
 * noj-llm-gateway 日志装配与渲染。
 *
 * 视觉契约见 `dev-docs/engineering/log-conventions.md`。
 * 渲染规则与 noj-core 的 `shared/base/log-format.ts` **同构**，但**独立实现**
 * ——两个 Deno 模块各自部署，跨模块相对导入会破坏 `deno check` 与 exports 边界。
 *
 * LogTape 实测行为（改动前请读计划 Global Constraints）：
 * - `record.message` 是交错数组（文本/值交替），插值键仍留在 `properties`;
 * - 因此呈现层必须按 `rawMessage` 的占位符顺序去重，否则字段区会重复；
 * - formatter 抛错**不会**冒泡到调用方，只记进 `logtape.meta` 且默认不可见。
 */

import {
  configureSync,
  getConsoleSink,
  getLogger,
  getTextFormatter,
  type LogRecord as LtRecord,
  type TextFormatterOptions,
} from "@logtape/logtape";
import { gatewayContextStorage } from "./context.ts";

export type { LtRecord };

export const SGR = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  info: "\x1b[36m",
  debug: "\x1b[90m",
  warn: "\x1b[1;33m",
  error: "\x1b[1;31m",
} as const;

/** 契约级别名。 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** 时间戳列宽（`HH:MM:SS.mmm`）。 */
const TIME_WIDTH = 12;
/** 级别列宽（`padEnd(5)`）。 */
const LEVEL_WIDTH = 5;
/** message 之后的续行缩进列。 */
const MSG_COLUMN = TIME_WIDTH + 2 + LEVEL_WIDTH + 2;

/** 生产环境判定（`NOJ_ENV=production`）。 */
export function isProduction(): boolean {
  return Deno.env.get("NOJ_ENV") === "production";
}

/**
 * 解析当前生效的日志级别。
 *
 * 优先 `LOG_LEVEL`；非法或未设置时按环境回退（生产 warn，否则 debug）。
 * 每次调用重新解析，便于测试动态切换。
 */
export function resolveLevel(): LogLevel {
  const raw = Deno.env.get("LOG_LEVEL")?.trim().toLowerCase();
  if (raw && Object.prototype.hasOwnProperty.call(LEVEL_ORDER, raw)) {
    return raw as LogLevel;
  }
  return isProduction() ? "warn" : "debug";
}

/** LogTape 级别名 → 契约级别名。 */
export function toCoreLevel(lt: string): LogLevel {
  switch (lt) {
    case "trace":
    case "debug":
      return "debug";
    case "warning":
    case "warn":
      return "warn";
    case "error":
    case "fatal":
      return "error";
    default:
      return "info";
  }
}

/** 级别排序（用于动态过滤比较）。 */
export function levelRank(level: LogLevel): number {
  return LEVEL_ORDER[level];
}

/**
 * 按出现顺序解析占位符（`{{` / `}}` 转义不参与）。
 *
 * 先移除 `{{` / `}}` 转义，避免把转义序列误当占位符。
 */
export function orderedPlaceholders(raw: string | readonly string[]): string[] {
  const text = typeof raw === "string" ? raw : raw.join("\u0000");
  const cleaned = text.replace(/\{\{/g, "").replace(/\}\}/g, "");
  return [...cleaned.matchAll(/\{([^{}]*)\}/g)]
    .map((m) => m[1]!.trim())
    .filter((k) => k.length > 0);
}

// ── 脱敏 ──────────────────────────────────────────────────────────────

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
  // 网关特有（契约 §6）
  "api_key",
  "encrypted_api_key",
  "eval_token",
  "service_token",
  "store_key",
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
 * 截断 ID 用于日志展示，保留前缀可识别性但避免完整泄露。
 *
 * @example
 * redactId("550e8400-e29b-41d4-a716-446655440000") // "550e8400..."
 */
export function redactId(id: string, visiblePrefix = 8): string {
  if (!id || id.length <= visiblePrefix) return "[redacted]";
  return `${id.slice(0, visiblePrefix)}...`;
}

/** Error → 契约形状（生产去掉 stack）。 */
export function serializeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return isProduction()
      ? { name: value.name, message: value.message }
      : { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

/**
 * 按字段名对单个值套用脱敏规则。
 *
 * 迁移到消息模板后敏感值会**进入 message**，字段区脱敏管不到它；
 * 不按占位符名逐值脱敏会造成生产环境明文泄露。
 */
export function redactValueByKey(key: string, value: unknown): unknown {
  if (!isProduction()) return serializeValue(value);
  const lower = key.toLowerCase();
  if (SENSITIVE_KEYS.has(lower)) return "[redacted]";
  if (lower === "score") return "[redacted]";
  if (ID_KEYS.has(lower) || lower.endsWith("_id")) {
    return typeof value === "string" ? redactId(value) : serializeValue(value);
  }
  // 客户端 IP 在生产日志中不做完整记录（隐私最小化）
  if (lower === "client_ip" || lower === "ip" || lower === "ips") {
    return "[redacted]";
  }
  return serializeValue(value);
}

/** 对字段对象批量脱敏。 */
export function redactFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const redacted = redactValueByKey(key, value);
    if (isProduction() && key.toLowerCase() === "score") continue;
    out[key] = redacted;
  }
  return out;
}

// ── 渲染 ──────────────────────────────────────────────────────────────

/** 渲染单个字段值：字符串不加引号（与既有输出形状一致）。 */
export function formatFieldValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * 重建 message，对插值位置按占位符名逐值脱敏。
 *
 * `record.message` 是交错数组（文本/值交替），占位符名按 `rawMessage`
 * 的出现顺序解析，二者一一对应。
 */
export function renderableMessage(record: LtRecord): string {
  const parts = record.message as readonly unknown[];
  const ordered = orderedPlaceholders(
    record.rawMessage as string | readonly string[],
  );
  const out: string[] = [];
  let vi = 0;
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      out.push(String(parts[i] ?? ""));
    } else {
      out.push(
        formatFieldValue(redactValueByKey(ordered[vi++] ?? "", parts[i])),
      );
    }
  }
  return out.join("");
}

/**
 * 呈现用字段列表：脱敏后剔除 `request_id` 与已插值键。
 *
 * 去重只发生在**呈现层**——`LogRecord.fields` 仍保留全部字段。
 */
export function renderableFields(record: LtRecord): [string, unknown][] {
  const skip = new Set(
    orderedPlaceholders(record.rawMessage as string | readonly string[]),
  );
  skip.add("request_id");
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record.properties)) {
    if (!skip.has(k)) kept[k] = v;
  }
  return Object.entries(redactFields(kept));
}

/** LogTape 传给 `format` 回调的形状（仅取用到的字段）。 */
export interface FormattedValues {
  timestamp?: string;
  record: LtRecord;
}

/** 渲染契约单行布局（pretty）。 */
export function formatPretty(
  values: FormattedValues,
  opts: { color: boolean },
): string {
  const record = values.record;
  const level = toCoreLevel(record.level);
  const time = values.timestamp ?? "";
  const rid = typeof record.properties.request_id === "string"
    ? record.properties.request_id.slice(0, 8)
    : undefined;

  const parts: string[] = [];
  parts.push(opts.color ? `${SGR.dim}${time}${SGR.reset}` : time, "  ");
  const badge = level.toUpperCase().padEnd(LEVEL_WIDTH);
  parts.push(opts.color ? `${SGR[level]}${badge}${SGR.reset}` : badge, "  ");

  const indent = " ".repeat(MSG_COLUMN);
  parts.push(renderableMessage(record).split("\n").join(`\n${indent}`));

  if (rid) {
    parts.push(
      "  ",
      opts.color ? `${SGR.dim}rid=${rid}${SGR.reset}` : `rid=${rid}`,
    );
  }
  const entries = renderableFields(record);
  if (entries.length > 0) {
    parts.push(
      "  ",
      entries
        .map(([k, v]) =>
          opts.color
            ? `${SGR.dim}${k}=${SGR.reset}${formatFieldValue(v)}`
            : `${k}=${formatFieldValue(v)}`
        )
        .join("  "),
    );
  }
  const line = parts.join("");
  return opts.color && (level === "warn" || level === "error")
    ? `${SGR.bold}${line}${SGR.reset}`
    : line;
}

/** 构造 pretty formatter。 */
export function makeGatewayPrettyFormatter(
  opts: { color: boolean },
): (record: LtRecord) => string {
  const options: TextFormatterOptions = {
    timestamp: "time",
    value: (v: unknown) => formatFieldValue(v),
    format: (values) => formatPretty(values as FormattedValues, opts),
  };
  return getTextFormatter(options);
}

/** 构造契约形状的 JSON formatter。 */
export function makeGatewayJsonFormatter(): (record: LtRecord) => string {
  return (record: LtRecord): string => {
    const fields = redactFields(record.properties);
    const rid = fields.request_id;
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (k === "request_id") continue;
      rest[k] = v instanceof Error ? serializeValue(v) : v;
    }
    return JSON.stringify({
      ts: new Date(record.timestamp).toISOString(),
      level: toCoreLevel(record.level),
      msg: renderableMessage(record),
      ...(rid === undefined ? {} : { request_id: rid }),
      ...rest,
    });
  };
}

// ── 着色与格式策略（契约 §3）──────────────────────────────────────────

/** 着色策略的有效值。 */
export type ColorPolicy = "off" | "on" | "auto";

/** 解析 LOG_COLOR（大小写不敏感），非法值按 auto 处理。 */
export function describeColorPolicy(): ColorPolicy {
  const raw = Deno.env.get("LOG_COLOR")?.trim().toLowerCase();
  if (raw === "never") return "off";
  if (raw === "always") return "on";
  return "auto";
}

/** 解析输出格式（生产 json，否则 pretty）。 */
export function resolveFormat(): "json" | "pretty" {
  const raw = Deno.env.get("LOG_FORMAT")?.trim().toLowerCase();
  if (raw === "json" || raw === "pretty") return raw;
  return isProduction() ? "json" : "pretty";
}

/** 按流探测 TTY。 */
function isTty(stream: "stdout" | "stderr"): boolean {
  try {
    return stream === "stderr"
      ? Deno.stderr.isTerminal()
      : Deno.stdout.isTerminal();
  } catch {
    return false; // 无 TTY 支持的环境（部分嵌入运行时）保守关色
  }
}

/**
 * 判定某流是否着色（契约 §3）。
 *
 * `LOG_FORMAT=json` 优先于一切开关，专门防止 ANSI 转义码写进结构化日志流。
 */
export function resolveColor(stream: "stdout" | "stderr"): boolean {
  if (resolveFormat() === "json") return false;
  const noColor = Deno.env.get("NO_COLOR");
  if (noColor !== undefined && noColor !== "") return false;
  switch (describeColorPolicy()) {
    case "off":
      return false;
    case "on":
      return true;
    default:
      return isTty(stream);
  }
}

/** 动态级别过滤（每次评估重新解析，便于测试切换）。 */
function dynamicLevelFilter(record: LtRecord): boolean {
  return levelRank(toCoreLevel(record.level)) >= levelRank(resolveLevel());
}

/**
 * 装配网关 LogTape。幂等，可重复调用。
 *
 * 内部使用 `reset: true`——`configureSync` 重复调用会抛 `ConfigError`，
 * 而测试需要重复装配。
 */
export function setupGatewayLogging(): void {
  const format = resolveFormat();
  const makeFormatter = (stream: "stdout" | "stderr") => {
    const color = resolveColor(stream);
    return format === "json"
      ? makeGatewayJsonFormatter()
      : makeGatewayPrettyFormatter({ color });
  };
  const outFormatter = makeFormatter("stdout");
  const errFormatter = makeFormatter("stderr");

  // console sink 自身负责把 warn/error 送到 stderr、其余送到 stdout
  // （契约 §3 硬规则 1），因此这里只需按目标流决定是否着色。
  const consoleSink = getConsoleSink({
    formatter: (record: LtRecord) => {
      const level = toCoreLevel(record.level);
      const isErr = level === "warn" || level === "error";
      return (isErr ? errFormatter : outFormatter)(record);
    },
  });

  configureSync({
    reset: true,
    sinks: { target: consoleSink },
    filters: { level: dynamicLevelFilter },
    contextLocalStorage: gatewayContextStorage,
    loggers: [
      {
        category: [],
        sinks: ["target"],
        filters: ["level"],
        lowestLevel: "trace",
      },
      // meta logger 单独可见：LogTape 自身的失败（如 formatter 抛错）
      // 只记在这里，不配就完全静默（实测的静默失败面）。
      {
        category: ["logtape", "meta"],
        sinks: ["target"],
        lowestLevel: "warning",
      },
    ],
  });
}

/**
 * 网关 logger 门面。
 *
 * 与 core 的兼容层同形：`(msg, fields?)`，内部转成 LogTape 原生调用。
 * 注意：**message 必须用 `{key}` 占位符语法**，不要用 JS 模板字符串
 * （LogTape 会把 `${` 当占位符静默消费）。
 */
/**
 * 网关 logger 门面。
 *
 * 与 core 的兼容层同形：`(msg, fields?)`，内部转成 LogTape 原生调用。
 *
 * 注意：**message 必须用 `{key}` 占位符语法**，不要用 JS 模板字符串
 * （LogTape 会把 `${` 当占位符静默消费——这正是本次迁移要修掉的缺陷）。
 * 门面刻意只接受 `(string, fields?)`：模板字符串无法绕过占位符解析，
 * 但签名约束能让静态校验脚本（scripts/check-log-migration.ts）识别调用点。
 */
function emit(
  level: LogLevel,
  msg: string,
  fields?: Record<string, unknown>,
): void {
  const lt = getLogger(GATEWAY_CATEGORY);
  const props = fields ?? {};
  switch (level) {
    case "debug":
      return lt.debug(msg, props);
    case "info":
      return lt.info(msg, props);
    case "warn":
      return lt.warn(msg, props);
    case "error":
      return lt.error(msg, props);
  }
}

/** 网关日志 category。 */
export const GATEWAY_CATEGORY = ["noj", "llm-gateway"] as const;

/** 网关 logger（`(msg, fields?)`）。 */
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
