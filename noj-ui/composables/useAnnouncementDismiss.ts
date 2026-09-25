/**
 * 公告横幅关闭状态（纯前端 localStorage，绑定公告 id）。
 *
 * 设计：记录"已关闭的公告 id 集合"，而非全局布尔——这样发了新公告仍会再出现，
 * 且关闭某条不影响其他条。SSR 安全（`import.meta.client` 守卫）。
 *
 * 纯解析/序列化逻辑在 `utils/announcementDismiss.ts`（便于无 Vue 单测）。
 */

import { ref } from 'vue';
import { DISMISS_KEY, parseDismissed, serializeDismissed } from '~/utils/announcementDismiss';

/** 读取已关闭 id 集合（SSR / 解析失败时返回空集）。 */
function readDismissed(): Set<string> {
  if (!import.meta.client) return new Set();
  try {
    return parseDismissed(localStorage.getItem(DISMISS_KEY));
  } catch {
    return new Set();
  }
}

/** 写回已关闭 id 集合（尽力而为；配额/隐私模式失败时静默）。 */
function writeDismissed(ids: Set<string>): void {
  if (!import.meta.client) return;
  try {
    localStorage.setItem(DISMISS_KEY, serializeDismissed(ids));
  } catch {
    // 隐私模式/配额限制：静默降级（本次会话内仍通过响应式 ref 生效）
  }
}

/**
 * 公告横幅关闭状态。
 *
 * @returns `isDismissed(id)` 判断是否已关闭；`dismiss(id)` 记录关闭
 */
export function useAnnouncementDismiss() {
  const dismissed = ref<Set<string>>(readDismissed());

  function isDismissed(id: string): boolean {
    return dismissed.value.has(id);
  }

  function dismiss(id: string): void {
    const next = new Set(dismissed.value);
    next.add(id);
    dismissed.value = next;
    writeDismissed(next);
  }

  return { isDismissed, dismiss, dismissed };
}
