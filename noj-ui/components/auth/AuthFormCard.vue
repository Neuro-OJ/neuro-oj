<template>
  <div class="w-full max-w-[380px] relative">
    <!-- Error banner -->
    <ToastBanner :visible="!!error" color="error" icon="i-lucide-alert-circle" :message="error" @close="$emit('clear-error')" />

    <!-- Success banner slot -->
    <slot name="banner-success" />

    <!-- Info banner slot (e.g. banned account message) -->
    <slot name="banner-info" />

    <div class="bg-white border border-border rounded-lg p-8">
      <h1 class="text-22px font-bold text-center mb-3 text-text animate-[fadeInUp_0.5s_ease_both]">{{ title }}</h1>
      <p v-if="subtitle" class="text-center text-sm text-text-secondary mb-6 animate-[fadeInUp_0.5s_ease_0.05s_both]">{{ subtitle }}</p>

      <form class="flex flex-col gap-6" @submit.prevent="$emit('submit')">
        <slot />

        <UButton color="primary" size="md" block type="submit"
          :disabled="loading">
          <UIcon name="i-lucide-loader-2" class="animate-spin-slow mr-1.5 size-4.5" v-if="loading"/>
          {{ loading ? loadingLabel || submitLabel + '中...' : submitLabel }}
        </UButton>
      </form>

      <div v-if="$slots.footer" class="text-center mt-5 text-sm text-text-secondary">
        <slot name="footer" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  title: string
  subtitle?: string
  error: string
  loading: boolean
  submitLabel: string
  loadingLabel?: string
}>()

defineEmits<{
  submit: []
  "clear-error": []
}>()
</script>

<style>
/* Vue Transition: slide (用于 error/success banner) */
.slide-enter-active {
  transition: all 0.3s ease-out;
}
.slide-leave-active {
  transition: all 0.2s ease-in;
}
.slide-enter-from {
  transform: translateX(-50%) translateY(-20px);
  opacity: 0;
}
.slide-leave-to {
  transform: translateX(-50%) translateY(-20px);
  opacity: 0;
}

/* Vue Transition: drop (用于 field errors) */
.drop-enter-active {
  animation: dropIn 0.25s ease both;
}
.drop-leave-active {
  animation: dropOut 0.2s ease both;
}

@keyframes dropIn {
  from {
    opacity: 0;
    transform: translateY(-8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes dropOut {
  from {
    opacity: 1;
    transform: translateY(0);
  }
  to {
    opacity: 0;
    transform: translateY(8px);
  }
}

/* Vue Transition: fade (用于可能的 overlay) */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* Vue Transition: icon (用于密码可见切换) */
.icon-enter-active,
.icon-leave-active {
  transition: opacity 0.18s linear, transform 0.18s linear;
}
.icon-enter-from {
  opacity: 0;
  transform: translate(-6px, -6px);
}
.icon-leave-to {
  opacity: 0;
  transform: translate(6px, 6px);
}

/* @keyframes fadeInUp (用于入场动画) */
@keyframes fadeInUp {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
