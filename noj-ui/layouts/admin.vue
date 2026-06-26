<script setup lang="ts">
import {
  LayoutDashboard,
  Users,
  BookOpen,
  Tags,
  Files,
  ChevronLeft,
  PanelLeftClose,
  PanelLeft,
  ArrowLeftFromLine,
} from "@lucide/vue"

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
  icon: Component
}

const navItems: NavItem[] = [
  { label: "仪表盘", to: "/admin", icon: LayoutDashboard },
  { label: "用户管理", to: "/admin/users", icon: Users },
  { label: "题目管理", to: "/admin/problems", icon: BookOpen },
  { label: "分类管理", to: "/admin/categories", icon: Tags },
  { label: "提交管理", to: "/admin/submissions", icon: Files },
]

function isActive(path: string) {
  if (path === "/admin") return route.path === "/admin"
  return route.path.startsWith(path)
}
</script>

<template>
  <div class="flex min-h-screen bg-gray-50">
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
          <PanelLeftClose v-if="sidebarOpen" :size="18" />
          <PanelLeft v-else :size="18" />
        </button>
      </div>

      <nav class="flex-1 p-2 flex flex-col gap-0.5 overflow-y-auto">
        <NuxtLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="flex items-center gap-2.5 px-3 py-2.5 text-sm text-text-secondary no-underline rounded-md transition-colors whitespace-nowrap overflow-hidden"
          :class="{ 'bg-primary-bg text-primary font-semibold': isActive(item.to), 'hover:bg-gray-100 hover:text-text': !isActive(item.to) }"
          @click="isMobile && (sidebarOpen = false)"
        >
          <component :is="item.icon" :size="18" />
          <span v-show="sidebarOpen" class="flex-1">{{ item.label }}</span>
        </NuxtLink>
      </nav>

      <div class="p-2 border-t border-border">
        <NuxtLink to="/" class="flex items-center gap-2 px-3 py-2.5 text-xs text-text-secondary no-underline rounded-md transition-colors whitespace-nowrap overflow-hidden hover:bg-gray-100 hover:text-text">
          <ArrowLeftFromLine :size="16" />
          <span v-show="sidebarOpen">返回前台</span>
        </NuxtLink>
      </div>
    </aside>

    <!-- 主内容区 -->
    <div class="flex-1 min-h-screen transition-[margin-left] duration-200" :class="sidebarOpen ? 'ml-60 max-md:ml-0' : 'ml-15 max-md:ml-0'">
      <!-- 移动端顶栏 -->
      <header v-if="isMobile" class="flex items-center gap-3 px-4 py-3 bg-white border-b border-border sticky top-0 z-40">
        <button class="bg-none border-none text-text cursor-pointer p-1.5 rounded hover:bg-gray-100" @click="sidebarOpen = !sidebarOpen">
          <PanelLeft :size="20" />
        </button>
        <span class="text-base font-semibold">管理后台</span>
      </header>

      <main class="p-6 max-w-[1200px]">
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
