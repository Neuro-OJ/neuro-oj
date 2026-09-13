/**
 * 结构化日志（兼容层）。
 *
 * 外观与导出**保持不变**，内部已迁移到 LogTape 2.3.4：
 * - 级别控制：`LOG_LEVEL`（debug/info/warn/error），默认生产 warn、开发 debug
 * - 输出格式：`LOG_FORMAT`（json/pretty），默认生产 json、开发 pretty
 * - 结构化字段优先（借鉴 noj-judge 的 tracing 风格）
 * - 内置脱敏：生产环境自动截断 *_id、隐藏 score、抹除 code/token/secret 等
 * - 自动附带 request_id（通过 AsyncLocalStorage，无需逐层透传）
 * - 可注入 sink，便于测试捕获输出（替代重写 console.*）
 *
 * 所有涉及 submission_id / score / code / token 等敏感字段的日志，
 * 均应通过本模块的 `logger`，由 logger 统一脱敏，避免散落实现导致泄露。
 *
 * 渲染与脱敏规则实现在 `log-format.ts`；LogTape 装配在 `log-config.ts`。
 */

import { getLogger, type LogRecord as LtRecord } from "@logtape/logtape";
import { type EnvReader, setupLogging } from "./log-config.ts";
import {
  isProduction,
  type LogLevel,
  redactFields,
  renderableMessage,
  toCoreLevel,
} from "./log-format.ts";

export type { LogLevel };
export { isProduction, redactId } from "./log-format.ts";

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

/**
 * LogTape 记录 → 兼容记录（对象形状与迁移前保持一致）。
 *
 * `env` 透传给脱敏与消息渲染：不传则读进程环境（生产行为不变）；测试可用
 * 注入的读取器构造"生产/开发"，无需改写全局 `Deno.env`。此前这里恒读全局，
 * 导致注入 env 的测试拿不到对应脱敏（会静默按进程环境判定）。
 */
function toCompatRecord(record: LtRecord, env?: EnvReader): LogRecord {
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record.properties)) {
    if (k === "request_id") continue;
    fields[k] = v;
  }
  const production = env ? isProduction(env) : isProduction();
  return {
    ts: new Date(record.timestamp).toISOString(),
    level: toCoreLevel(record.level),
    msg: renderableMessage(record, production),
    request_id: typeof record.properties.request_id === "string"
      ? record.properties.request_id
      : undefined,
    fields: redactFields(fields, production),
  };
}

/**
 * 替换日志 sink（测试用，用于捕获日志记录）。
 *
 * @param env 可选的 env 读取器；传入后级别过滤/脱敏都按它判定，测试因此
 *            **不必改写进程级 `Deno.env`**（那在 `deno test --parallel` 下
 *            会跨文件互相覆盖）。
 */
export function setLogSink(sink: LogSink, env?: EnvReader): void {
  setupLogging((record) => sink(toCompatRecord(record, env)), env);
}

/** 恢复默认 sink（测试清理用）。 */
export function resetLogSink(): void {
  setupLogging();
}

// 模块初始化即装配一次默认输出
setupLogging();

// ── 核心 emit + logger ────────────────────────────────────────────────

function emit(
  level: LogLevel,
  msg: string,
  fields?: Record<string, unknown>,
): void {
  // 级别过滤由 LogTape 的 dynamicLevelFilter 统一负责，此处直接投递。
  // request_id 不再手工注入：LogTape 的 contextLocalStorage 会用同一个
  // ALS 自动并入 properties（见 observability/context.ts），手工再写一次
  // 只会掩盖传播链路的真实状态。
  const log = getLogger(["noj", "legacy"]);
  const props: Record<string, unknown> = { ...(fields ?? {}) };
  switch (level) {
    case "debug":
      log.debug(msg, props);
      break;
    case "info":
      log.info(msg, props);
      break;
    case "warn":
      log.warn(msg, props);
      break;
    case "error":
      log.error(msg, props);
      break;
  }
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
