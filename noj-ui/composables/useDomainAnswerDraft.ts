/** 每次离开或切换作答上下文立即保存，版本确认时保留当前输入。 */
export function useDomainAnswerDraft(
  key: Ref<string>,
  code: Ref<string>,
  answers: Ref<Record<string, (string | boolean)[]>>,
  enabled: Ref<boolean>,
) {
  const state = ref<'saved' | 'error' | 'idle'>('idle');
  function save(target = key.value) {
    if (!import.meta.client || !enabled.value) return;
    try {
      localStorage.setItem(`noj:draft:${target}`, JSON.stringify({ code: code.value, answers: answers.value }));
      state.value = 'saved';
    } catch {
      state.value = 'error';
    }
  }
  function load() {
    if (!import.meta.client) return;
    code.value = '';
    answers.value = {};
    try {
      const value = localStorage.getItem(`noj:draft:${key.value}`);
      if (value) {
        const draft = JSON.parse(value);
        if (typeof draft.code === 'string') code.value = draft.code;
        if (draft.answers && typeof draft.answers === 'object') answers.value = draft.answers;
      }
    } catch {
      state.value = 'error';
    }
  }
  onMounted(load);
  watch(key, (_next, previous) => {
    save(previous);
    load();
  }, { flush: 'sync' });
  watch([code, answers], () => save(), { deep: true, flush: 'post' });
  onBeforeUnmount(() => save());
  return { state, save };
}
