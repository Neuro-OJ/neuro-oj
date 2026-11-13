/**
 * AI 打标的低峰时段判定（纯函数，无 IO）。
 *
 * DeepSeek 在北京时间（Asia/Shanghai，UTC+8，无夏令时）的每日低峰时段提供
 * 优惠价；AI 打标不要求实时完成，故默认只在低峰时段调用模型以降低成本。
 * 时段可经设置 `knowledge_ai_offpeak_window` 配置，格式 `HH:MM-HH:MM`，
 * 允许跨零点（如 `22:00-06:00`）；开始时刻算在内、结束时刻不算在内。
 *
 * 实现只用毫秒偏移换算（不依赖 Intl/时区库），保证跨环境稳定。
 */
import { getSetting } from "../../modules/platform/index.ts";

/** 默认低峰时段（北京时间）。 */
export const DEFAULT_OFFPEAK_WINDOW = "00:30-08:30";

/** UTC+8 偏移（毫秒）。 */
const CST_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 一天的毫秒数。 */
const DAY_MS = 24 * 60 * 60 * 1000;

interface ParsedWindow {
  startMin: number;
  endMin: number;
}

const WINDOW_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * 解析时段字符串；非法返回 null（起点等于终点视为非法：既非空也非全天，
 * 含义不明确，回退默认以免误判）。
 */
export function parseWindow(window: string): ParsedWindow | null {
  const match = WINDOW_PATTERN.exec(window.trim());
  if (!match) return null;
  const startMin = Number(match[1]) * 60 + Number(match[2]);
  const endMin = Number(match[3]) * 60 + Number(match[4]);
  if (startMin === endMin) return null;
  return { startMin, endMin };
}

/** 是否合法的时段字符串（供读取处校验）。 */
export function isValidWindow(window: unknown): window is string {
  return typeof window === "string" && parseWindow(window) !== null;
}

/** 北京时间当天 00:00 对应的 UTC 毫秒。 */
function cstDayStart(now: Date): number {
  return Math.floor((now.getTime() + CST_OFFSET_MS) / DAY_MS) * DAY_MS -
    CST_OFFSET_MS;
}

/** 当前时刻的北京时间当日分钟数。 */
function cstMinuteOfDay(now: Date): number {
  return Math.floor(((now.getTime() + CST_OFFSET_MS) % DAY_MS) / 60000);
}

function safeWindow(window: string): ParsedWindow {
  return parseWindow(window) ?? parseWindow(DEFAULT_OFFPEAK_WINDOW)!;
}

/**
 * 当前是否在时段内。
 *
 * 区间为左闭右开：开始时刻算在内、结束时刻不算在内；跨零点时区间为
 * `[start, 次日 end)`，即 `minute >= start || minute < end`。
 */
export function isWithinWindow(now: Date, window: string): boolean {
  const { startMin, endMin } = safeWindow(window);
  const minute = cstMinuteOfDay(now);
  if (startMin < endMin) return minute >= startMin && minute < endMin;
  return minute >= startMin || minute < endMin;
}

/**
 * 下一个时段开始的时刻：`now` 早于当天起点 → 当天起点；否则 → 次日起点
 * （恰在起点返回当天起点本身）。
 */
export function nextWindowStart(now: Date, window: string): Date {
  const { startMin } = safeWindow(window);
  const dayStart = cstDayStart(now);
  const todayStart = dayStart + startMin * 60000;
  const result = now.getTime() <= todayStart
    ? new Date(todayStart)
    : new Date(dayStart + DAY_MS + startMin * 60000);
  return result;
}

/** 测试注入的当前时刻（null = 真实时钟）；不得发起真实时间依赖的断言。 */
let nowOverride: Date | null = null;

/** 测试注入点：传 `null` 恢复真实时钟。 */
export function setOffpeakNowForTest(now: Date | null): void {
  nowOverride = now;
}

/** 当前时刻（测试可注入）。 */
export function offpeakNow(): Date {
  return nowOverride ?? new Date();
}

// ── 设置读取 ────────────────────────────────────────────

/** 低峰时段策略（管理 API 与投递共用）。 */
export interface OffpeakPolicy {
  enabled: boolean;
  window: string;
}

/**
 * 读取低峰时段设置；时段非法时回退默认值并记 warn 日志。
 *
 * 写入时（设置服务）已按 `valueSchema` 校验格式，这里兜底 env 兜底值或
 * 历史脏数据。
 */
export function readOffpeakPolicy(): OffpeakPolicy {
  const enabled = getSetting("knowledge_ai_offpeak_only")?.value !== false;
  const raw = getSetting("knowledge_ai_offpeak_window")?.value;
  let window = typeof raw === "string" ? raw.trim() : DEFAULT_OFFPEAK_WINDOW;
  if (!isValidWindow(window)) {
    console.warn(
      `[knowledge] knowledge_ai_offpeak_window 非法（${
        String(raw)
      }），回退默认 ${DEFAULT_OFFPEAK_WINDOW}`,
    );
    window = DEFAULT_OFFPEAK_WINDOW;
  }
  return { enabled, window };
}

/** 管理 API 视图：`{ enabled, window, next_start }`。 */
export function offpeakView(
  now: Date = new Date(),
): { enabled: boolean; window: string; next_start: string | null } {
  const policy = readOffpeakPolicy();
  return {
    enabled: policy.enabled,
    window: policy.window,
    next_start: policy.enabled
      ? nextWindowStart(now, policy.window).toISOString()
      : null,
  };
}

/**
 * 投递用：需要等低峰时返回下一个时段开始时刻（ISO），否则 null。
 *
 * 开启 offpeak 且当前不在时段内 → 返回 `nextWindowStart`，让任务入队时
 * `available_at` 就在时段内，避免白天被反复领取再顺延。
 */
export function offpeakAvailableAt(now: Date = new Date()): string | null {
  const policy = readOffpeakPolicy();
  if (!policy.enabled) return null;
  if (isWithinWindow(now, policy.window)) return null;
  return nextWindowStart(now, policy.window).toISOString();
}
