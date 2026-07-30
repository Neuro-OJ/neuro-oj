<script setup lang="ts">
import { X } from "@lucide/vue"

interface Props {
  title?: string
  confirmText?: string
  cancelText?: string
  loading?: boolean
  danger?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  title: "确认操作",
  confirmText: "确认",
  cancelText: "取消",
  loading: false,
  danger: false,
})

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()

const dialogRef = ref<HTMLElement | null>(null)
const confirmBtnRef = ref<HTMLElement | null>(null)
const cancelBtnRef = ref<HTMLElement | null>(null)
const previouslyFocused = ref<Element | null>(null)

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") emit("cancel")

  // 焦点陷阱：Tab 循环在弹窗内
  if (e.key === "Tab" && dialogRef.value) {
    const focusable = dialogRef.value.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }
}

onMounted(() => {
  previouslyFocused.value = document.activeElement
  // 初始焦点：确认按钮（danger 模式优先取消按钮避免误操作）
  if (props.danger && cancelBtnRef.value) {
    cancelBtnRef.value.focus()
  } else if (confirmBtnRef.value) {
    confirmBtnRef.value.focus()
  }
  document.addEventListener("keydown", onKeydown)
})

onUnmounted(() => {
  document.removeEventListener("keydown", onKeydown)
  // 关闭后焦点恢复
  if (previouslyFocused.value instanceof HTMLElement) {
    previouslyFocused.value.focus()
  }
})
</script>

<template>
  <Transition name="modal">
    <div
      ref="dialogRef"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
      class="fixed inset-0 bg-black/40 flex items-center justify-center z-300 p-6"
      @click.self="emit('cancel')"
    >
      <div class="bg-white rounded-xl max-w-[420px] w-full shadow-modal">
        <!-- 标题 -->
        <div class="flex items-center justify-between pt-5 px-6">
          <h3 class="text-lg font-bold text-text" id="modal-title">{{ title }}</h3>
          <button
            class="bg-none border-none text-text-secondary cursor-pointer p-1 rounded transition-colors hover:bg-gray-100"
            aria-label="关闭"
            @click="emit('cancel')"
          >
            <X :size="18" />
          </button>
        </div>

        <!-- 内容 -->
        <div class="px-6 py-4 text-sm text-text-secondary leading-relaxed">
          <slot />
        </div>

        <!-- 操作按钮 -->
        <div v-if="confirmText !== '' || cancelText !== ''" class="flex gap-2.5 justify-end px-6 pb-5">
          <button
            v-if="cancelText"
            ref="cancelBtnRef"
            class="px-5 py-2.5 text-sm font-semibold rounded-lg border border-border bg-transparent text-text-secondary cursor-pointer transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:border-text-secondary"
            :disabled="loading"
            @click="emit('cancel')"
          >
            {{ cancelText }}
          </button>
          <button
            v-if="confirmText"
            ref="confirmBtnRef"
            class="px-5 py-2.5 text-sm font-semibold rounded-lg border border-transparent text-white cursor-pointer transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            :class="danger ? 'bg-red-600 border-red-600 hover:bg-red-700 hover:border-red-700' : 'bg-primary border-primary hover:bg-primary-dark hover:border-primary-dark'"
            :disabled="loading"
            @click="emit('confirm')"
          >
            <slot name="confirm-loading">
              {{ loading ? "处理中..." : confirmText }}
            </slot>
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* Vue Transition: 模态框 */
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.2s;
}
.modal-enter-active > div:last-child,
.modal-leave-active > div:last-child {
  transition: transform 0.2s;
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
.modal-enter-from > div:last-child {
  transform: scale(0.95);
}
.modal-leave-to > div:last-child {
  transform: scale(0.95);
}
</style>
