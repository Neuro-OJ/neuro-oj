/**
 * Form error management with auto-dismiss timer.
 * Extracted from duplicated auth page patterns.
 */
export function useFormError(duration = 3000) {
  const error = ref("")
  let errorTimer: ReturnType<typeof setTimeout> | null = null

  function setError(msg: string) {
    error.value = msg
    if (errorTimer) clearTimeout(errorTimer)
    errorTimer = setTimeout(clearError, duration)
  }

  function clearError() {
    error.value = ""
    if (errorTimer) clearTimeout(errorTimer)
  }

  onUnmounted(() => { if (errorTimer) clearTimeout(errorTimer) })

  return { error, setError, clearError }
}
