/**
 * 表单错误管理：自动计时消失。
 * 从重复的 auth 页面模式中抽取。
 */
export function useFormError(duration = 3000) {
  const error = ref('');
  let errorTimer: ReturnType<typeof setTimeout> | null = null;

  function setError(msg: string) {
    error.value = msg;
    if (errorTimer) clearTimeout(errorTimer);
    errorTimer = setTimeout(clearError, duration);
  }

  function clearError() {
    error.value = '';
    if (errorTimer) clearTimeout(errorTimer);
  }

  onUnmounted(() => {
    if (errorTimer) clearTimeout(errorTimer);
  });

  return { error, setError, clearError };
}
