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

interface CardState {
  label: string
  icon: Component
  color: string
  value: number | null
  error: string | null
  loaded: boolean
}

const cards = ref<CardState[]>([
  { label: "用户总数", icon: Users, color: "#3b82f6", value: null, error: null, loaded: false },
  { label: "题目总数", icon: BookOpen, color: "#10b981", value: null, error: null, loaded: false },
  { label: "提交总数", icon: Files, color: "#f59e0b", value: null, error: null, loaded: false },
])

const queueStats = ref<{ pending_count: number; judging_count: number; completed_today: number } | null>(null)
const queueError = ref<string | null>(null)
const lastRefreshTime = ref<string | null>(null)
const overallError = ref("")
const loadingCards = ref(true)
const loadingQueue = ref(true)
const refreshing = ref(false)

async function loadStats() {
  loadingCards.value = cards.value.every((c) => !c.loaded)
  loadingQueue.value = queueStats.value === null
  overallError.value = ""

  const apiCalls = [
    { key: "users", fetch: $fetch<{ pagination: { total: number } }>("/api/v1/admin/users") },
    { key: "problems", fetch: $fetch<{ total: number }>("/api/v1/problems") },
    { key: "submissions", fetch: $fetch<{ pagination: { total: number } }>("/api/v1/admin/submissions") },
  ]

  const results = await Promise.allSettled(
    apiCalls.map((c) => c.fetch),
  )

  // 更新卡片状态
  const cardKeys = ["users", "problems", "submissions"]
  for (let i = 0; i < results.length; i++) {
    const card = cards.value[i]
    if (results[i].status === "fulfilled") {
      const value = results[i].value
      if (i === 0) card.value = (value as { pagination: { total: number } }).pagination.total
      else if (i === 1) card.value = (value as { total: number }).total
      else card.value = (value as { pagination: { total: number } }).pagination.total
      card.error = null
      card.loaded = true
    } else {
      card.value = null
      card.error = "加载失败"
      card.loaded = true
    }
  }

  // 队列状态独立处理
  try {
    const queueRes = await $fetch<{ stats: { pending_count: number; judging_count: number; completed_today: number } }>("/api/v1/queue")
    queueStats.value = queueRes.stats
    queueError.value = null
  } catch {
    queueError.value = "加载失败"
  } finally {
    loadingQueue.value = false
  }

  const anyLoaded = cards.value.some((c) => c.loaded && c.value !== null)
  if (!anyLoaded && !queueStats.value) {
    overallError.value = "所有统计数据加载失败"
  }

  lastRefreshTime.value = new Date().toLocaleString("zh-CN")
  loadingCards.value = false
}

watch(isLoggedIn, (val) => { if (val) loadStats() }, { immediate: true })

async function handleRefresh() {
  refreshing.value = true
  await loadStats()
  refreshing.value = false
}

async function retryCard(index: number) {
  cards.value[index].error = null
  cards.value[index].loaded = false
  // 仅重试单个接口
  const endpoints = ["/api/v1/admin/users", "/api/v1/problems", "/api/v1/admin/submissions"]
  try {
    const res = await $fetch(endpoints[index])
    const card = cards.value[index]
    if (index === 0) card.value = (res as { pagination: { total: number } }).pagination.total
    else if (index === 1) card.value = (res as { total: number }).total
    else card.value = (res as { pagination: { total: number } }).pagination.total
    card.error = null
    card.loaded = true
  } catch {
    cards.value[index].error = "加载失败"
    cards.value[index].loaded = true
  }
}
</script>

<template>
  <!-- tailwind-dashboard -->
  <div class="flex flex-col gap-6">
    <!-- 顶栏 -->
    <PageHeader title="仪表盘">
      <template #actions>
        <div class="flex items-center gap-2">
          <span v-if="lastRefreshTime" class="text-xs text-text-muted">最后刷新：{{ lastRefreshTime }}</span>
          <button
            class="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-text-secondary bg-white border border-border rounded-lg cursor-pointer transition-all hover:border-text-secondary disabled:opacity-50 disabled:cursor-not-allowed"
            :disabled="refreshing"
            @click="handleRefresh"
          >
            <RefreshCw :size="16" :class="{ 'animate-spin': refreshing }" />
            {{ refreshing ? "刷新中..." : "刷新" }}
          </button>
        </div>
      </template>
    </PageHeader>

    <!-- 全量错误态 -->
    <div v-if="overallError && cards.every(c => c.error)" class="flex flex-col items-center justify-center gap-2.5 px-6 py-12 text-red-600 text-sm bg-white border border-border rounded-xl">
      <AlertCircle :size="20" />
      <span>{{ overallError }}</span>
      <button class="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-text-secondary bg-white border border-border rounded-lg cursor-pointer transition-all hover:border-text-secondary mt-4" @click="loadStats">重试</button>
    </div>

    <!-- 统计卡片 -->
    <div v-if="!overallError || !cards.every(c => c.error)" class="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
      <div
        v-for="(card, idx) in cards" :key="card.label"
        class="flex items-center gap-4 p-5 bg-white border border-border rounded-xl relative"
        :class="{ 'opacity-60': card.error }"
      >
        <div class="flex items-center justify-center size-12 rounded-xl shrink-0" :style="{ background: card.color + '15', color: card.color }">
          <component :is="card.icon" :size="24" />
        </div>
        <div class="flex flex-col gap-0.5 min-w-0">
          <!-- 加载中骨架 -->
          <template v-if="!card.loaded">
            <div class="h-7 w-16 bg-gray-200 rounded animate-pulse" />
            <div class="h-3 w-12 bg-gray-100 rounded animate-pulse mt-1" />
          </template>
          <!-- 错误状态 -->
          <template v-else-if="card.error">
            <div class="flex items-center gap-1 text-xs text-error-text">
              <AlertCircle :size="12" />
              <span>{{ card.error }}</span>
              <button class="ml-1 underline cursor-pointer" @click="retryCard(idx)">重试</button>
            </div>
          </template>
          <!-- 正常数据 -->
          <template v-else>
            <span class="text-2xl font-bold text-text leading-tight">{{ card.value }}</span>
            <span class="text-xs text-text-secondary">{{ card.label }}</span>
          </template>
        </div>
      </div>
    </div>

    <!-- 队列状态 -->
    <div v-if="queueStats || queueError" class="bg-white border border-border rounded-xl p-5">
      <h2 class="flex items-center gap-2 text-base font-semibold text-text mb-4">
        <Activity :size="18" />
        评测队列状态
      </h2>

      <!-- 队列加载中 -->
      <div v-if="loadingQueue" class="flex items-center justify-center gap-2 py-4 text-sm text-text-secondary">
        <Loader2 :size="16" class="animate-spin" />
        <span>加载中...</span>
      </div>

      <!-- 队列错误 -->
      <div v-else-if="queueError" class="flex items-center gap-2 py-4 text-sm text-error-text">
        <AlertCircle :size="14" />
        <span>队列数据加载失败</span>
        <button class="ml-1 underline cursor-pointer" @click="loadStats">重试</button>
      </div>

      <!-- 队列数据 -->
      <div v-else-if="queueStats" class="grid grid-cols-3 gap-4">
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
