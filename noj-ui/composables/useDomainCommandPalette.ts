/**
 * 域内 ⌘K 命令面板状态管理。
 *
 * 与页面级搜索 `/d/:slug/search` 解耦，仅管理命令面板开关与初始分类上下文，
 * 实际搜索严格通过 `useDomainQuery().search(slug, ...)` 限定在当前 URL 域内。
 */
export type CommandSearchType = 'problem' | 'contest' | 'submission' | 'announcement';

export function useDomainCommandPalette() {
  const isOpen = useState<boolean>('domain-command-palette:open', () => false);

  function open() {
    isOpen.value = true;
  }

  function close() {
    isOpen.value = false;
  }

  function toggle() {
    isOpen.value = !isOpen.value;
  }

  return {
    isOpen,
    open,
    close,
    toggle,
  };
}
