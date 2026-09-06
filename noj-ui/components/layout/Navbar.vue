<template>
    <header ref="headerRef" class="fixed top-0 left-0 right-0 z-[100] bg-white border-b border-border">
        <!-- 临时密码提示横幅 -->
        <div v-if="user?.must_change_password === true" class="w-full bg-red-50 border-b border-red-200 px-6 py-2 text-center">
            <p class="text-sm text-red-700">检测到当前密码为临时密码，首次登录后必须修改密码才能使用完整功能。</p>
        </div>
        <div class="w-full max-w-none mx-0 px-6 h-16 flex items-center gap-1">
            <!-- 移动端菜单抽屉：默认插槽=汉堡触发按钮（<md 显示），#body=面板导航 -->
            <UDrawer
                v-model:open="mobileOpen"
                title="菜单"
                side="left"
                :handle="false"
                :close="true"
                :ui="{ body: 'p-3 flex flex-col gap-1' }"
            >
                <UButton class="md:hidden" color="neutral" variant="ghost" square icon="i-lucide-menu" aria-label="打开菜单" />
                <template #body>
                    <NuxtLink
                        v-for="item in navItems"
                        :key="item.to"
                        :to="item.to"
                        class="flex items-center gap-2 px-3 py-2.5 text-sm text-text-secondary no-underline rounded-md transition-colors hover:bg-primary-hover hover:text-text"
                        @click="mobileOpen = false"
                    >
                        <UIcon :name="item.icon" class="size-4" />
                        {{ item.label }}
                    </NuxtLink>
                </template>
            </UDrawer>
            <BrandLogo text-class="hidden sm:inline" />
            <!-- 桌面端导航（≥md 显示） -->
            <nav ref="navRef" class="hidden md:flex flex-1 items-center gap-1 ml-6 min-w-0">
              <NuxtLink
                v-for="item in visibleNavItems"
                :key="item.to"
                :to="item.to"
                class="whitespace-nowrap px-3 py-1.5 text-sm text-text-secondary no-underline rounded-md transition-colors hover:bg-primary-hover hover:text-text"
                active-class="text-primary font-semibold"
              >{{ item.label }}</NuxtLink>
              <UDropdownMenu
                v-if="overflowNavItems.length > 0"
                :items="overflowMenuItems"
                :content="{ side: 'bottom', sideOffset: 8, collisionPadding: 8 }"
              >
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  class="whitespace-nowrap"
                >
                  <UIcon name="i-lucide-more-horizontal" class="size-4" />
                  更多
                </UButton>
              </UDropdownMenu>
            </nav>
            <button
                type="button"
                class="flex items-center gap-2 px-3 py-1.5 text-sm text-text-secondary hover:bg-primary-hover rounded-md transition-colors"
                aria-label="搜索"
                @click="openSearch"
            >
                <UIcon name="i-lucide-search" class="w-4 h-4 size-4" />
                <span class="hidden sm:inline">搜索</span>
                <kbd class="hidden md:inline-block px-1.5 py-0.5 text-xs bg-gray-100 border border-border rounded">Ctrl K</kbd>
            </button>
            <div class="flex items-center gap-3 ml-auto">
                <NuxtLink v-if="user && communityConfig?.enabled" to="/community/notifications" class="relative flex items-center justify-center rounded-md p-2 text-text-secondary no-underline transition-colors hover:bg-primary-hover hover:text-text" aria-label="社区通知">
                    <UIcon name="i-lucide-bell" class="size-4.5" />
                    <span v-if="unreadCount > 0" class="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-red-500 text-[10px] text-white">{{ unreadCount > 9 ? '9+' : unreadCount }}</span>
                </NuxtLink>
                <UserMenu />
            </div>
        </div>
    </header>
</template>

<script setup lang="ts">
import { shouldLoadCommunityUnreadCount } from '~/utils/communityNotifications';

const { user } = useAuth();
const { open: openSearch } = useSearch();
const { config: communityConfig, loadConfig } = useCommunity();
const { unreadCount, loadUnreadCount } = useCommunityNotifications();

// 移动端抽屉显隐
const mobileOpen = ref(false)

// 导航项单一数据源（桌面导航 + 移动端抽屉共用）
interface NavItem {
  label: string
  to: string
  icon: string
  needsCommunity?: boolean
}

const baseNavItems: NavItem[] = [
  { label: '首页', to: '/', icon: 'i-lucide-home' },
  { label: '题库', to: '/problems', icon: 'i-lucide-book-open' },
  { label: '竞赛', to: '/contests', icon: 'i-lucide-trophy' },
  { label: '榜单', to: '/ranking', icon: 'i-lucide-medal' },
  { label: '题单', to: '/trainings', icon: 'i-lucide-list-todo' },
  { label: '社区', to: '/community', icon: 'i-lucide-messages-square', needsCommunity: true },
  { label: '提交记录', to: '/submissions', icon: 'i-lucide-file-text' },
  { label: '队列', to: '/queue', icon: 'i-lucide-list-ordered' },
  { label: '关于', to: '/about', icon: 'i-lucide-info' },
]

const navItems = computed(() => baseNavItems.filter((i) => !i.needsCommunity || communityConfig.value?.enabled))

// ── 桌面导航响应式折叠：ResizeObserver 动态计算可见项，放不下的进“更多” ──
const navRef = ref<HTMLElement | null>(null)
const itemWidths = ref<number[]>([])
const visibleCount = ref(0)
let navResizeObserver: ResizeObserver | null = null

const visibleNavItems = computed(() => navItems.value.slice(0, visibleCount.value))
const overflowNavItems = computed(() => navItems.value.slice(visibleCount.value))
const overflowMenuItems = computed(() =>
  overflowNavItems.value.map((item) => ({ label: item.label, icon: item.icon, to: item.to })),
)

function measureAndFit() {
  const nav = navRef.value
  if (!nav || typeof window === 'undefined') return
  const links = Array.from(nav.querySelectorAll<HTMLElement>(':scope > a'))
  // 只在全部导航项都处于 DOM 中时重测宽度；一旦有项被收进“更多”，
  // 隐藏项已从 DOM 移除，不能再用当前可见链接数覆盖完整宽度数组，
  // 否则窗口重新拉大后“更多”中的项永远无法展开（issue #319）。
  if (
    visibleCount.value === navItems.value.length &&
    links.length === navItems.value.length
  ) {
    itemWidths.value = links.map((a) => a.getBoundingClientRect().width + 4) // gap-1 = 4px
  }
  const containerWidth = nav.clientWidth
  const moreWidth = 72 // “更多”按钮的近似宽度
  const widths = itemWidths.value
  let best = 0
  let sum = 0
  for (let i = 0; i < widths.length; i++) {
    sum += widths[i] ?? 0
    if (i === widths.length - 1) {
      if (sum <= containerWidth) best = i + 1
    } else if (sum + moreWidth <= containerWidth) {
      best = i + 1
    }
  }
  visibleCount.value = Math.max(1, Math.min(best, navItems.value.length))
}

// 导航项变化（如社区开关加载完成）后重新测量
watch(navItems, () => {
  itemWidths.value = []
  visibleCount.value = navItems.value.length
  if (typeof requestAnimationFrame !== 'undefined') {
    requestAnimationFrame(() => measureAndFit())
  }
}, { immediate: true })

// 将实际 header 高度同步为 CSS 变量 --header-h（default 布局的 pt 间距依赖它）
const headerRef = ref<HTMLElement | null>(null)
function syncHeaderHeight() {
  if (headerRef.value) {
    document.documentElement.style.setProperty('--header-h', `${headerRef.value.offsetHeight}px`)
  }
}

onMounted(() => {
  syncHeaderHeight()
  if (headerRef.value) {
    const ro = new ResizeObserver(syncHeaderHeight)
    ro.observe(headerRef.value)
    onUnmounted(() => ro.disconnect())
  }
  // 桌面导航首次计算和后续自适应
  measureAndFit()
  if (navRef.value && typeof ResizeObserver !== 'undefined') {
    navResizeObserver = new ResizeObserver(() => measureAndFit())
    navResizeObserver.observe(navRef.value)
    onUnmounted(() => navResizeObserver?.disconnect())
  }
})

// 社区通知 SSE：仅登录且社区开启时连接，收到 notification:new 刷新未读数
const notificationSseEnabled = computed(
  () => !!user.value && communityConfig.value?.enabled === true,
);

onMounted(async () => {
  await loadConfig();
  // 未读数接口需要登录且社区开启；游客/未开启时跳过，避免公共页面触发 401 跳转
  if (shouldLoadCommunityUnreadCount(user.value, communityConfig.value?.enabled)) {
    await loadUnreadCount();
  }
});

useEventSource({
  url: "/api/v1/community/notifications/events",
  enabled: notificationSseEnabled,
  onEvent: {
    "notification:new": () => loadUnreadCount(),
  },
  fetchFn: () => loadUnreadCount(),
  fallbackIntervalMs: 30000,
});
</script>
