interface AnswerDraft {
  code: string;
  answers: Record<string, (string | boolean)[]>;
}
/** 草稿按账号、域、题目、版本及语言保存；游客登录后只认领同一作答上下文。 */
export function useDomainAnswerDraft(
  key: Ref<string>,
  code: Ref<string>,
  answers: Ref<Record<string, (string | boolean)[]>>,
  enabled: Ref<boolean>,
  guestKey?: Ref<string>,
) {
  const state = ref<'saved' | 'error' | 'idle'>('idle');
  const guestAvailable = ref(false);
  const storageKey = (target: string) => `noj:draft:${target}`;
  function save(target = key.value) {
    if (!import.meta.client || !enabled.value) return false;
    try {
      localStorage.setItem(storageKey(target), JSON.stringify({ code: code.value, answers: answers.value }));
      state.value = 'saved';
      return true;
    } catch {
      state.value = 'error';
      return false;
    }
  }
  function read(target: string): AnswerDraft | null {
    const value = localStorage.getItem(storageKey(target));
    return value ? JSON.parse(value) : null;
  }
  function apply(draft: AnswerDraft | null) {
    code.value = draft?.code ?? '';
    answers.value = draft?.answers ?? {};
  }
  function restoreGuest() {
    if (!import.meta.client || !guestKey || guestKey.value === key.value) return;
    try {
      const guest = read(guestKey.value);
      if (!guest) return;
      apply(guest);
      if (save()) {
        localStorage.removeItem(storageKey(guestKey.value));
        guestAvailable.value = false;
      }
    } catch {
      state.value = 'error';
    }
  }
  function load() {
    if (!import.meta.client) return;
    state.value = 'idle';
    guestAvailable.value = false;
    try {
      const own = read(key.value);
      const guest = guestKey && guestKey.value !== key.value ? read(guestKey.value) : null;
      apply(own);
      guestAvailable.value = !!guest && (!!guest.code || Object.keys(guest.answers).length > 0);
      if (!own && guestAvailable.value) restoreGuest();
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
  return { state, save, guestAvailable, restoreGuest };
}
