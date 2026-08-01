<script setup lang="ts">
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
  value: number | null
  icon: string
  color: string
  error?: string
}

const stats = ref<StatsCard[]>([])
const statsLoading = ref(true)
const statsError = ref("")
const queueStats = ref<{ pending_count: number; judging_count: number; completed_today: number } | null>(null)
const queueError = ref("")
const lastSuccessfulRefresh = ref<Date | null>(null)
let requestVersion = 0

function statCard(
  label: string,
  icon: string,
  color: string,
  result: PromiseSettledResult<{ pagination?: { total: number }; total?: number }>,
): StatsCard {
  if (result.status === "rejected") {
    return { label, value: null, icon, color, error: "加载失败" }
  }
  return {
    label,
    value: result.value.pagination?.total ?? result.value.total ?? 0,
    icon,
    color,
  }
}

async function loadStats() {
  const currentRequest = ++requestVersion
  statsLoading.value = true
  statsError.value = ""

  const [userRes, problemRes, submissionRes, queueRes] = await Promise.allSettled([
    $fetch<{ pagination: { total: number } }>("/api/v1/admin/users"),
    $fetch<{ total: number }>("/api/v1/problems"),
    $fetch<{ pagination: { total: number } }>("/api/v1/admin/submissions"),
    $fetch<{ stats: { pending_count: number; judging_count: number; completed_today: number } }>("/api/v1/queue"),
  ])
  if (currentRequest !== requestVersion) return

  stats.value = [
    statCard("用户总数", 'i-lucide-users', "#3b82f6", userRes),
    statCard("题目总数", 'i-lucide-book-open', "#10b981", problemRes),
    statCard("提交总数", 'i-lucide-files', "#f59e0b", submissionRes),
  ]
  queueStats.value = queueRes.status === "fulfilled" ? queueRes.value.stats : null
  queueError.value = queueRes.status === "rejected" ? "队列状态加载失败" : ""

  if (stats.value.every((card) => card.error) && queueRes.status === "rejected") {
    statsError.value = "加载统计数据失败"
  } else {
    lastSuccessfulRefresh.value = new Date()
  }
  if (currentRequest === requestVersion) statsLoading.value = false
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
    <PageHeader title="仪表盘">
      <template #actions>
        <UButton color="neutral" variant="outline" size="sm" class="text-text-secondary bg-white border-border hover:border-text-secondary" :disabled="refreshing" @click="handleRefresh">
          <UIcon name="i-lucide-refresh-cw" :class="{ 'animate-spin': refreshing }" class="size-4" />
          {{ refreshing ? "刷新中..." : "刷新" }}
        </UButton>
      </template>
    </PageHeader>

    <!-- 加载态 -->
    <div v-if="statsLoading && stats.length === 0" class="flex flex-col items-center justify-center gap-2.5 px-6 py-12 text-text-secondary text-sm bg-white border border-border rounded-xl">
      <UIcon name="i-lucide-loader-2" class="animate-spin size-6" />
      <span>加载中...</span>
    </div>

    <!-- 错误态 -->
    <div v-else-if="statsError && stats.length === 0" class="flex flex-col items-center justify-center gap-2.5 px-6 py-12 text-red-600 text-sm bg-white border border-border rounded-xl">
      <UIcon name="i-lucide-alert-circle" class="size-5" />
      <span>{{ statsError }}</span>
      <UButton color="neutral" variant="outline" size="sm" class="text-text-secondary bg-white border-border hover:border-text-secondary mt-4" @click="loadStats">重试</UButton>
    </div>

    <!-- 统计卡片 -->
    <div v-else class="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
      <div
        v-for="card in stats" :key="card.label"
        class="flex items-center gap-4 p-5 bg-white border border-border rounded-xl"
      >
        <div class="flex items-center justify-center size-12 rounded-xl shrink-0" :style="{ background: card.color + '15', color: card.color }">
          <UIcon :name="card.icon" class="size-6" />
        </div>
        <div class="flex flex-col gap-0.5">
          <span class="text-2xl font-bold text-text leading-tight">{{ card.value ?? "--" }}</span>
          <span class="text-xs text-text-secondary">{{ card.label }}</span>
          <button v-if="card.error" class="text-left text-xs text-error-text underline" @click="loadStats">{{ card.error }}，重试</button>
        </div>
      </div>
    </div>

    <!-- 队列状态 -->
    <div v-if="queueStats" class="bg-white border border-border rounded-xl p-5">
      <h2 class="flex items-center gap-2 text-base font-semibold text-text mb-4">
        <UIcon name="i-lucide-activity" class="size-4.5" />
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
    <div v-else-if="queueError" class="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-error-text">
      <UIcon name="i-lucide-alert-circle" class="size-4.5" />
      <span>{{ queueError }}</span>
      <button class="underline" @click="loadStats">重试</button>
    </div>

    <p v-if="lastSuccessfulRefresh" class="text-xs text-text-muted">最近刷新：{{ lastSuccessfulRefresh.toLocaleString("zh-CN") }}</p>
  </div>
</template>
