<script setup lang="ts">
type Status = "loading" | "error" | "empty" | "data"
type Padding = "normal" | "compact" | "none"

// padding 控制空态/加载/错误的垂直留白：normal 用于整页主内容，
// compact 用于卡片内的次级区块，none 用于调用方自带边框与内边距的插槽。
const props = withDefaults(defineProps<{ status: Status; error?: string; emptyText?: string; padding?: Padding }>(), {
  padding: "normal",
})
defineEmits<{ retry: [] }>()
const pad = computed(() => props.padding === "none" ? "py-0" : props.padding === "compact" ? "py-8" : "py-20")
</script>
<template>
  <Transition name="async" mode="out-in">
    <div v-if="status === 'loading'" class="flex flex-col items-center justify-center gap-4 px-6 text-text-muted" :class="pad" role="status" aria-live="polite">
      <slot name="loading">
        <div class="h-[28px] w-[28px] border-[3px] border-border border-t-primary rounded-full animate-spin-slow" />
        <span>加载中...</span>
      </slot>
    </div>
    <div v-else-if="status === 'error'" class="flex flex-col items-center justify-center gap-4 px-6 text-text-muted" :class="pad" role="alert">
      <slot name="error" :error="error">
        <span class="flex items-center justify-center size-11 rounded-full bg-red-50 text-error-text text-xl font-bold"><UIcon name="i-lucide-alert-circle" class="size-[22px]" /></span>
        <p>{{ error ?? "加载失败" }}</p>
        <UButton color="primary" variant="outline" size="sm" @click="$emit('retry')">重试</UButton>
      </slot>
    </div>
    <div v-else-if="status === 'empty'" class="flex flex-col items-center justify-center gap-4 px-6 text-text-muted" :class="pad" role="status" aria-live="polite">
      <slot name="empty">
        <UIcon name="i-lucide-file-text" class="opacity-30 size-[48px]" />
        <p>{{ emptyText ?? "暂无数据" }}</p>
        <slot name="empty-action" />
      </slot>
    </div>
    <!-- data 分支包一层透明容器：Transition 只允许单元素，
         调用方 data 插槽可能传多个根节点（如表格 + 分页），
         display: contents 不改变布局语义 -->
    <div v-else-if="status === 'data'" class="contents">
      <slot />
    </div>
  </Transition>
</template>
<style scoped>
.async-enter-active, .async-leave-active { transition: opacity 0.15s ease; }
.async-enter-from, .async-leave-to { opacity: 0; }
</style>
