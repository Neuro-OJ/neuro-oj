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

/**
 * SGR 参数码（**不含** ESC 包装），与视觉契约 §1 一一对应。
 *
 * 存参数码而非完整转义序列，是为了让渲染层把「行级强调」与「片段自身样式」
 * 合成进同一个序列（见 `renderSpans`）。契约表中的复合码由 `sgr()` 合成：
 * ERROR 徽章 `1;31` = `sgr(SGR.bold, SGR.error)`。
 */
export const SGR = {
  reset: "0",
  bold: "1",
  dim: "2",
  info: "36",
  debug: "90",
  warn: "33",
  error: "31",
  /** 模块名（契约 §2 模块列）。 */
  module: "34",
  /** 数值字面量：与字符串值区分，便于在长行里扫读数字。 */
  number: "35",
} as const;

/** 把 SGR 参数码包装成完整转义序列；无参数时返回空串。 */
export function sgr(...codes: readonly string[]): string {
  const uniq = [...new Set(codes)];
  return uniq.length === 0 ? "" : `\x1b[${uniq.join(";")}m`;
}

/**
 * 标记「由 Error 序列化而来」的对象。
 *
 * `serializeValue` 会把 Error 转成普通对象，`value instanceof Error` 因此
 * **永远不可达**（实测确认），渲染层再也认不出这是错误。用不可枚举的
 * Symbol 打标记：`JSON.stringify` 与 `Object.entries` 都看不见它，故不改动
 * 契约 §4 的 JSON 形状与既有脱敏遍历。
 */
export const ERROR_TAG: unique symbol = Symbol.for("noj.log.serialized-error");

/** 给序列化后的 Error 形状打标记（不可枚举，对 JSON 不可见）。 */
function tagError<T extends object>(obj: T): T {
  Object.defineProperty(obj, ERROR_TAG, { value: true, enumerable: false });
  return obj;
}

/** 判定值是否为序列化后的 Error 形状。 */
export function isSerializedError(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null &&
    (value as Record<symbol, unknown>)[ERROR_TAG] === true;
}

/** 契约级别名。 */
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
 * 免除 id 脱敏的**关联标识**（契约 §6 的显式例外）。
 *
 * `*_id` 通配规则的本意是保护业务实体 id，但 `request_id` 不是业务实体：
 * 它由服务端随机生成、不携带用户隐私，且唯一用途就是**跨服务串联同一次请求**。
 * 一旦被截断成前 8 字符，生产环境的日志就无法与上游/下游（core、judge）对齐。
 * 该键同时由 pretty 侧自行 `slice(0, 8)` 控制展示长度（契约 §1）。
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
    return tagError(
      isProduction() ? { name: value.name, message: value.message } : {
        name: value.name,
        message: value.message,
        stack: value.stack,
      },
    );
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
  // 客户端 IP 在生产日志中不做完整记录（隐私最小化）
  if (lower === "client_ip" || lower === "ip" || lower === "ips") {
    return "[redacted]";
  }
  // 非敏感键也要递归：顶层键名匹配不到嵌套结构里的 password/api_key，
  // 整块直通即明文泄露。
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
 * 未脱敏的 `api_key`/`password` 写进日志）：
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
    const wasError = isSerializedError(serialized);
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
      if (lower === "client_ip" || lower === "ip" || lower === "ips") {
        out[k] = "[redacted]";
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
    // 重建对象会丢掉不可枚举标记，这里补回：否则递归脱敏后的 Error
    // 又退回「认不出的普通对象」，渲染层无法展开成详情块。
    return wasError ? tagError(out) : out;
  } finally {
    // 只跟踪「当前路径」：兄弟节点引用同一对象是合法的 DAG，不应误判为环。
    seen.delete(serialized);
  }
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

/** 时间戳列宽（`HH:MM:SS.mmm`）。 */
const TIME_WIDTH = 12;
/** 级别列宽（`padEnd(5)`）。 */
const LEVEL_WIDTH = 5;
/** 模块列宽（契约 §2）。 */
const MODULE_WIDTH = 14;
/** msg 起始列：12 + 2 + 5 + 2 + 14 + 2 = 37。 */
const MSG_COLUMN = TIME_WIDTH + 2 + LEVEL_WIDTH + 2 + MODULE_WIDTH + 2;

/**
 * 一个带样式的文本片段。
 *
 * 渲染层**必须**按片段合成 SGR，不能在整行外层套样式：行内每个片段的
 * `reset` 都会把外层样式清掉（实测——这正是「WARN/ERROR 整行粗体」这一
 * 契约承诺长期未生效的原因）。
 */
interface Span {
  text: string;
  /** SGR 参数码；空数组表示继承默认色。 */
  codes: string[];
}

const PLAIN: readonly string[] = [];

/** 把片段序列渲染成字符串；无色时仅拼接文本，保证零转义序列。 */
function renderSpans(spans: readonly Span[], color: boolean): string {
  if (!color) return spans.map((s) => s.text).join("");
  // 空文本片段不产出转义序列；每个着色片段自成 `开 → 文本 → 关`，
  // 片段之间不共享样式状态（避免样式泄漏到后续输出）。
  return spans
    .filter((s) => s.text.length > 0)
    .map((s) =>
      s.codes.length === 0
        ? s.text
        : `${sgr(...s.codes)}${s.text}${sgr(SGR.reset)}`
    )
    .join("");
}

/**
 * 在指定片段上叠加行级强调码（如 ERROR 整行粗体）。
 *
 * 强调码**前置**，使合成结果与契约表一致（ERROR 徽章 `31` + 行级 `1`
 * → `1;31`）；纯空白片段不参与，避免白添转义字节。
 */
function emphasize(spans: Span[], code: string): Span[] {
  return spans.map((s) =>
    s.text.trim().length === 0
      ? { text: s.text, codes: s.codes }
      : { text: s.text, codes: [code, ...s.codes] }
  );
}

/** 模块名：取 category 末段（`noj` 之后的最后一段）。 */
export function moduleName(record: LtRecord): string | undefined {
  const cat = record.category as readonly unknown[] | undefined;
  if (!Array.isArray(cat) || cat.length === 0) return undefined;
  const parts = cat.filter((c) => typeof c === "string") as string[];
  if (parts.length === 0) return undefined;
  const last = parts[parts.length - 1]!;
  return last.length > 0 ? last : undefined;
}

/** 模块名截断到列宽（超宽加省略号，避免撑破列）。 */
export function fitModule(name: string): string {
  return name.length <= MODULE_WIDTH
    ? name.padEnd(MODULE_WIDTH)
    : `${name.slice(0, MODULE_WIDTH - 1)}…`;
}

/** 值是否为数值字面量（用于着色区分）。 */
export function isNumericValue(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * 把序列化后的 Error 形状展成多行详情。
 *
 * `stack` 去掉与首行重复的那行，其余栈帧各占一行。
 */
export function formatErrorDetail(
  key: string,
  value: Record<string, unknown>,
): string {
  const message = typeof value.message === "string" ? value.message : "";
  const lines = [`${key}: ${message}`];
  if (typeof value.stack === "string" && value.stack.length > 0) {
    for (const l of value.stack.split("\n").slice(1)) {
      const t = l.trim();
      if (t.length > 0) lines.push(`  at ${t.replace(/^at\s+/, "")}`);
    }
  }
  return lines.join("\n");
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
  const bold = level === "error";

  const spans: Span[] = [];
  const emit = (text: string, codes: readonly string[] = PLAIN) => {
    if (text.length === 0) return;
    spans.push({ text, codes: [...codes] });
  };

  emit(time, [SGR.dim]);
  emit("  ");
  emit(level.toUpperCase().padEnd(LEVEL_WIDTH), [SGR[level]]);
  emit("  ");
  const mod = moduleName(record);
  if (mod) {
    emit(fitModule(mod), [SGR.module]);
    emit("  ");
  } else {
    // 无 category 时保留列宽，避免同一批日志出现两种缩进。
    emit(" ".repeat(MODULE_WIDTH + 2));
  }

  const indent = " ".repeat(MSG_COLUMN);
  emit(renderableMessage(record).split("\n").join(`\n${indent}`));

  if (rid) {
    emit("  ");
    emit("rid=", [SGR.dim]);
    emit(rid);
  }

  const entries = renderableFields(record);
  const errors: [string, Record<string, unknown>][] = [];
  const plain: [string, unknown][] = [];
  for (const [k, v] of entries) {
    if (isSerializedError(v)) errors.push([k, v]);
    else plain.push([k, v]);
  }

  for (const [k, v] of plain) {
    emit("  ");
    emit(`${k}=`, [SGR.dim]);
    emit(formatFieldValue(v), isNumericValue(v) ? [SGR.number] : PLAIN);
  }

  // Error 详情块：不用 JSON（stack 里的换行转义后整行不可读）。
  for (const [k, v] of errors) {
    for (const [i, line] of formatErrorDetail(k, v).split("\n").entries()) {
      emit("\n" + indent + (i === 0 ? "" : "  "));
      emit(line, i === 0 ? [SGR[level]] : [SGR.dim]);
    }
  }

  return renderSpans(bold ? emphasize(spans, SGR.bold) : spans, opts.color);
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

/** JSON 信封的保留键：业务字段不得覆盖它们（见 `log-conventions.md` §4）。 */
export const RESERVED_ENVELOPE_KEYS: readonly string[] = [
  "ts",
  "level",
  "msg",
  "request_id",
];

/**
 * 构造契约形状的 JSON formatter。
 *
 * 保留键（`ts`/`level`/`msg`/`request_id`）由信封占据：同名的业务字段会被
 * 改名成 `field_<name>`，避免把消息体本身覆盖掉。
 */
export function makeGatewayJsonFormatter(): (record: LtRecord) => string {
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
