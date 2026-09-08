/**
 * 统一管理表单 composable。
 *
 * 维护草稿对象与乐观锁版本号，供 AdminEditPanel 使用。
 */
import type { Ref } from 'vue';

export function useAdminForm<T extends Record<string, unknown>>(initial?: T, initialVersion?: string) {
  const draft = ref<T>({ ...(initial ?? {}) } as T) as Ref<T>;
  const version = ref<string | undefined>(initialVersion);

  function setDraft(value: T) {
    draft.value = { ...value };
  }

  function setVersion(value?: string) {
    version.value = value;
  }

  function patchDraft(patch: Partial<T>) {
    draft.value = { ...draft.value, ...patch };
  }

  function reset(next?: T, nextVersion?: string) {
    draft.value = { ...(next ?? initial ?? ({} as T)) } as T;
    version.value = nextVersion;
  }

  return {
    draft,
    version,
    setDraft,
    setVersion,
    patchDraft,
    reset,
  };
}
