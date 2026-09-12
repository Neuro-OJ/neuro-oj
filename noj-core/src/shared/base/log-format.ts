/**
 * 日志渲染层：pretty / JSON formatter、脱敏、级别映射。
 *
 * 视觉契约见 `dev-docs/engineering/log-conventions.md`。
 *
 * LogTape 行为要点（均经实测，改动前请读 §Global Constraints）：
 * - `record.message` 是交错数组（长度奇数），不是字符串；
 * - 插值后的键仍保留在 `properties` 中，呈现字段区须排除以免重复；
 * - 级别字符串是 `warning` 而非 `warn`；
 * - `getTextFormatter` 的 `format` 必须是函数。
 */

import type {
  FormattedValues,
  LogRecord as LtRecord,
  TextFormatterOptions,
} from "@logtape/logtape";
import { getTextFormatter } from "@logtape/logtape";

export type { LtRecord };

/** SGR 常量（与视觉契约 §1 一一对应）。 */
export const SGR = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  info: "\x1b[36m",
  debug: "\x1b[90m",
  warn: "\x1b[1;33m",
  error: "\x1b[1;31m",
} as const;

/** core 对外契约级别名。 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

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

/**
 * core 级别名 → LogTape 级别名（`warn` → `warning`）。
 *
 * 实现中不直接调用：级别过滤由 `toCoreLevel` + `levelRank` 完成（把
 * LogTape 的级别映射回 core 词汇再比较）。本函数存在是为了给这层映射
 * 一个**可测的单一事实源**——配置里若误写 `lowestLevel: "warn"`，
 * LogTape 会抛 `TypeError`，而这里的单测锁住"契约名 `warn` ↔
 * LogTape 名 `warning`"的对应关系。
 */
export function toLogTapeLevel(level: LogLevel): string {
  return level === "warn" ? "warning" : level;
}

/** LogTape 级别名 → core 级别名（`warning` → `warn`，`trace`/`fatal` 折叠）。 */
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

/** 级别数值（供动态过滤比较）。 */
export function levelRank(level: LogLevel): number {
  return LEVEL_ORDER[level];
}

/**
 * 按**出现顺序**返回占位符名（含重复），供与交错数组中的值一一对应。
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
 * 免除 id 脱敏的**关联标识**（契约 §6 的显式例外）。
 *
 * `*_id` 通配规则的本意是保护业务实体 id，但 `request_id` 不是业务实体：
 * 它由服务端随机生成、不携带用户隐私，且唯一用途就是**跨服务串联同一次请求**。
 * 一旦被截断成前 8 字符，生产环境的日志就无法与上游/下游对齐，串联能力失效。
 * 该键同时由 pretty 侧自行 `slice(0, 8)` 控制展示长度（契约 §1），
 * 因此 JSON 侧保留完整值不会带来泄露面。
 */
const CORRELATION_KEYS = new Set([
  "request_id",
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
  // 关联标识先于 `*_id` 通配判定，否则会被误截断（见 CORRELATION_KEYS）
  if (CORRELATION_KEYS.has(lower)) return serializeValue(value);
  if (ID_KEYS.has(lower) || lower.endsWith("_id")) {
    return typeof value === "string" ? redactId(value) : serializeValue(value);
  }
  // 非敏感键也要递归：顶层键名匹配不到嵌套结构里的 password/api_key，
  // 整块直通即明文泄露（Error 的 details/context 是典型入口）。
  return redactNested(value);
}

/** 递归深度上限：防御病态深结构。 */
const MAX_REDACT_DEPTH = 6;

/** 超出递归上限时的占位符（fail-closed，绝不原样放行）。 */
export const REDACT_DEPTH_PLACEHOLDER = "[redacted: max-depth]";

/** 自引用结构在遍历中的占位符（避免无限递归与后续 JSON 循环报错）。 */
export const REDACT_CIRCULAR_PLACEHOLDER = "[redacted: circular]";

/**
 * 递归脱敏嵌套结构（对象/数组）中的敏感键。
 *
 * 仅在生产环境生效（调用方已判定）。
 *
 * 两处防御都是 **fail-closed**（返回占位符而非原始子树——原样放行等于把
 * 未脱敏的 `password`/`token` 写进日志）：
 * - 超过 `MAX_REDACT_DEPTH`；
 * - 自引用结构（`seen` 记录当前路径上的对象），否则递归不终止，
 *   且下游 `JSON.stringify` 会直接抛错。
 */
function redactNested(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  const serialized = serializeValue(value);
  if (serialized === null || typeof serialized !== "object") return serialized;
  if (serialized instanceof Error) return serialized;
  if (depth >= MAX_REDACT_DEPTH) return REDACT_DEPTH_PLACEHOLDER;
  if (seen.has(serialized)) return REDACT_CIRCULAR_PLACEHOLDER;
  seen.add(serialized);
  try {
    if (Array.isArray(serialized)) {
      return serialized.map((item) => redactNested(item, depth + 1, seen));
    }
    const out: Record<string, unknown> = {};
    for (
      const [k, v] of Object.entries(serialized as Record<string, unknown>)
    ) {
      const lower = k.toLowerCase();
      if (SENSITIVE_KEYS.has(lower) || lower === "score") {
        out[k] = "[redacted]";
        continue;
      }
      if (CORRELATION_KEYS.has(lower)) {
        out[k] = serializeValue(v);
        continue;
      }
      if (ID_KEYS.has(lower) || lower.endsWith("_id")) {
        out[k] = typeof v === "string"
          ? redactId(v)
          : redactNested(v, depth + 1, seen);
        continue;
      }
      out[k] = redactNested(v, depth + 1, seen);
    }
    return out;
  } finally {
    // 只跟踪「当前路径」：兄弟节点引用同一对象是合法的 DAG，不应误判为环。
    seen.delete(serialized);
  }
}

/**
 * 对字段做环境相关脱敏。
 *
 * 开发/测试：仅做 Error 序列化。生产：敏感键抹除、`score` 隐藏、`*_id` 截断。
 *
 * 逐值委托 `redactValueByKey`，**不重复实现规则**——两条并行的规则副本曾导致
 * `request_id` 豁免只在一条上生效（另一条仍把它截断），这类漂移必须从结构上消除。
 */
export function redactFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (isProduction() && key.toLowerCase() === "score") continue; // 分值隐藏
    out[key] = redactValueByKey(key, value);
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
 * 去重只发生在**呈现层**——`LogRecord.fields` 仍保留全部字段，
 * 否则既有测试对 `fields.submission_id` 的断言会因消息模板化而失败。
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

/** 时间戳列宽（`HH:MM:SS.mmm`）。 */
const TIME_WIDTH = 12;
/** 级别列宽（`padEnd(5)`）。 */
const LEVEL_WIDTH = 5;
/** msg 起始列：时间戳 + 2 + 级别 + 2。 */
const MSG_COLUMN = TIME_WIDTH + 2 + LEVEL_WIDTH + 2;

/** 契约 pretty 布局（视觉契约 §2）。 */
export function formatPretty(
  values: FormattedValues,
  opts: { color: boolean; production: boolean },
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

/**
 * 构造 pretty formatter。
 *
 * 两种着色状态都用 `getTextFormatter` + 自定义 `format`：着色完全由
 * `formatPretty` 产生，因此 `color:false` 时**保证零转义序列**，也不必
 * 与内置 ansi formatter 的 value 着色逻辑博弈（它会给插值字符串加引号
 * 并上色，与契约的"裸值"不符）。
 */
export function makePrettyFormatter(
  opts: { color: boolean; production?: boolean },
): (record: LtRecord) => string {
  const production = opts.production ?? isProduction();
  const options: TextFormatterOptions = {
    timestamp: "time",
    value: (v: unknown) => formatFieldValue(v),
    format: (values: FormattedValues) =>
      formatPretty(values, { color: opts.color, production }),
  };
  return getTextFormatter(options);
}

/** JSON 信封的保留键：业务字段不得覆盖它们（见 `log-conventions.md` §4）。 */
export const RESERVED_ENVELOPE_KEYS: readonly string[] = [
  "ts",
  "level",
  "msg",
  "request_id",
];

/**
 * 构造 **core 既有形状**的 JSON formatter。
 *
 * 不使用 `getJsonLinesFormatter()`——它的形状（`@timestamp` / 大写级别 /
 * `properties` 嵌套）与既有契约不兼容。
 *
 * 保留键（`ts`/`level`/`msg`/`request_id`）由信封占据：同名的业务字段会被
 * 改名成 `field_<name>` 而不是静默覆盖信封，否则一条 `logger.info("x", { msg })`
 * 就能把消息体本身抹掉（历史上确实如此）。
 */
export function makeJsonFormatter(): (record: LtRecord) => string {
  return (record: LtRecord): string => {
    const fields = redactFields(record.properties);
    const rid = fields.request_id;
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (k === "request_id") continue;
      const key = RESERVED_ENVELOPE_KEYS.includes(k) ? `field_${k}` : k;
      rest[key] = v instanceof Error ? serializeValue(v) : v;
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
