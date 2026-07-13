/**
 * 代码草稿自动保存到 localStorage。
 *
 * - 防抖 800ms 写入
 * - 提交成功后不自动清除（避免评测失败后无法恢复代码）
 * - 主动调 clear() 才删除
 * - QuotaExceeded 等写入错误转 state='error'
 */

export type DraftState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

export interface DraftData {
  content: string
  updatedAt: number
}

const DEBOUNCE_MS = 800

export function useDraftStorage(
  problemId: Ref<string>,
  code: Ref<string>,
  enabled: Ref<boolean>,
) {
  const state = ref<DraftState>('idle')
  const savedAt = ref<Date | null>(null)

  const key = computed(() => `noj:draft:${problemId.value}`)
  let timer: ReturnType<typeof setTimeout> | null = null

  // 加载（仅客户端）
  onMounted(() => {
    if (!import.meta.client) return
    try {
      const raw = localStorage.getItem(key.value)
      if (raw) {
        const data = JSON.parse(raw) as DraftData
        if (typeof data.content === 'string' && typeof data.updatedAt === 'number') {
          code.value = data.content
          savedAt.value = new Date(data.updatedAt)
          state.value = 'saved'
        }
      }
    } catch {
      // 损坏的 JSON 忽略，当作无草稿
      state.value = 'idle'
    }
  })

  // 监听变化写入（防抖）
  watch(code, (val) => {
    if (!import.meta.client) return
    if (!enabled.value) return
    if (timer) clearTimeout(timer)
    state.value = 'dirty'
    timer = setTimeout(() => {
      state.value = 'saving'
      try {
        localStorage.setItem(
          key.value,
          JSON.stringify({ content: val, updatedAt: Date.now() } satisfies DraftData),
        )
        savedAt.value = new Date()
        state.value = 'saved'
      } catch {
        state.value = 'error'
      }
    }, DEBOUNCE_MS)
  })

  // 清理 timer
  onBeforeUnmount(() => {
    if (timer) clearTimeout(timer)
  })

  // 主动清除（设置面板"清除草稿"按钮调用）
  function clear() {
    if (!import.meta.client) return
    if (timer) clearTimeout(timer)
    localStorage.removeItem(key.value)
    savedAt.value = null
    state.value = 'idle'
  }

  return { state, savedAt, clear }
}
