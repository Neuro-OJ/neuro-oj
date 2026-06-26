<script setup lang="ts">
import { Loader2, AlertCircle, FileText } from "@lucide/vue"

type Status = "loading" | "error" | "empty" | "data"

defineProps<{ status: Status; error?: string; emptyText?: string }>()
defineEmits<{ retry: [] }>()
</script>
<template>
  <Transition name="async" mode="out-in">
    <div v-if="status === 'loading'" class="flex flex-col items-center justify-center gap-4 px-6 py-20 text-text-muted" role="status" aria-live="polite">
      <slot name="loading">
        <div class="h-[28px] w-[28px] border-[3px] border-border border-t-primary rounded-full animate-spin-slow" />
        <span>加载中...</span>
      </slot>
    </div>
    <div v-else-if="status === 'error'" class="flex flex-col items-center justify-center gap-4 px-6 py-20 text-text-muted" role="alert">
      <slot name="error" :error="error">
        <span class="flex items-center justify-center size-11 rounded-full bg-error-bg text-error-text text-xl font-bold"><AlertCircle :size="22" /></span>
        <p>{{ error ?? "加载失败" }}</p>
        <button class="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold rounded-md border border-primary text-primary bg-transparent hover:bg-primary hover:text-white transition-colors cursor-pointer" @click="$emit('retry')">重试</button>
      </slot>
    </div>
    <div v-else-if="status === 'empty'" class="flex flex-col items-center justify-center gap-4 px-6 py-20 text-text-muted" role="status" aria-live="polite">
      <slot name="empty">
        <FileText :size="48" class="opacity-30" />
        <p>{{ emptyText ?? "暂无数据" }}</p>
        <slot name="empty-action" />
      </slot>
    </div>
    <slot v-else-if="status === 'data'" />
  </Transition>
</template>
<style scoped>
.async-enter-active, .async-leave-active { transition: opacity 0.15s ease; }
.async-enter-from, .async-leave-to { opacity: 0; }
</style>
