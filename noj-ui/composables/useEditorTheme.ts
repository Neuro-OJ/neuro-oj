/**
 * 编辑器主题状态（light / dark），仅作用于 /editor 路由。
 *
 * - 持久化：localStorage `noj:editor:theme`
 * - DOM 同步：<html> 节点切换 `.editor-dark` 类（实际挂在 /editor 路由根 div 上，更安全）
 * - Monaco 同步：调用方需在组件中 watch theme 后调 monaco.editor.setTheme()
 */
export type EditorTheme = "light" | "dark"

const STORAGE_KEY = "noj:editor:theme"

export function useEditorTheme() {
  const theme = useState<EditorTheme>("editor:theme", () => {
    if (import.meta.client) {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored === "light" || stored === "dark") return stored
    }
    return "dark" // 默认 dark（沉浸式场景）
  })

  function set(t: EditorTheme) {
    theme.value = t
  }

  function toggle() {
    theme.value = theme.value === "dark" ? "light" : "dark"
  }

  // 写入 localStorage
  if (import.meta.client) {
    watch(theme, (t) => {
      localStorage.setItem(STORAGE_KEY, t)
    })
  }

  return { theme, set, toggle }
}
