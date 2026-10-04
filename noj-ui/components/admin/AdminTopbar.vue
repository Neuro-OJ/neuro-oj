<script setup lang="ts">
import { computed } from "vue"
import { commitDisplay, formatBuiltAt, normalizeVersion } from "~/utils/buildInfo"

const props = defineProps<{
  sidebarOpen: boolean
  isMobile: boolean
}>()

const emit = defineEmits<{
  "toggle-sidebar": []
  "open-command-palette": []
}>()

const route = useRoute()
const { user } = useAuth()
const runtimeConfig = useRuntimeConfig()

const buildInfo = computed(() => (runtimeConfig.public.buildInfo as any) ?? {})
const isDev = import.meta.dev

const envBadge = computed(() => {
  if (isDev) {
    return {
      label: "本地开发",
      dotClass: "bg-primary animate-pulse",
      chipClass: "bg-primary-bg text-primary border-primary/20",
      title: `本地开发环境（构建时间：${formatBuiltAt(buildInfo.value.builtAt)}）`,
    }
  }
  const version = normalizeVersion(buildInfo.value.version)
  const commit = commitDisplay(buildInfo.value.commit)
  const displayLabel = version !== "unknown" ? `生产环境 · ${version}` : "生产环境"
  return {
    label: displayLabel,
    dotClass: "bg-emerald-500",
    chipClass: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800",
    title: `生产环境 · ${version} (${commit}) · 构建于 ${formatBuiltAt(buildInfo.value.builtAt)}`,
  }
})

interface RouteMetaMap {
  group: string
  label: string
}

const ROUTE_MAP: Record<string, RouteMetaMap> = {
  "/admin": { group: "概览监控", label: "仪表盘" },
  "/admin/problems": { group: "题务教务", label: "题目管理" },
  "/admin/problem-new": { group: "题务教务", label: "创建题目" },
  "/admin/tags": { group: "题务教务", label: "标签管理" },
  "/admin/contests": { group: "题务教务", label: "竞赛管理" },
  "/admin/trainings": { group: "题务教务", label: "题单管理" },
  "/admin/submissions": { group: "评测与算力", label: "提交记录" },
  "/admin/judge-images": { group: "评测与算力", label: "评测镜像" },
  "/admin/llm/providers": { group: "评测与算力", label: "LLM Provider" },
  "/admin/llm/usage": { group: "评测与算力", label: "LLM 用量统计" },
  "/admin/llm/quotas": { group: "评测与算力", label: "LLM 配额" },
  "/admin/community": { group: "社区与风控", label: "社区管理" },
  "/admin/content-review": { group: "社区与风控", label: "内容审查" },
  "/admin/reports": { group: "社区与风控", label: "举报中心" },
  "/admin/announcements": { group: "社区与风控", label: "全站公告" },
  "/admin/carousel": { group: "社区与风控", label: "轮播管理" },
  "/admin/users": { group: "用户与安全", label: "用户管理" },
  "/admin/roles": { group: "用户与安全", label: "角色权限" },
  "/admin/blacklist": { group: "用户与安全", label: "黑名单管理" },
  "/admin/legal": { group: "用户与安全", label: "法律与合规" },
  "/admin/settings": { group: "系统运维", label: "系统设置" },
  "/admin/audit-logs": { group: "系统运维", label: "审计日志" },
}

const currentBreadcrumb = computed(() => {
  const path = route.path
  if (ROUTE_MAP[path]) return ROUTE_MAP[path]
  for (const [prefix, meta] of Object.entries(ROUTE_MAP)) {
    if (prefix !== "/admin" && path.startsWith(prefix)) {
      return meta
    }
  }
  return { group: "管理后台", label: "控制台" }
})
</script>

<template>
  <header class="sticky top-0 z-40 flex items-center justify-between h-14 px-4 sm:px-6 bg-white/95 backdrop-blur border-b border-border transition-colors">
    <!-- 左侧：侧栏切换与面包屑 -->
    <div class="flex items-center gap-3 min-w-0">
      <button
        type="button"
        class="inline-flex items-center justify-center size-8 text-text-secondary hover:text-text hover:bg-bg-page rounded-md transition-colors border border-transparent hover:border-border cursor-pointer shrink-0"
        :aria-label="sidebarOpen ? '收起侧边栏' : '展开侧边栏'"
        @click="emit('toggle-sidebar')"
      >
        <UIcon :name="sidebarOpen ? 'i-lucide-panel-left-close' : 'i-lucide-panel-left'" class="size-4.5" />
      </button>

      <nav aria-label="Breadcrumb" class="hidden sm:flex items-center gap-1.5 text-xs text-text-muted truncate">
        <NuxtLink to="/admin" class="hover:text-primary transition-colors no-underline text-text-muted">
          管理后台
        </NuxtLink>
        <span class="text-text-muted/50">/</span>
        <span class="text-text-secondary">{{ currentBreadcrumb.group }}</span>
        <span class="text-text-muted/50">/</span>
        <span class="text-text font-semibold truncate">{{ currentBreadcrumb.label }}</span>
      </nav>
      <span v-if="isMobile" class="text-sm font-semibold text-text sm:hidden truncate">
        {{ currentBreadcrumb.label }}
      </span>
    </div>

    <!-- 中间：命令面板搜索快捷键 -->
    <div class="flex-1 max-w-md mx-4 hidden md:flex items-center justify-center">
      <button
        type="button"
        class="w-full flex items-center justify-between gap-3 px-3 py-1.5 text-xs text-text-secondary bg-bg-page hover:bg-primary-hover/50 hover:text-text rounded-md transition-colors border border-border cursor-pointer"
        @click="emit('open-command-palette')"
      >
        <div class="flex items-center gap-2 text-text-muted">
          <UIcon name="i-lucide-search" class="size-3.5" />
          <span>快速直达管理功能...</span>
        </div>
        <kbd class="inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono text-text-muted bg-white border border-border rounded shadow-[0_1px_0_rgba(0,0,0,0.06)] tabular-nums">
          Ctrl K
        </kbd>
      </button>
    </div>

    <!-- 右侧：环境、健康、身份与快速出口 -->
    <div class="flex items-center gap-3 shrink-0">
      <!-- 移动端搜索按钮 -->
      <button
        type="button"
        class="md:hidden inline-flex items-center justify-center size-8 text-text-secondary hover:text-text hover:bg-bg-page rounded-md transition-colors"
        aria-label="快速搜索"
        @click="emit('open-command-palette')"
      >
        <UIcon name="i-lucide-search" class="size-4" />
      </button>

      <!-- 环境指示芯片 -->
      <span
        class="hidden lg:inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium border"
        :class="envBadge.chipClass"
        :title="envBadge.title"
      >
        <span class="size-1.5 rounded-full" :class="envBadge.dotClass" />
        {{ envBadge.label }}
      </span>

      <!-- 快速返回前台 -->
      <NuxtLink
        to="/"
        class="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs text-text-secondary hover:text-primary hover:bg-primary-hover rounded-md transition-colors no-underline border border-transparent hover:border-border"
        title="返回用户前台"
      >
        <UIcon name="i-lucide-external-link" class="size-3.5" />
        <span class="hidden sm:inline">前台门户</span>
      </NuxtLink>

      <div class="h-4 w-px bg-border hidden sm:block" />

      <!-- 管理员身份 Pill -->
      <div v-if="user" class="flex items-center gap-2 pl-1">
        <div class="size-7 rounded-md bg-primary-bg text-primary border border-primary/30 flex items-center justify-center font-bold text-xs shrink-0 select-none">
          {{ user.username.slice(0, 2).toUpperCase() }}
        </div>
        <div class="hidden xl:flex flex-col text-left">
          <span class="text-xs font-semibold text-text leading-none">{{ user.username }}</span>
          <span class="text-[10px] text-primary leading-tight mt-0.5">Admin</span>
        </div>
      </div>
    </div>
  </header>
</template>
