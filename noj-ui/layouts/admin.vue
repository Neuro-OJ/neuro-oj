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
  <div class="admin-layout">
    <!-- 移动端遮罩 -->
    <Transition name="fade">
      <div
        v-if="isMobile && sidebarOpen"
        class="sidebar-overlay"
        @click="sidebarOpen = false"
      />
    </Transition>

    <!-- 侧边栏 -->
    <aside class="sidebar" :class="{ collapsed: !sidebarOpen }">
      <div class="sidebar-header">
        <NuxtLink to="/admin" class="sidebar-brand">
          <img src="~/assets/img/logo.jpg" alt="NOJ" class="brand-logo" />
          <span v-show="sidebarOpen" class="brand-text">管理后台</span>
        </NuxtLink>
        <button class="toggle-btn" @click="sidebarOpen = !sidebarOpen">
          <PanelLeftClose v-if="sidebarOpen" :size="18" />
          <PanelLeft v-else :size="18" />
        </button>
      </div>

      <nav class="sidebar-nav">
        <NuxtLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="nav-item"
          :class="{ active: isActive(item.to) }"
          @click="isMobile && (sidebarOpen = false)"
        >
          <component :is="item.icon" :size="18" />
          <span v-show="sidebarOpen" class="nav-label">{{ item.label }}</span>
        </NuxtLink>
      </nav>

      <div class="sidebar-footer">
        <NuxtLink to="/" class="back-link">
          <ArrowLeftFromLine :size="16" />
          <span v-show="sidebarOpen">返回前台</span>
        </NuxtLink>
      </div>
    </aside>

    <!-- 主内容区 -->
    <div class="main-area" :class="{ expanded: !sidebarOpen }">
      <!-- 移动端顶栏 -->
      <header v-if="isMobile" class="mobile-header">
        <button class="hamburger-btn" @click="sidebarOpen = !sidebarOpen">
          <PanelLeft :size="20" />
        </button>
        <span class="mobile-title">管理后台</span>
      </header>

      <main class="content">
        <slot />
      </main>
    </div>
  </div>
</template>

<style scoped>
.admin-layout {
  display: flex;
  min-height: 100vh;
  background: #f8f9fa;
}

/* 侧边栏 */
.sidebar {
  width: 240px;
  background: var(--c-white);
  border-right: 1px solid var(--c-border);
  display: flex;
  flex-direction: column;
  transition: width 0.2s ease;
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  z-index: 50;
}

.sidebar.collapsed {
  width: 60px;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 12px;
  border-bottom: 1px solid var(--c-border);
  min-height: 64px;
}

.sidebar-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  text-decoration: none;
  overflow: hidden;
}

.brand-logo {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  flex-shrink: 0;
}

.brand-text {
  font-size: 16px;
  font-weight: 700;
  color: var(--c-primary);
  white-space: nowrap;
}

.toggle-btn {
  background: none;
  border: none;
  color: var(--c-text-secondary);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  flex-shrink: 0;
  transition: background 0.15s;
}

.toggle-btn:hover {
  background: var(--c-bg-hover, #f5f5f5);
}

.sidebar-nav {
  flex: 1;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  font-size: 14px;
  color: var(--c-text-secondary);
  text-decoration: none;
  border-radius: 6px;
  transition: background 0.15s, color 0.15s;
  white-space: nowrap;
  overflow: hidden;
}

.nav-item:hover {
  background: var(--c-bg-hover, #f5f5f5);
  color: var(--c-text);
}

.nav-item.active {
  background: var(--c-primary-bg, #eff6ff);
  color: var(--c-primary);
  font-weight: 600;
}

.nav-label {
  flex: 1;
}

.sidebar-footer {
  padding: 8px;
  border-top: 1px solid var(--c-border);
}

.back-link {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  font-size: 13px;
  color: var(--c-text-secondary);
  text-decoration: none;
  border-radius: 6px;
  transition: background 0.15s, color 0.15s;
  white-space: nowrap;
  overflow: hidden;
}

.back-link:hover {
  background: var(--c-bg-hover, #f5f5f5);
  color: var(--c-text);
}

/* 主内容区 */
.main-area {
  flex: 1;
  margin-left: 240px;
  transition: margin-left 0.2s ease;
  min-height: 100vh;
}

.main-area.expanded {
  margin-left: 60px;
}

.mobile-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: var(--c-white);
  border-bottom: 1px solid var(--c-border);
  position: sticky;
  top: 0;
  z-index: 40;
}

.hamburger-btn {
  background: none;
  border: none;
  color: var(--c-text);
  cursor: pointer;
  padding: 6px;
  border-radius: 4px;
}

.mobile-title {
  font-size: 16px;
  font-weight: 600;
}

.content {
  padding: 24px;
  max-width: 1200px;
}

/* 遮罩 */
.sidebar-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.3);
  z-index: 45;
}

/* 过渡动画 */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* 响应式 */
@media (max-width: 767px) {
  .sidebar:not(.collapsed) {
    width: 240px;
  }

  .sidebar.collapsed {
    width: 0;
    overflow: hidden;
  }

  .main-area,
  .main-area.expanded {
    margin-left: 0;
  }
}
</style>
