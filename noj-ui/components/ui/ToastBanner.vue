<script setup lang="ts">
withDefaults(
  defineProps<{
    visible: boolean
    message: string
    color?: "success" | "info" | "warning" | "error"
    icon?: string
  }>(),
  {
    color: "error",
    icon: "i-lucide-alert-circle",
  },
)

defineEmits<{ close: [] }>()
</script>

<template>
  <Transition name="toast">
    <div
      v-if="visible"
      role="status"
      aria-live="polite"
      class="fixed top-[74px] left-1/2 -translate-x-1/2 z-[99] max-w-[380px] w-[calc(100%-48px)]"
    >
      <UAlert
        :color="color"
        :icon="icon"
        :title="message"
        :close="true"
        class="shadow-modal"
      >
        <template #close>
          <UButton color="neutral" variant="link" icon="i-lucide-x" aria-label="关闭" @click="$emit('close')" />
        </template>
      </UAlert>
    </div>
  </Transition>
</template>

<style scoped>
.toast-enter-active {
  transition: all 0.3s ease-out;
}
.toast-leave-active {
  transition: all 0.2s ease-in;
}
.toast-enter-from {
  transform: translateX(-50%) translateY(-20px);
  opacity: 0;
}
.toast-leave-to {
  transform: translateX(-50%) translateY(-20px);
  opacity: 0;
}
</style>
