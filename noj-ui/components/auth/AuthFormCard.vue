<template>
  <div class="w-full max-w-[380px] relative">
    <!-- Error banner -->
    <ToastBanner :visible="!!error" color="error" icon="i-lucide-alert-circle" :message="error"
      @close="$emit('clear-error')" />

    <!-- Success banner slot -->
    <slot name="banner-success" />

    <!-- Info banner slot (e.g. banned account message) -->
    <slot name="banner-info" />

    <div class="bg-bg-panel border border-border rounded-lg p-8">
      <h1 class="text-22px font-bold text-center mb-3 text-text animate-[fadeInUp_0.5s_ease_both]">{{ title }}</h1>
      <p v-if="subtitle"
        class="text-center text-sm text-text-secondary mb-6 animate-[fadeInUp_0.5s_ease_0.05s_both]">{{ subtitle }}</p>

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
  title: string;
  subtitle?: string;
  error: string;
  loading: boolean;
  submitLabel: string;
  loadingLabel?: string;
}>();

defineEmits<{
  submit: [];
  'clear-error': [];
}>();
</script>
