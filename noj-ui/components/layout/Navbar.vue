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
                    <button
                        type="button"
                        class="flex items-center gap-2 px-3 py-2.5 text-sm text-text-secondary no-underline rounded-md transition-colors hover:bg-primary-hover hover:text-text"
                        @click="openSearch; mobileOpen = false"
                    >
                        <UIcon name="i-lucide-search" class="size-4" />
                        搜索
                    </button>
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
            <nav class="hidden md:flex items-center gap-1 ml-6">
                <NuxtLink
                    v-for="item in navItems"
                    :key="item.to"
                    :to="item.to"
                    class="px-3 py-1.5 text-sm text-text-secondary no-underline rounded-md transition-colors hover:bg-primary-hover hover:text-text"
                    active-class="text-primary font-semibold"
                >{{ item.label }}</NuxtLink>
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
                <NuxtLink v-if="user && communityConfig?.enabled" to="/community/notifications" class="relative rounded-md p-2 text-text-secondary no-underline transition-colors hover:bg-primary-hover hover:text-text" aria-label="社区通知">
                    <UIcon name="i-lucide-bell" class="size-4.5" />
                    <span v-if="unreadCount > 0" class="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-red-500 text-[10px] text-white">{{ unreadCount > 9 ? '9+' : unreadCount }}</span>
                </NuxtLink>
                <UserMenu />
            </div>
        </div>
    </header>
</template>

<script setup lang="ts">

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
  { label: '客观题', to: '/objective-papers', icon: 'i-lucide-clipboard-list' },
  { label: '竞赛', to: '/contests', icon: 'i-lucide-trophy' },
  { label: '榜单', to: '/ranking', icon: 'i-lucide-medal' },
  { label: '社区', to: '/community', icon: 'i-lucide-messages-square', needsCommunity: true },
  { label: '提交记录', to: '/submissions', icon: 'i-lucide-file-text' },
  { label: '队列', to: '/queue', icon: 'i-lucide-list-ordered' },
  { label: '关于', to: '/about', icon: 'i-lucide-info' },
]

const navItems = computed(() => baseNavItems.filter((i) => !i.needsCommunity || communityConfig.value?.enabled))

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
})

// 社区通知 SSE：仅登录且社区开启时连接，收到 notification:new 刷新未读数
const notificationSseEnabled = computed(
  () => !!user.value && communityConfig.value?.enabled === true,
);

onMounted(async () => {
  await loadConfig();
  await loadUnreadCount();
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
