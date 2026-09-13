/**
 * LogTape 装配与着色策略。
 *
 * 着色判定顺序（视觉契约 §3）：
 *   NO_COLOR 非空 → 关；LOG_COLOR=never → 关；LOG_COLOR=always → 开；
 *   其余按流探测 TTY。LOG_FORMAT=json 时恒无色且忽略 LOG_COLOR。
 *
 * 本模块**不认识** `LogRecord`（兼容层类型）：`setupLogging` 只接受一个
 * `(record: LogTape LogRecord) => void` 的回调，由 `logging.ts` 负责转成
 * 兼容形状。这样避免了 `logging ↔ log-config` 的循环依赖。
 */

import {
  configureSync,
  getConsoleSink,
  type LogRecord as LtRecord,
} from "@logtape/logtape";
import { requestContextStorage } from "../observability/context.ts";
import {
  isProduction,
  levelRank,
  makeJsonFormatter,
  makePrettyFormatter,
  resolveLevel,
  toCoreLevel,
} from "./log-format.ts";

/** 着色策略的有效值。 */
export type ColorPolicy = "off" | "on" | "auto";

/**
 * 读取环境变量的最小接口（默认即 `Deno.env`）。
 *
 * 这三个解析函数**纯粹**由 env 决定，但此前直接读进程级 `Deno.env`，导致
 * 测试只能靠 `Deno.env.set` 才能构造场景——而 `Deno.env` 是进程级全局，
 * 在 `deno test --parallel`（多测试文件共用同一进程）下并发用例互相覆盖，
 * 日志用例因此间歇性失败（评审实测 12/60 次）。
 *
 * 改成可注入后，测试直接传一个 Map 读取器即可，**完全不碰全局状态**，
 * 从根因上消除竞态（而不是用锁去缓解）。
 */
export type EnvReader = (key: string) => string | undefined;

const realEnv: EnvReader = (key) => Deno.env.get(key);

/** 解析 LOG_COLOR（大小写不敏感），非法值按 auto 处理。 */
export function describeColorPolicy(env: EnvReader = realEnv): ColorPolicy {
  const raw = env("LOG_COLOR")?.trim().toLowerCase();
  if (raw === "never") return "off";
  if (raw === "always") return "on";
  return "auto";
}

/** 解析输出格式（生产 json，否则 pretty）。 */
export function resolveFormat(env: EnvReader = realEnv): "json" | "pretty" {
  const raw = env("LOG_FORMAT")?.trim().toLowerCase();
  if (raw === "json" || raw === "pretty") return raw;
  return isProduction(env) ? "json" : "pretty";
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
 * 判定某个流是否着色（视觉契约 §3）。
 *
 * `LOG_FORMAT=json` 优先于一切开关，专门防止 ANSI 转义码写进结构化日志流。
 */
export function resolveColor(
  stream: "stdout" | "stderr",
  env: EnvReader = realEnv,
): boolean {
  if (resolveFormat(env) === "json") return false;
  const noColor = env("NO_COLOR");
  if (noColor !== undefined && noColor !== "") return false;
  switch (describeColorPolicy(env)) {
    case "off":
      return false;
    case "on":
      return true;
    default:
      return isTty(stream);
  }
}

/**
 * 供 LogTape 读取 `request_id` 的存储。
 *
 * **就是** `shared/observability/context.ts` 里 `runWithRequestContext` 写入的
 * 那个实例——必须共用同一个对象，否则请求上下文不会出现在日志里。
 * 这里只做转出，不再自行 new（历史上的两套 ALS 曾让 request_id 静默丢失）。
 */
export const logContextStorage = requestContextStorage;

/**
 * 动态级别过滤：**每条记录**都重新解析 LOG_LEVEL，便于测试中途切换。
 *
 * env 可注入：这样测试改级别时不必改写进程级 `Deno.env`（那会在
 * `deno test --parallel` 下与其它文件互相覆盖）。不传则读进程环境，
 * 保留"运行时改 env 即生效"的既有行为。
 */
function makeLevelFilter(env?: EnvReader): (record: LtRecord) => boolean {
  return (record: LtRecord): boolean =>
    levelRank(toCoreLevel(record.level)) >=
      levelRank(env ? resolveLevel(env) : resolveLevel());
}

/**
 * 装配 LogTape。
 *
 * @param sink 可选回调；省略时走 console 真实输出。传入回调时，记录交给它
 *             （兼容层用它把 LogTape 记录转成 `LogRecord` 供测试断言）。
 *
 * 内部使用 `reset: true`——`configureSync` 重复调用会抛 `ConfigError`，
 * 而测试与热重载都需要重复装配。
 */
/**
 * 构造一对（stdout/stderr）渲染器，production 与 color 在此**一次性解析**。
 *
 * 独立导出是为了让"装配把 production 传下去了吗"这件事**可被测试直接断言**：
 * 此前该逻辑内联在 `setupLogging` 里，测试只能靠捕获 console 输出间接验证，
 * 而 LogTape 的 console sink 在模块加载期就绑定了 console 方法，捕获并不可靠。
 * 评审 I2 指出：把 setupLogging 里的 `{ production }` 去掉，全部共享测试仍绿。
 *
 * @param env 可注入的 env 读取器（测试用；默认读进程环境）。
 */
export function makeCoreFormatters(
  env?: EnvReader,
): (stream: "stdout" | "stderr") => (record: LtRecord) => string {
  const format = resolveFormat(env);
  // 生产判定只在此处解析一次，随后**显式**传给渲染层；渲染层不再自行读全局
  // env，避免「传了 production:true 却不脱敏」的静默失配（review P1）。
  const production = env ? isProduction(env) : isProduction();
  return (stream) => {
    const color = env ? resolveColor(stream, env) : resolveColor(stream);
    return format === "json"
      ? makeJsonFormatter({ production })
      : makePrettyFormatter({ color, production });
  };
}

export function setupLogging(
  sink?: (record: LtRecord) => void,
  env?: EnvReader,
): void {
  const makeFormatter = makeCoreFormatters(env);
  const outFormatter = makeFormatter("stdout");
  const errFormatter = makeFormatter("stderr");

  // 一条记录按级别选择 formatter：console sink 自身负责把 warn/error 送到
  // stderr、其余送到 stdout（契约 §3 硬规则 1），因此这里只需按目标流
  // 决定是否着色。
  //
  // 用 getConsoleSink 而非 getStreamSink：后者带异步 disposer，configureSync
  // 会直接抛 ConfigError；且 getConsoleSink 同步写出，Deno.exit 下不丢日志。
  const consoleSink = getConsoleSink({
    formatter: (record: LtRecord) => {
      const level = toCoreLevel(record.level);
      const isErr = level === "warn" || level === "error";
      return (isErr ? errFormatter : outFormatter)(record);
    },
  });

  const target = sink ?? consoleSink;

  configureSync({
    reset: true,
    sinks: { target },
    filters: { level: makeLevelFilter(env) },
    contextLocalStorage: logContextStorage,
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
