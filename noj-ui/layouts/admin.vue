<script setup lang="ts">
const route = useRoute()
const sidebarOpen = ref(true)
const isMobile = ref(false)

function onResize() {
  isMobile.value = window.innerWidth < 768
  if (isMobile.value) sidebarOpen.value = false
  else sidebarOpen.value = true
}

onMounted(() => {
  onResize()
  window.addEventListener("resize", onResize)
})
onUnmounted(() => window.removeEventListener("resize", onResize))

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
  { label: "概览", items: [{ label: "仪表盘", to: "/admin", icon: 'i-lucide-layout-dashboard' }] },
  {
    label: "内容与评测",
    items: [
      { label: "题目管理", to: "/admin/problems", icon: 'i-lucide-book-open' },
      { label: "分类管理", to: "/admin/categories", icon: 'i-lucide-tags' },
      { label: "竞赛管理", to: "/admin/contests", icon: 'i-lucide-trophy' },
      { label: "提交管理", to: "/admin/submissions", icon: 'i-lucide-files' },
      { label: "评测镜像", to: "/admin/judge-images", icon: 'i-lucide-container' },
      { label: "社区管理", to: "/admin/community", icon: 'i-lucide-messages-square' },
    ],
  },
  {
    label: "用户与系统",
    items: [
      { label: "用户管理", to: "/admin/users", icon: 'i-lucide-users' },
      { label: "角色管理", to: "/admin/roles", icon: 'i-lucide-shield-check' },
      { label: "黑名单管理", to: "/admin/blacklist", icon: 'i-lucide-ban' },
      { label: "系统设置", to: "/admin/settings", icon: 'i-lucide-settings' },
      { label: "审计日志", to: "/admin/audit-logs", icon: 'i-lucide-scroll-text' },
    ],
  },
]

function isActive(path: string) {
  if (path === "/admin") return route.path === "/admin"
  return route.path.startsWith(path)
}
</script>

<template>
  <div class="flex min-h-screen bg-gray-50">
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
      <div class="flex items-center justify-between px-3 py-3.5 border-b border-border min-h-16">
        <NuxtLink to="/admin" class="flex items-center gap-2 no-underline overflow-hidden">
          <img src="~/assets/img/logo.jpg" alt="NOJ" class="size-7 rounded-md shrink-0" />
          <span v-show="sidebarOpen" class="text-base font-bold text-primary whitespace-nowrap">管理后台</span>
        </NuxtLink>
        <button class="bg-none border-none text-text-secondary cursor-pointer p-1 rounded shrink-0 hover:bg-gray-100 transition-colors" @click="sidebarOpen = !sidebarOpen">
          <UIcon name="i-lucide-panel-left-close" class="size-4.5" v-if="sidebarOpen"/>
          <UIcon name="i-lucide-panel-left" class="size-4.5" v-else/>
        </button>
      </div>

      <nav class="flex-1 p-2 flex flex-col gap-3 overflow-y-auto">
        <section v-for="group in navGroups" :key="group.label" class="flex flex-col gap-0.5">
          <h2 v-show="sidebarOpen" class="px-3 pt-1 text-11px font-semibold text-text-muted">{{ group.label }}</h2>
          <NuxtLink
            v-for="item in group.items"
            :key="item.to"
            :to="item.to"
            class="flex items-center gap-2.5 px-3 py-2.5 text-sm text-text-secondary no-underline rounded-md transition-colors whitespace-nowrap overflow-hidden"
            :class="{ 'bg-primary-bg text-primary font-semibold': isActive(item.to), 'hover:bg-gray-100 hover:text-text': !isActive(item.to) }"
            @click="isMobile && (sidebarOpen = false)"
          >
            <UIcon :name="item.icon" class="size-4.5" />
            <span v-show="sidebarOpen" class="flex-1">{{ item.label }}</span>
          </NuxtLink>
        </section>
      </nav>

      <div class="p-2 border-t border-border">
        <NuxtLink to="/" class="flex items-center gap-2 px-3 py-2.5 text-xs text-text-secondary no-underline rounded-md transition-colors whitespace-nowrap overflow-hidden hover:bg-gray-100 hover:text-text">
          <UIcon name="i-lucide-arrow-left-from-line" class="size-4" />
          <span v-show="sidebarOpen">返回前台</span>
        </NuxtLink>
      </div>
    </aside>

    <!-- 主内容区 -->
    <div class="flex-1 min-h-screen transition-[margin-left] duration-200" :class="sidebarOpen ? 'ml-60 max-md:ml-0' : 'ml-15 max-md:ml-0'">
      <!-- 移动端顶栏 -->
      <header v-if="isMobile" class="flex items-center gap-3 px-4 py-3 bg-white border-b border-border sticky top-0 z-40">
        <button class="bg-none border-none text-text cursor-pointer p-1.5 rounded hover:bg-gray-100" @click="sidebarOpen = !sidebarOpen">
          <UIcon name="i-lucide-panel-left" class="size-5" />
        </button>
        <span class="text-base font-semibold">管理后台</span>
      </header>

      <main id="admin-main" class="p-6 max-w-[1200px]">
        <slot />
      </main>
    </div>
  </div>
</template>

<style scoped>
/* Vue Transition: 遮罩淡入淡出 */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
