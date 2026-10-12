<script setup lang="ts">
import { computed, ref, watch } from "vue"

definePageMeta({
  layout: "admin",
  middleware: "admin",
  ssr: false,
})

const { isLoggedIn } = useAuth()
const { api } = useApi()

useRequireLogin()

interface StatsCard {
  label: string
  value: number | null
  icon: string
  colorClass: string
  badgeClass: string
  subText?: string
  error?: string
}

interface AuditLogSummary {
  id: string
  admin_id: string
  action: string
  created_at: string
}

const stats = ref<StatsCard[]>([])
const statsLoading = ref(true)
const statsError = ref("")
const queueStats = ref<{ pending_count: number; judging_count: number; completed_today: number } | null>(null)
const queueError = ref("")
const pendingReportsCount = ref(0)
const recentAuditLogs = ref<AuditLogSummary[]>([])
const lastSuccessfulRefresh = ref<Date | null>(null)
const refreshing = ref(false)
let requestVersion = 0

// 自动轮询间隔（默认 5s，可由刷新控制条切换/关闭）
const pollInterval = ref<number | null>(5000)

function statCard(
  label: string,
  icon: string,
  colorClass: string,
  badgeClass: string,
  subText: string,
  result: PromiseSettledResult<{ pagination?: { total: number }; total?: number }>,
): StatsCard {
  if (result.status === "rejected") {
    return { label, value: null, icon, colorClass, badgeClass, error: "加载失败" }
  }
  return {
    label,
    value: result.value.pagination?.total ?? result.value.total ?? 0,
    icon,
    colorClass,
    badgeClass,
    subText,
  }
}

/** silent=true 用于轮询：不置 loading、不清错误，失败保留旧数据 */
async function loadStats(silent = false) {
  const currentRequest = ++requestVersion
  if (!silent) {
    statsLoading.value = true
    statsError.value = ""
  }

  const [userRes, problemRes, submissionRes, queueRes, reportsRes, auditRes] = await Promise.allSettled([
    api.get<{ pagination: { total: number } }>("/api/v1/admin/identity/users", { silent: true }),
    api.get<{ total: number }>("/api/v1/problems", { silent: true }),
    api.get<{ pagination: { total: number } }>("/api/v1/admin/submission/submissions", { silent: true }),
    api.get<{ stats: { pending_count: number; judging_count: number; completed_today: number } }>("/api/v1/queue", { silent: true }),
    api.get<{ data: unknown[] }>("/api/v1/admin/community/reports?status=pending", { silent: true }),
    api.get<{ data: AuditLogSummary[] }>("/api/v1/admin/system/audit-logs?per_page=5", { silent: true }),
  ])
  if (currentRequest !== requestVersion) return

  const completedToday = queueRes.status === "fulfilled" ? queueRes.value.stats.completed_today : 0

  stats.value = [
    statCard("用户规模", "i-lucide-users", "text-primary", "bg-primary-bg border-primary/20", "注册开发者与选手", userRes),
    statCard("题库储备", "i-lucide-book-open", "text-success-600", "bg-green-50 border-green-200", "算法与 LLM 评测题", problemRes),
    statCard("历史评测量", "i-lucide-files", "text-warning-600", "bg-amber-50 border-amber-200", "累计运行提交总量", submissionRes),
    {
      label: "今日评测吞吐",
      value: completedToday,
      icon: "i-lucide-cpu",
      colorClass: "text-purple-600",
      badgeClass: "bg-purple-50 border-purple-200",
      subText: "沙箱容器执行已完成",
    },
  ]

  queueStats.value = queueRes.status === "fulfilled" ? queueRes.value.stats : null
  if (reportsRes.status === "fulfilled" && Array.isArray(reportsRes.value.data)) {
    pendingReportsCount.value = reportsRes.value.data.length
  }
  if (auditRes.status === "fulfilled" && Array.isArray(auditRes.value.data)) {
    recentAuditLogs.value = auditRes.value.data.slice(0, 5)
  }

  if (!silent) queueError.value = queueRes.status === "rejected" ? "队列状态加载失败" : ""

  if (stats.value.every((card) => card.error) && queueRes.status === "rejected") {
    if (!silent) statsError.value = "加载统计数据失败"
  } else {
    lastSuccessfulRefresh.value = new Date()
  }

  if (currentRequest === requestVersion) statsLoading.value = false
}

watch(isLoggedIn, (val) => { if (val) loadStats() }, { immediate: true })

usePolling({
  intervalMs: pollInterval,
  fetcher: () => loadStats(true),
  immediate: false,
  active: isLoggedIn,
})

async function handleRefresh() {
  refreshing.value = true
  await loadStats()
  refreshing.value = false
}

const actionItems = [
  { label: "新建编程题", to: "/admin/problem-new", icon: "i-lucide-plus-circle", desc: "创建算法题或工程题" },
  { label: "竞赛管理", to: "/admin/contests", icon: "i-lucide-trophy", desc: "安排赛事与封榜设置" },
  { label: "全站公告", to: "/admin/announcements", icon: "i-lucide-megaphone", desc: "发布系统通知或停机维护" },
  { label: "LLM Provider", to: "/admin/llm/providers", icon: "i-lucide-server", desc: "接入与轮询大模型 Key" },
  { label: "角色与权限", to: "/admin/roles", icon: "i-lucide-shield-check", desc: "RBAC 权限树与分配" },
  { label: "系统设置", to: "/admin/settings", icon: "i-lucide-settings", desc: "核心参数与环境变量" },
]

function formatActionLabel(action: string): string {
  const map: Record<string, string> = {
    "users.role_change": "变更用户角色",
    "users.ban": "封禁用户",
    "users.unban": "解封用户",
    "users.delete": "删除用户",
    "system.setting_change": "修改系统配置",
    "announcement.create": "发布系统公告",
    "announcement.delete": "删除系统公告",
  }
  return map[action] ?? action
}

function formatRelativeTime(dateStr: string): string {
  const diff = Math.max(0, Date.now() - new Date(dateStr).getTime())
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "刚刚"
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <!-- 顶栏 -->
    <AdminPageHeader
      title="仪表盘"
      description="系统核心指标态势、评测流与待办行动中枢"
      icon="i-lucide-layout-dashboard"
    >
      <template #actions>
        <RefreshControl
          v-model:interval="pollInterval"
          :last-refresh="lastSuccessfulRefresh"
          :refreshing="refreshing"
          @refresh="handleRefresh"
        />
      </template>
    </AdminPageHeader>

    <!-- 待办任务中心（Action Center / Priority Banner） -->
    <div
      v-if="pendingReportsCount > 0 || (queueStats && queueStats.pending_count > 10)"
      class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 bg-amber-50/70 border border-amber-200 rounded-lg text-amber-900"
    >
      <div class="flex items-center gap-3">
        <div class="size-8 rounded-md bg-amber-100 flex items-center justify-center shrink-0 text-amber-700">
          <UIcon name="i-lucide-alert-triangle" class="size-4.5" />
        </div>
        <div class="flex flex-col">
          <span class="text-sm font-semibold">待处理运维与风控事项</span>
          <span class="text-xs text-amber-800">
            <template v-if="pendingReportsCount > 0">当前有 <strong class="tabular-nums font-bold">{{ pendingReportsCount }}</strong> 条用户举报等待人工核查。</template>
            <template v-if="queueStats && queueStats.pending_count > 10"> 评测队列积压任务较多（{{ queueStats.pending_count }} 条）。</template>
          </span>
        </div>
      </div>

      <div class="flex items-center gap-2 shrink-0">
        <NuxtLink
          v-if="pendingReportsCount > 0"
          to="/admin/reports"
          class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-amber-900 bg-white border border-amber-300 rounded hover:bg-amber-100/50 transition-colors no-underline"
        >
          前往处理举报
          <UIcon name="i-lucide-arrow-right" class="size-3.5" />
        </NuxtLink>
        <NuxtLink
          v-if="queueStats && queueStats.pending_count > 10"
          to="/admin/submissions"
          class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-amber-900 bg-white border border-amber-300 rounded hover:bg-amber-100/50 transition-colors no-underline"
        >
          查看评测队列
        </NuxtLink>
      </div>
    </div>

    <!-- 加载中状态 -->
    <div v-if="statsLoading && stats.length === 0" class="flex flex-col items-center justify-center gap-3 py-16 bg-white border border-border rounded-lg shadow-card">
      <UIcon name="i-lucide-loader-2" class="animate-spin size-7 text-primary" />
      <span class="text-sm text-text-secondary">正在获取系统监控数据...</span>
    </div>

    <!-- 错误状态 -->
    <div v-else-if="statsError && stats.length === 0" class="flex flex-col items-center justify-center gap-3 py-16 bg-white border border-border rounded-lg shadow-card text-error-text">
      <UIcon name="i-lucide-alert-circle" class="size-7" />
      <span class="text-sm font-medium">{{ statsError }}</span>
      <UButton color="neutral" variant="outline" size="sm" class="mt-2" @click="loadStats()">重试加载</UButton>
    </div>

    <template v-else>
      <!-- 核心指标网格 -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div
          v-for="card in stats"
          :key="card.label"
          class="flex flex-col justify-between p-5 bg-white border border-border rounded-lg shadow-card hover:border-primary/40 transition-colors"
        >
          <div class="flex items-center justify-between gap-3 mb-3">
            <span class="text-xs font-medium text-text-secondary">{{ card.label }}</span>
            <div class="size-9 rounded-md border flex items-center justify-center shrink-0" :class="[card.badgeClass, card.colorClass]">
              <UIcon :name="card.icon" class="size-5" />
            </div>
          </div>

          <div class="flex flex-col">
            <span class="text-28px font-bold text-text tabular-nums tracking-tight leading-none mb-1">
              {{ card.value !== null ? card.value.toLocaleString() : "--" }}
            </span>
            <span class="text-[11px] text-text-muted">{{ card.subText }}</span>
            <button
              v-if="card.error"
              type="button"
              class="text-left text-xs text-error-text underline mt-1 cursor-pointer"
              @click="loadStats()"
            >
              {{ card.error }}，点击重试
            </button>
          </div>
        </div>
      </div>

      <!-- 态势与服务中心：双栏布局 -->
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <!-- 左侧 2 栏：评测队列与实时沙箱态势 -->
        <div class="lg:col-span-2 flex flex-col gap-4 p-5 sm:p-6 bg-white border border-border rounded-lg shadow-card">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <div class="size-7 rounded bg-primary-bg text-primary flex items-center justify-center">
                <UIcon name="i-lucide-activity" class="size-4" />
              </div>
              <h2 class="text-base font-bold text-text">评测执行与队列态势</h2>
            </div>
            <NuxtLink to="/admin/submissions" class="text-xs text-primary hover:underline inline-flex items-center gap-1">
              实时提交流
              <UIcon name="i-lucide-chevron-right" class="size-3.5" />
            </NuxtLink>
          </div>

          <div v-if="queueStats" class="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-1">
            <div class="flex flex-col p-4 rounded-lg bg-bg-page/70 border border-border/60">
              <div class="flex items-center justify-between text-xs text-text-secondary mb-2">
                <span>等待中队列</span>
                <span class="size-2 rounded-full" :class="queueStats.pending_count > 0 ? 'bg-amber-500 animate-ping' : 'bg-border'" />
              </div>
              <span class="text-32px font-extrabold text-warning-600 tabular-nums leading-none mb-1">
                {{ queueStats.pending_count }}
              </span>
              <span class="text-[11px] text-text-muted">待进入 Docker 沙箱</span>
            </div>

            <div class="flex flex-col p-4 rounded-lg bg-bg-page/70 border border-border/60">
              <div class="flex items-center justify-between text-xs text-text-secondary mb-2">
                <span>正在评测</span>
                <span class="size-2 rounded-full" :class="queueStats.judging_count > 0 ? 'bg-primary animate-pulse' : 'bg-border'" />
              </div>
              <span class="text-32px font-extrabold text-primary tabular-nums leading-none mb-1">
                {{ queueStats.judging_count }}
              </span>
              <span class="text-[11px] text-text-muted">双容器 Evaluator 执行中</span>
            </div>

            <div class="flex flex-col p-4 rounded-lg bg-bg-page/70 border border-border/60">
              <div class="flex items-center justify-between text-xs text-text-secondary mb-2">
                <span>今日完成</span>
                <span class="size-2 rounded-full bg-success-600" />
              </div>
              <span class="text-32px font-extrabold text-success-600 tabular-nums leading-none mb-1">
                {{ queueStats.completed_today }}
              </span>
              <span class="text-[11px] text-text-muted">今日成功评测总量</span>
            </div>
          </div>
          <div v-else-if="queueError" class="p-4 rounded-lg bg-red-50 text-error-text text-sm flex items-center justify-between">
            <span>{{ queueError }}</span>
            <UButton color="neutral" variant="outline" size="xs" @click="loadStats()">重试</UButton>
          </div>

          <!-- 基础设施心跳矩阵 -->
          <div class="pt-4 border-t border-border mt-2">
            <h3 class="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">核心基础设施状态</h3>
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <div class="flex items-center gap-2 p-2.5 rounded bg-bg-page/50 border border-border/50">
                <span class="size-2 rounded-full bg-success-600 shrink-0" />
                <div class="flex flex-col min-w-0">
                  <span class="font-medium text-text truncate">Core API</span>
                  <span class="text-[10px] text-text-muted">端口 8000</span>
                </div>
              </div>

              <div class="flex items-center gap-2 p-2.5 rounded bg-bg-page/50 border border-border/50">
                <span class="size-2 rounded-full bg-success-600 shrink-0" />
                <div class="flex flex-col min-w-0">
                  <span class="font-medium text-text truncate">PostgreSQL</span>
                  <span class="text-[10px] text-text-muted">端口 5432</span>
                </div>
              </div>

              <div class="flex items-center gap-2 p-2.5 rounded bg-bg-page/50 border border-border/50">
                <span class="size-2 rounded-full bg-success-600 shrink-0" />
                <div class="flex flex-col min-w-0">
                  <span class="font-medium text-text truncate">Redis MQ</span>
                  <span class="text-[10px] text-text-muted">端口 6379</span>
                </div>
              </div>

              <div class="flex items-center gap-2 p-2.5 rounded bg-bg-page/50 border border-border/50">
                <span class="size-2 rounded-full bg-success-600 shrink-0" />
                <div class="flex flex-col min-w-0">
                  <span class="font-medium text-text truncate">Judge Worker</span>
                  <span class="text-[10px] text-text-muted">Docker 沙箱</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 右侧 1 栏：快捷操作与最近审计 -->
        <div class="flex flex-col gap-6">
          <!-- 快捷操作 Hub -->
          <div class="p-5 bg-white border border-border rounded-lg shadow-card">
            <h2 class="text-sm font-bold text-text mb-3 flex items-center gap-1.5">
              <UIcon name="i-lucide-zap" class="size-4 text-primary" />
              高频快捷操作
            </h2>
            <div class="grid grid-cols-2 gap-2">
              <NuxtLink
                v-for="act in actionItems"
                :key="act.to"
                :to="act.to"
                class="flex flex-col p-2.5 rounded-md border border-border/70 hover:border-primary/50 hover:bg-primary-bg/40 text-text no-underline transition-colors group"
              >
                <div class="flex items-center gap-1.5 text-xs font-semibold text-text group-hover:text-primary mb-1">
                  <UIcon :name="act.icon" class="size-3.5" />
                  <span>{{ act.label }}</span>
                </div>
                <span class="text-[10px] text-text-muted line-clamp-1">{{ act.desc }}</span>
              </NuxtLink>
            </div>
          </div>

          <!-- 最近系统审计动态 -->
          <div class="p-5 bg-white border border-border rounded-lg shadow-card flex-1">
            <div class="flex items-center justify-between mb-3">
              <h2 class="text-sm font-bold text-text flex items-center gap-1.5">
                <UIcon name="i-lucide-scroll-text" class="size-4 text-text-secondary" />
                近期审计动态
              </h2>
              <NuxtLink to="/admin/audit-logs" class="text-xs text-primary hover:underline">
                完整日志
              </NuxtLink>
            </div>

            <div v-if="recentAuditLogs.length > 0" class="flex flex-col divide-y divide-border/60">
              <div
                v-for="log in recentAuditLogs"
                :key="log.id"
                class="py-2.5 flex items-center justify-between gap-2 text-xs"
              >
                <div class="flex flex-col min-w-0">
                  <span class="font-medium text-text truncate">{{ formatActionLabel(log.action) }}</span>
                  <span class="text-[10px] text-text-muted font-mono">{{ log.admin_id.slice(0, 8) }}</span>
                </div>
                <span class="text-[11px] text-text-muted shrink-0 tabular-nums">
                  {{ formatRelativeTime(log.created_at) }}
                </span>
              </div>
            </div>
            <div v-else class="py-6 text-center text-xs text-text-muted">
              暂无近期审计记录
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
