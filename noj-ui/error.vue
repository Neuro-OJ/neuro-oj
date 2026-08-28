<script setup lang="ts">
const props = defineProps<{
  error: {
    statusCode?: number
    statusMessage?: string
    message?: string
  }
}>()

const statusCode = computed(() => props.error?.statusCode ?? 500)
const message = computed(
  () => props.error?.statusMessage || props.error?.message || '页面出错了，请稍后重试',
)

function goHome() {
  clearError({ redirect: '/' })
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-bg-page px-4">
    <div class="w-full max-w-md rounded-2xl border border-border bg-white p-8 text-center shadow-card">
      <p class="text-6xl font-bold text-primary">{{ statusCode }}</p>
      <h1 class="mt-4 text-xl font-semibold text-text">{{ message }}</h1>
      <div class="mt-6 flex justify-center gap-3">
        <UButton color="primary" @click="goHome">返回首页</UButton>
        <UButton color="neutral" variant="outline" @click="clearError()">重试</UButton>
      </div>
    </div>
  </div>
</template>
