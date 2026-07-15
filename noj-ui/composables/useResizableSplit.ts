/**
 * 可拖拽分隔条状态机。
 *
 * - 持久化宽度到 localStorage（key 由调用方指定，如 `editor:sidebar:width`）
 * - mousedown/move/up 全局监听，避免鼠标拖出分隔条后丢失事件
 * - 移动端（< md）不调用 startDrag
 */

export function useResizableSplit(
  storageKey: string,
  initial: number,
  min: number,
  max: number,
) {
  const width = ref(initial)

  // 加载持久化宽度
  onMounted(() => {
    if (!import.meta.client) return
    const stored = Number(localStorage.getItem(storageKey))
    if (Number.isFinite(stored) && stored >= min && stored <= max) {
      width.value = stored
    }
  })

  function persist(v: number) {
    if (import.meta.client) {
      localStorage.setItem(storageKey, String(v))
    }
  }

  function startDrag(e: MouseEvent) {
    if (!import.meta.client) return
    e.preventDefault()
    const startX = e.clientX
    const startWidth = width.value

    function onMove(ev: MouseEvent) {
      const dx = ev.clientX - startX
      const next = Math.max(min, Math.min(max, startWidth + dx))
      width.value = next
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      persist(width.value)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function reset() {
    width.value = Math.floor((min + max) / 2)
    persist(width.value)
  }

  return { width, startDrag, reset }
}
