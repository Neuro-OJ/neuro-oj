/**
 * 公告横幅关闭状态的纯逻辑（无 Vue 依赖，便于单测）。
 *
 * 语义：记录"已关闭的公告 id 集合"，绑 id 而非全局布尔——
 * 发新公告会再出现，关闭某条不影响其他条。
 */

/** localStorage 键名。 */
export const DISMISS_KEY = 'noj:announcement-dismissed';

/**
 * 解析已关闭 id 集合（容错：非 JSON / 非数组 / 非字符串元素均忽略）。
 *
 * @param raw localStorage 原始字符串（可空）
 */
export function parseDismissed(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

/**
 * 序列化已关闭 id 集合。
 *
 * @param ids 集合
 */
export function serializeDismissed(ids: Set<string>): string {
  return JSON.stringify([...ids]);
}
