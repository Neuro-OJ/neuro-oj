<script setup lang="ts">
import { Users, BookOpen, Files, Activity, RefreshCw, Loader2, AlertCircle } from "@lucide/vue"

definePageMeta({
  layout: "admin",
  middleware: "admin",
  ssr: false,
})

const { isLoggedIn, loading } = useAuth()
const router = useRouter()

watch(loading, (val) => {
  if (!val && !isLoggedIn.value) router.replace("/login")
}, { immediate: true })

interface StatsCard {
  label: string
  value: number
  icon: Component
  color: string
}

const stats = ref<StatsCard[]>([])
const statsLoading = ref(true)
const statsError = ref("")
const queueStats = ref<{ pending_count: number; judging_count: number; completed_today: number } | null>(null)

async function loadStats() {
  statsLoading.value = true
  statsError.value = ""

  const [userRes, problemRes, submissionRes, queueRes] = await Promise.all([
    $fetch<{ pagination: { total: number } }>("/api/v1/admin/users").catch(() => null),
    $fetch<{ total: number }>("/api/v1/problems").catch(() => null),
    $fetch<{ pagination: { total: number } }>("/api/v1/admin/submissions").catch(() => null),
    $fetch<{ stats: { pending_count: number; judging_count: number; completed_today: number } }>("/api/v1/queue").catch(() => null),
  ])

  const allStats: StatsCard[] = []
  if (userRes) allStats.push({ label: "用户总数", value: userRes.pagination.total, icon: Users, color: "#3b82f6" })
  if (problemRes) allStats.push({ label: "题目总数", value: problemRes.total, icon: BookOpen, color: "#10b981" })
  if (submissionRes) allStats.push({ label: "提交总数", value: submissionRes.pagination.total, icon: Files, color: "#f59e0b" })
  stats.value = allStats
  queueStats.value = queueRes?.stats ?? null

  if (allStats.length === 0 && !queueRes) {
    statsError.value = "加载统计数据失败"
  }
  statsLoading.value = false
}

watch(isLoggedIn, (val) => { if (val) loadStats() }, { immediate: true })

const refreshing = ref(false)
async function handleRefresh() {
  refreshing.value = true; await loadStats(); refreshing.value = false
}
</script>

<template>
  <!-- tailwind-dashboard -->
  <div class="flex flex-col gap-6">
    <!-- 顶栏 -->
    <div class="flex items-center justify-between">
      <h1 class="text-[22px] font-bold text-text">仪表盘</h1>
      <button class="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-text-secondary bg-white border border-border rounded-lg cursor-pointer transition-all hover:border-text-secondary disabled:opacity-50 disabled:cursor-not-allowed" :disabled="refreshing" @click="handleRefresh">
        <RefreshCw :size="16" :class="{ 'animate-spin': refreshing }" />
        {{ refreshing ? "刷新中..." : "刷新" }}
      </button>
    </div>

    <!-- 加载态 -->
    <div v-if="statsLoading && stats.length === 0" class="flex flex-col items-center justify-center gap-2.5 px-6 py-12 text-text-secondary text-sm bg-white border border-border rounded-xl">
      <Loader2 :size="24" class="animate-spin" />
      <span>加载中...</span>
    </div>

    <!-- 错误态 -->
    <div v-else-if="statsError && stats.length === 0" class="flex flex-col items-center justify-center gap-2.5 px-6 py-12 text-red-600 text-sm bg-white border border-border rounded-xl">
      <AlertCircle :size="20" />
      <span>{{ statsError }}</span>
      <button class="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-text-secondary bg-white border border-border rounded-lg cursor-pointer transition-all hover:border-text-secondary mt-4" @click="loadStats">重试</button>
    </div>

    <!-- 统计卡片 -->
    <div v-else class="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
      <div
        v-for="card in stats" :key="card.label"
        class="flex items-center gap-4 p-5 bg-white border border-border rounded-xl"
      >
        <div class="flex items-center justify-center size-12 rounded-xl shrink-0" :style="{ background: card.color + '15', color: card.color }">
          <component :is="card.icon" :size="24" />
        </div>
        <div class="flex flex-col gap-0.5">
          <span class="text-2xl font-bold text-text leading-tight">{{ card.value }}</span>
          <span class="text-xs text-text-secondary">{{ card.label }}</span>
        </div>
      </div>
    </div>

    <!-- 队列状态 -->
    <div v-if="queueStats" class="bg-white border border-border rounded-xl p-5">
      <h2 class="flex items-center gap-2 text-base font-semibold text-text mb-4">
        <Activity :size="18" />
        评测队列状态
      </h2>
      <div class="grid grid-cols-3 gap-4">
        <div class="flex flex-col items-center gap-1 p-4 rounded-lg bg-gray-50">
          <span class="text-[28px] font-bold text-amber-500">{{ queueStats.pending_count }}</span>
          <span class="text-xs text-text-secondary">等待中</span>
        </div>
        <div class="flex flex-col items-center gap-1 p-4 rounded-lg bg-gray-50">
          <span class="text-[28px] font-bold text-blue-500">{{ queueStats.judging_count }}</span>
          <span class="text-xs text-text-secondary">评测中</span>
        </div>
        <div class="flex flex-col items-center gap-1 p-4 rounded-lg bg-gray-50">
          <span class="text-[28px] font-bold text-emerald-500">{{ queueStats.completed_today }}</span>
          <span class="text-xs text-text-secondary">今日完成</span>
        </div>
      </div>
    </div>
  </div>
</template>
