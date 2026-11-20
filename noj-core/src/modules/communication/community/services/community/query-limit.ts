/**
 * 分页 `limit` 查询参数的容错解析。
 *
 * 背景：社区多个列表端点此前写作 `Number(c.req.query("limit") ?? 20)`，
 * 直接把查询串交给 `Number()`。非法输入（如 `limit=abc`）得到 `NaN`，而
 * 服务层的夹取写法 `Math.min(Math.max(nan, 1), 100)` 会整体返回 `NaN`——
 * 夹取**完全失效**。后续 `NaN` 进入 Drizzle `.limit()` 时会被静默忽略
 * （不生成 LIMIT 子句），并与 `collected.length <= limit` 之类的比较一起
 * 变成 `false`，最终表现为**静默返回空列表**：搜索/动态正文"看起来没有内容"，
 * 而不是报错或被夹取到合法上限。
 *
 * 本函数把「解析 + 夹取 + 非有限值回退」收敛到一处，供社区路由复用。
 * 语义与 `parsePagination`（`shared/http/pagination.ts`）一致：非法值不报错，
 * 回退到默认值。
 */
export function parseQueryLimit(
  raw: string | undefined,
  options: { default: number; min?: number; max?: number },
): number {
  const min = options.min ?? 1;
  const max = options.max ?? 100;
  const fallback = Math.min(Math.max(options.default, min), max);
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  // 拒绝 NaN / ±Infinity / 小数 / 越界：回退默认值（与 parsePagination 的
  // "per_page 非正整数则 400"不同，这里保持既有宽松语义，仅去掉 NaN 穿透）。
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}
