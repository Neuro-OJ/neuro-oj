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

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") emit("cancel")
}

onMounted(() => document.addEventListener("keydown", onKeydown))
onUnmounted(() => document.removeEventListener("keydown", onKeydown))
</script>

<template>
  <Transition name="modal">
    <div class="overlay" @click.self="emit('cancel')">
      <div class="modal">
        <!-- 标题 -->
        <div class="modal-header">
          <h3 class="modal-title">{{ title }}</h3>
          <button class="close-btn" @click="emit('cancel')">
            <X :size="18" />
          </button>
        </div>

        <!-- 内容 -->
        <div class="modal-body">
          <slot />
        </div>

        <!-- 操作按钮 -->
        <div class="modal-footer">
          <button
            class="btn btn-cancel"
            :disabled="loading"
            @click="emit('cancel')"
          >
            {{ cancelText }}
          </button>
          <button
            class="btn"
            :class="danger ? 'btn-danger' : 'btn-primary'"
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
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 300;
  padding: 24px;
}

.modal {
  background: var(--c-white);
  border-radius: 12px;
  max-width: 420px;
  width: 100%;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px 0;
}

.modal-title {
  font-size: 18px;
  font-weight: 700;
  color: var(--c-text);
}

.close-btn {
  background: none;
  border: none;
  color: var(--c-text-secondary);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  transition: background 0.15s;
}

.close-btn:hover {
  background: var(--c-bg-hover, #f5f5f5);
}

.modal-body {
  padding: 16px 24px;
  font-size: 14px;
  color: var(--c-text-secondary);
  line-height: 1.6;
}

.modal-footer {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  padding: 0 24px 20px;
}

.btn {
  padding: 10px 20px;
  font-size: 14px;
  font-weight: 600;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s;
  border: 1.5px solid transparent;
  line-height: 1;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-cancel {
  color: var(--c-text-secondary);
  border-color: var(--c-border);
  background: transparent;
}

.btn-cancel:hover:not(:disabled) {
  border-color: var(--c-text-secondary);
}

.btn-primary {
  background: var(--c-primary);
  color: var(--c-white);
  border-color: var(--c-primary);
}

.btn-primary:hover:not(:disabled) {
  background: var(--c-primary-dark);
  border-color: var(--c-primary-dark);
}

.btn-danger {
  background: #dc2626;
  color: #fff;
  border-color: #dc2626;
}

.btn-danger:hover:not(:disabled) {
  background: #b91c1c;
  border-color: #b91c1c;
}

/* 过渡动画 */
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.2s;
}

.modal-enter-active .modal,
.modal-leave-active .modal {
  transition: transform 0.2s;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-from .modal {
  transform: scale(0.95);
}

.modal-leave-to .modal {
  transform: scale(0.95);
}
</style>
