/**
 * 代码草稿自动保存到 localStorage。
 *
 * - 防抖 800ms 写入
 * - 提交成功后不自动清除（避免评测失败后无法恢复代码）
 * - 主动调 clear() 才删除
 * - QuotaExceeded 等写入错误转 state='error'
 */

export type DraftState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

export interface DraftData {
  content: string;
  updatedAt: number;
}

const DEBOUNCE_MS = 800;

export function useDraftStorage(
  problemId: Ref<string>,
  code: Ref<string>,
  enabled: Ref<boolean>,
) {
  const state = ref<DraftState>('idle');
  const savedAt = ref<Date | null>(null);

  const key = computed(() => `noj:draft:${problemId.value}`);
  let timer: ReturnType<typeof setTimeout> | null = null;
  // 清除草稿时避免空内容被自动保存回 localStorage
  let suppressNextWrite = false;

  function loadDraft() {
    if (!import.meta.client) return;
    try {
      const raw = localStorage.getItem(key.value);
      if (raw) {
        const data = JSON.parse(raw) as DraftData;
        if (typeof data.content === 'string' && typeof data.updatedAt === 'number') {
          code.value = data.content;
          savedAt.value = new Date(data.updatedAt);
          state.value = 'saved';
          return;
        }
      }
      state.value = 'idle';
    } catch {
      // 损坏的 JSON 忽略，当作无草稿
      state.value = 'idle';
    }
  }

  // 加载（仅客户端）
  onMounted(loadDraft);

  // NOJ-235：同一编辑器实例切换题目时，先清旧代码再加载新题草稿。
  watch(problemId, (newId, oldId) => {
    if (!import.meta.client || oldId === undefined || newId === oldId) return;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    code.value = '';
    savedAt.value = null;
    state.value = 'idle';
    // 等 code 重置提交后再读新 key，避免旧 watcher 竞态。
    requestAnimationFrame(loadDraft);
  });

  // 监听变化写入（防抖）
  watch(code, (val) => {
    if (!import.meta.client) return;
    if (!enabled.value) return;
    if (suppressNextWrite) {
      suppressNextWrite = false;
      return;
    }
    if (timer) clearTimeout(timer);
    state.value = 'dirty';
    timer = setTimeout(() => {
      state.value = 'saving';
      try {
        localStorage.setItem(
          key.value,
          JSON.stringify({ content: val, updatedAt: Date.now() } satisfies DraftData),
        );
        savedAt.value = new Date();
        state.value = 'saved';
      } catch {
        state.value = 'error';
      }
    }, DEBOUNCE_MS);
  });

  // 清理 timer
  onBeforeUnmount(() => {
    if (timer) clearTimeout(timer);
  });

  // 主动清除（设置面板"清除草稿"按钮调用）
  // 除删除 localStorage 外，同时清空当前编辑器内容与草稿状态，避免“只删存储但界面不变”。
  function clear() {
    if (!import.meta.client) return;
    if (timer) clearTimeout(timer);
    localStorage.removeItem(key.value);
    suppressNextWrite = true;
    code.value = '';
    savedAt.value = null;
    state.value = 'idle';
  }

  return { state, savedAt, clear };
}
