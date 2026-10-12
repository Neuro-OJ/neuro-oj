<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue"

const route = useRoute()
const sidebarOpen = ref(true)
const isMobile = ref(false)
const commandPaletteOpen = ref(false)

function onResize() {
  isMobile.value = window.innerWidth < 768
  if (isMobile.value) sidebarOpen.value = false
  else sidebarOpen.value = true
}

function handleGlobalKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === "k") {
    e.preventDefault()
    commandPaletteOpen.value = !commandPaletteOpen.value
  }
}

onMounted(() => {
  onResize()
  window.addEventListener("resize", onResize)
  window.addEventListener("keydown", handleGlobalKeydown)
})

onUnmounted(() => {
  window.removeEventListener("resize", onResize)
  window.removeEventListener("keydown", handleGlobalKeydown)
})

interface NavItem {
  label: string
  to: string
  icon: string
}

interface NavGroup {
  label: string
  items: NavItem[]
}

const navGroups: NavGroup[] = [
  {
    label: "概览监控",
    items: [
      { label: "仪表盘", to: "/admin", icon: "i-lucide-layout-dashboard" },
    ],
  },
  {
    label: "题务教务",
    items: [
      { label: "题目管理", to: "/admin/problems", icon: "i-lucide-book-open" },
      { label: "标签管理", to: "/admin/tags", icon: "i-lucide-tags" },
      { label: "竞赛管理", to: "/admin/contests", icon: "i-lucide-trophy" },
      { label: "题单管理", to: "/admin/trainings", icon: "i-lucide-list-todo" },
    ],
  },
  {
    label: "评测与算力",
    items: [
      { label: "提交记录", to: "/admin/submissions", icon: "i-lucide-files" },
      { label: "版本策略", to: "/admin/problem-versions", icon: "i-lucide-git-branch" },
      { label: "批量重测", to: "/admin/submission-jobs", icon: "i-lucide-refresh-cw" },
      { label: "评测镜像", to: "/admin/judge-images", icon: "i-lucide-container" },
      { label: "LLM Provider", to: "/admin/llm/providers", icon: "i-lucide-server" },
      { label: "LLM 用量统计", to: "/admin/llm/usage", icon: "i-lucide-bar-chart-3" },
      { label: "LLM 配额", to: "/admin/llm/quotas", icon: "i-lucide-gauge" },
    ],
  },
  {
    label: "社区与风控",
    items: [
      { label: "社区管理", to: "/admin/community", icon: "i-lucide-messages-square" },
      { label: "内容审查", to: "/admin/content-review", icon: "i-lucide-shield-alert" },
      { label: "举报中心", to: "/admin/reports", icon: "i-lucide-flag" },
      { label: "全站公告", to: "/admin/announcements", icon: "i-lucide-megaphone" },
      { label: "轮播管理", to: "/admin/carousel", icon: "i-lucide-gallery-horizontal" },
    ],
  },
  {
    label: "用户与安全",
    items: [
      { label: "用户管理", to: "/admin/users", icon: "i-lucide-users" },
      { label: "角色权限", to: "/admin/roles", icon: "i-lucide-shield-check" },
      { label: "黑名单管理", to: "/admin/blacklist", icon: "i-lucide-ban" },
      { label: "法律与合规", to: "/admin/legal", icon: "i-lucide-scale" },
    ],
  },
  {
    label: "系统运维",
    items: [
      { label: "系统设置", to: "/admin/settings", icon: "i-lucide-settings" },
      { label: "审计日志", to: "/admin/audit-logs", icon: "i-lucide-scroll-text" },
    ],
  },
]

function isActive(path: string) {
  if (path === "/admin") return route.path === "/admin"
  return route.path.startsWith(path)
}
</script>

<template>
  <div class="flex min-h-screen bg-bg-page bg-tech-grid">
    <a href="#admin-main" class="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[200] focus:bg-white focus:text-text focus:px-4 focus:py-2 focus:rounded-md focus:shadow-modal">
      跳转到主要内容
    </a>

    <!-- 移动端遮罩 -->
    <Transition name="fade">
      <div
        v-if="isMobile && sidebarOpen"
        class="fixed inset-0 bg-black/30 z-[45]"
        @click="sidebarOpen = false"
      />
    </Transition>

    <!-- 侧边栏 -->
    <aside
      class="fixed top-0 left-0 bottom-0 z-50 flex flex-col bg-white border-r border-border transition-[width] duration-200"
      :class="sidebarOpen ? 'w-60' : 'w-0 md:w-15 overflow-hidden md:overflow-visible'"
    >
      <!-- Logo 栏 -->
      <div class="flex items-center justify-between px-3.5 py-3 border-b border-border min-h-14">
        <BrandLogo
          to="/admin"
          brand-name="管理后台"
          :text-class="sidebarOpen ? 'text-sm font-bold whitespace-nowrap' : 'hidden'"
        />
        <button
          type="button"
          class="bg-none border-none text-text-secondary cursor-pointer p-1.5 rounded hover:bg-primary-hover transition-colors shrink-0"
          :aria-label="sidebarOpen ? '收起侧栏' : '展开侧栏'"
          @click="sidebarOpen = !sidebarOpen"
        >
          <UIcon :name="sidebarOpen ? 'i-lucide-panel-left-close' : 'i-lucide-panel-left'" class="size-4.5" />
        </button>
      </div>

      <!-- 导航列表 -->
      <nav class="flex-1 p-2 flex flex-col gap-3 overflow-y-auto">
        <section v-for="group in navGroups" :key="group.label" class="flex flex-col gap-0.5">
          <h2 v-show="sidebarOpen" class="px-3 pt-1 text-[11px] font-semibold text-text-muted tracking-wider">
            {{ group.label }}
          </h2>
          <NuxtLink
            v-for="item in group.items"
            :key="item.to"
            :to="item.to"
            :title="!sidebarOpen ? `${group.label} - ${item.label}` : undefined"
            class="flex items-center gap-2.5 px-3 py-2 text-sm text-text-secondary no-underline rounded-md transition-colors whitespace-nowrap overflow-hidden group"
            :class="{ 'bg-primary-bg text-primary font-semibold shadow-xs': isActive(item.to), 'hover:bg-primary-hover hover:text-text': !isActive(item.to) }"
            @click="isMobile && (sidebarOpen = false)"
          >
            <UIcon :name="item.icon" class="size-4.5 shrink-0 transition-transform group-hover:scale-105" />
            <span v-show="sidebarOpen" class="flex-1 truncate">{{ item.label }}</span>
          </NuxtLink>
        </section>
      </nav>

      <!-- 底部快速出口 -->
      <div class="p-2 border-t border-border bg-bg-page/40">
        <NuxtLink
          to="/"
          class="flex items-center gap-2 px-3 py-2 text-xs text-text-secondary no-underline rounded-md transition-colors whitespace-nowrap overflow-hidden hover:bg-primary-hover hover:text-text"
          :title="!sidebarOpen ? '返回前台' : undefined"
        >
          <UIcon name="i-lucide-arrow-left-from-line" class="size-4 shrink-0" />
          <span v-show="sidebarOpen">返回前台门户</span>
        </NuxtLink>
      </div>
    </aside>

    <!-- 主内容区 -->
    <div
      class="flex-1 min-h-screen flex flex-col transition-[margin-left] duration-200"
      :class="sidebarOpen ? 'ml-60 max-md:ml-0' : 'ml-15 max-md:ml-0'"
    >
      <!-- Admin 统一全局顶栏 -->
      <AdminTopbar
        :sidebar-open="sidebarOpen"
        :is-mobile="isMobile"
        @toggle-sidebar="sidebarOpen = !sidebarOpen"
        @open-command-palette="commandPaletteOpen = true"
      />

      <!-- 主工作区内容 -->
      <main id="admin-main" class="flex-1 p-4 sm:p-6 lg:p-7 w-full max-w-[1600px] mx-auto">
        <slot />
      </main>
    </div>

    <!-- 全局命令搜索面板 -->
    <AdminCommandPalette
      :open="commandPaletteOpen"
      @update:open="(val: boolean) => commandPaletteOpen = val"
    />
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
