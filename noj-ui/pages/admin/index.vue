<script setup lang="ts">
definePageMeta({
  layout: "admin",
  middleware: "admin",
  ssr: false,
})

const { isLoggedIn, loading } = useAuth()
const router = useRouter()

useRequireLogin()

interface StatsCard {
  label: string
  value: number | null
  icon: string
  /** 图标容器类（Tailwind 字面量，避免动态拼接不可扫描） */
  colorClass: string
  error?: string
}

const stats = ref<StatsCard[]>([])
const statsLoading = ref(true)
const statsError = ref("")
const { api } = useApi()
const queueStats = ref<{ pending_count: number; judging_count: number; completed_today: number } | null>(null)
const queueError = ref("")
const lastSuccessfulRefresh = ref<Date | null>(null)
let requestVersion = 0

// 自动轮询间隔（默认 5s，可由刷新控制条切换/关闭）
const pollInterval = ref<number | null>(5000)

function statCard(
  label: string,
  icon: string,
  colorClass: string,
  result: PromiseSettledResult<{ pagination?: { total: number }; total?: number }>,
): StatsCard {
  if (result.status === "rejected") {
    return { label, value: null, icon, colorClass, error: "加载失败" }
  }
  return {
    label,
    value: result.value.pagination?.total ?? result.value.total ?? 0,
    icon,
    colorClass,
  }
}

/** silent=true 用于轮询：不置 loading、不清错误，失败保留旧数据 */
async function loadStats(silent = false) {
  const currentRequest = ++requestVersion
  if (!silent) {
    statsLoading.value = true
    statsError.value = ""
  }

  const [userRes, problemRes, submissionRes, queueRes] = await Promise.allSettled([
    api.get<{ pagination: { total: number } }>("/api/v1/admin/users", { silent: true }),
    api.get<{ total: number }>("/api/v1/problems", { silent: true }),
    api.get<{ pagination: { total: number } }>("/api/v1/admin/submissions", { silent: true }),
    api.get<{ stats: { pending_count: number; judging_count: number; completed_today: number } }>("/api/v1/queue", { silent: true }),
  ])
  if (currentRequest !== requestVersion) return

  stats.value = [
    statCard("用户总数", 'i-lucide-users', "text-primary bg-primary-bg", userRes),
    statCard("题目总数", 'i-lucide-book-open', "text-success-600 bg-green-50", problemRes),
    statCard("提交总数", 'i-lucide-files', "text-warning-600 bg-amber-50", submissionRes),
  ]
  queueStats.value = queueRes.status === "fulfilled" ? queueRes.value.stats : null
  // 轮询静默失败不写入错误横幅（避免打断用户），仅首载/手动刷新失败时展示
  if (!silent) queueError.value = queueRes.status === "rejected" ? "队列状态加载失败" : ""

  if (stats.value.every((card) => card.error) && queueRes.status === "rejected") {
    if (!silent) statsError.value = "加载统计数据失败"
  } else {
    lastSuccessfulRefresh.value = new Date()
  }
  // 无条件复位 loading（轮询静默请求不置 loading，但若成为最后一个请求需复位手动 loading）
  if (currentRequest === requestVersion) statsLoading.value = false
}

watch(isLoggedIn, (val) => { if (val) loadStats() }, { immediate: true })

// 评测队列统计自动轮询（页面隐藏自动暂停，卸载自动清理）
usePolling({
  intervalMs: pollInterval,
  fetcher: () => loadStats(true),
  immediate: false,
  active: isLoggedIn,
})

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
        <RefreshControl
          v-model:interval="pollInterval"
          :last-refresh="lastSuccessfulRefresh"
          :refreshing="refreshing"
          @refresh="handleRefresh"
        />
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

    <!-- 统计卡片（首卡主视觉：跨两列 + 更大数字/图标，打破三卡等权） -->
    <div v-else class="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
      <div
        v-for="(card, i) in stats" :key="card.label"
        class="flex items-center gap-4 p-5 bg-white border border-border rounded-xl"
        :class="i === 0 ? 'col-span-2 max-lg:col-span-1' : ''"
      >
        <div class="flex items-center justify-center size-12 rounded-xl shrink-0" :class="card.colorClass">
          <UIcon :name="card.icon" class="size-6" :class="i === 0 ? 'lg:size-7' : ''" />
        </div>
        <div class="flex flex-col gap-0.5">
          <span class="text-2xl font-bold text-text leading-tight" :class="i === 0 ? 'lg:text-3xl' : ''">{{ card.value ?? "--" }}</span>
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
        <div class="flex flex-col items-center gap-1 p-4 rounded-lg bg-bg-page">
          <span class="text-28px font-bold text-warning-600">{{ queueStats.pending_count }}</span>
          <span class="text-xs text-text-secondary">等待中</span>
        </div>
        <div class="flex flex-col items-center gap-1 p-4 rounded-lg bg-bg-page">
          <span class="text-28px font-bold text-info-600">{{ queueStats.judging_count }}</span>
          <span class="text-xs text-text-secondary">评测中</span>
        </div>
        <div class="flex flex-col items-center gap-1 p-4 rounded-lg bg-bg-page">
          <span class="text-28px font-bold text-success-600">{{ queueStats.completed_today }}</span>
          <span class="text-xs text-text-secondary">今日完成</span>
        </div>
      </div>
    </div>
    <UAlert v-else-if="queueError" color="error" icon="i-lucide-alert-circle" :title="queueError" class="rounded-xl">
      <template #actions>
        <UButton color="neutral" variant="link" size="sm" @click="loadStats">重试</UButton>
      </template>
    </UAlert>
  </div>
</template>
