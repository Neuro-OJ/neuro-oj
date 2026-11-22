/**
 * 日期/时间工具（UTC 统一）。
 *
 * 全站时间戳统一使用 UTC ISO 8601 字符串（`YYYY-MM-DDTHH:mm:ss.sssZ`），
 * 日期键统一使用 `YYYY-MM-DD`（UTC），避免时区换算歧义。
 */

/** 当前 UTC ISO 时间戳（`YYYY-MM-DDTHH:mm:ss.sssZ`）。 */
export function nowIso(): string {
  return new Date().toISOString();
}

/** 今日 UTC 日期字符串（`YYYY-MM-DD`）。 */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
