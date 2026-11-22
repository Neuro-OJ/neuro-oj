<script setup lang="ts">
import { clearError } from "#app";
const props = defineProps<{
  error: {
    statusCode?: number
    statusMessage?: string
    message?: string
    data?: { slug?: string; contests?: Array<{ publicId: string; title: string }> }
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
      <p v-if="statusCode === 403 && error.data?.contests" class="mt-3 text-sm text-text-secondary">此题的所有版本受比赛保护。请报名，并在开赛后从比赛页面作答；比赛结束后恢复普通访问。</p>
      <div v-if="statusCode === 403 && error.data?.slug" class="mt-4 flex flex-col gap-2">
        <UButton v-for="contest in error.data.contests" :key="contest.publicId" variant="outline" color="neutral" @click="clearError({ redirect: `/d/${encodeURIComponent(error.data!.slug!)}/contests/${encodeURIComponent(contest.publicId)}` })">前往 {{ contest.title }}</UButton>
      </div>
      <div class="mt-6 flex justify-center gap-3">
        <UButton color="primary" @click="goHome">返回首页</UButton>
        <UButton color="neutral" variant="outline" @click="clearError()">重试</UButton>
      </div>
    </div>
  </div>
</template>
