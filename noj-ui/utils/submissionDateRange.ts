/**
 * 提交记录日期范围筛选（issue #581）。
 *
 * 后端 `GET /api/v1/submissions` 的 `from` / `to` 直接与 `submissions.created_at`
 * （UTC ISO 文本）做字符串比较，因此不能把 `<input type="date">` 的 `YYYY-MM-DD`
 * 原样透传：`to=2026-10-01` 会把当天全部记录排除。这里把用户选择的本地日期
 * 换算为「本地当天 00:00:00.000 ~ 23:59:59.999」对应的 UTC ISO 时间。
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 本地日期 `YYYY-MM-DD` + 本地时刻 → UTC ISO；格式非法返回 null。 */
function localDateToIso(date: string, time: string): string | null {
  if (!DATE_RE.test(date)) return null;
  const d = new Date(`${date}T${time}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * 生成 `from` / `to` 查询参数；未填写或非法的一端省略。
 * 起止颠倒时自动交换，避免用户误选后得到无提示的空列表。
 */
export function buildDateRangeParams(
  fromDate: string,
  toDate: string,
): { from?: string; to?: string } {
  let start = fromDate;
  let end = toDate;
  if (DATE_RE.test(start) && DATE_RE.test(end) && start > end) {
    [start, end] = [end, start];
  }
  const from = start ? localDateToIso(start, '00:00:00.000') : null;
  const to = end ? localDateToIso(end, '23:59:59.999') : null;
  return {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };
}
