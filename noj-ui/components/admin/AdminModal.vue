<script setup lang="ts">
import { X } from "@lucide/vue"
import { nextTick, ref } from "vue"

interface Props {
  title?: string
  confirmText?: string
  cancelText?: string
  loading?: boolean
  danger?: boolean
  hideConfirm?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  title: "确认操作",
  confirmText: "确认",
  cancelText: "取消",
  loading: false,
  danger: false,
  hideConfirm: false,
})

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()

const modal = ref<HTMLElement | null>(null)
const closeButton = ref<HTMLButtonElement | null>(null)
let triggerElement: HTMLElement | null = null

function focusableElements() {
  return Array.from(
    modal.value?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? [],
  )
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault()
    emit("cancel")
    return
  }
  if (e.key !== "Tab") return

  const elements = focusableElements()
  if (elements.length === 0) {
    e.preventDefault()
    return
  }
  const first = elements[0]
  const last = elements[elements.length - 1]
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}

onMounted(async () => {
  triggerElement = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null
  document.addEventListener("keydown", onKeydown)
  await nextTick()
  closeButton.value?.focus()
})
onUnmounted(() => {
  document.removeEventListener("keydown", onKeydown)
  triggerElement?.focus()
})
</script>

<template>
  <Transition name="modal">
    <div class="fixed inset-0 bg-black/40 flex items-center justify-center z-300 p-6" @click.self="emit('cancel')">
      <div ref="modal" role="dialog" aria-modal="true" aria-labelledby="admin-modal-title" class="bg-white rounded-xl max-w-[420px] w-full shadow-modal">
        <!-- 标题 -->
        <div class="flex items-center justify-between pt-5 px-6">
          <h3 id="admin-modal-title" class="text-lg font-bold text-text">{{ title }}</h3>
          <button ref="closeButton" aria-label="关闭弹窗" class="bg-none border-none text-text-secondary cursor-pointer p-1 rounded transition-colors hover:bg-gray-100" @click="emit('cancel')">
            <X :size="18" />
          </button>
        </div>

        <!-- 内容 -->
        <div class="px-6 py-4 text-sm text-text-secondary leading-relaxed">
          <slot />
        </div>

        <!-- 操作按钮 -->
        <div class="flex gap-2.5 justify-end px-6 pb-5">
          <button
            class="px-5 py-2.5 text-sm font-semibold rounded-lg border border-border bg-transparent text-text-secondary cursor-pointer transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:border-text-secondary"
            :disabled="loading"
            @click="emit('cancel')"
          >
            {{ cancelText }}
          </button>
          <button
            v-if="!hideConfirm"
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
