<script setup lang="ts">
import { workspaceCacheKey, workspacePath, type WorkspaceSummary } from '~/utils/domain/workspace/workspace';
import { workspaceNavigation } from '~/utils/domain/workspace/workspace-navigation';
const { user, isLoggedIn } = useAuth();
const route = useRoute(), slug = useNavigationDomain(), workspace = useOptionalWorkspace();
const workspaces = useWorkspaceApi();
const commandPalette = useDomainCommandPalette();
const mobileOpen = ref(false), headerRef = ref<HTMLElement | null>(null);
const navRef = ref<HTMLElement | null>(null), measureRef = ref<HTMLElement | null>(null), navWidth = ref(Infinity);
const knowledge = useKnowledge();

// 与 UserMenu 共用同一份已加入域列表缓存
const { data: spacesData } = useAsyncData(
  () => workspaceCacheKey('', user.value?.id ?? null, 'user-menu-domains'),
  () => user.value ? workspaces.list(true) : Promise.resolve({ data: [] as WorkspaceSummary[] }),
);

const currentDomainLabel = computed(() => workspace?.domain.value?.name || slug.value);
const domainSwitcherItems = computed(() => [
  [
    ...(spacesData.value?.data ?? []).map((space) => ({
      label: `${space.name} · @${space.slug}`,
      icon: space.slug === slug.value ? 'i-lucide-check' : 'i-lucide-building-2',
      onSelect: async () => {
        await workspaces.remember(space.slug);
        await navigateTo(workspacePath(space.slug));
      },
    })),
  ],
  [{ label: '浏览与管理域', icon: 'i-lucide-grid-2x2', to: '/workspaces' }],
]);

// 知识图谱总开关：不在导航里主动探测（避免每页水合多一次请求），只沿用已知的
// 关闭状态（任一知识图谱接口返回 KNOWLEDGE_DISABLED 后隐藏入口）。
const knowledgeEnabled = computed(() => !knowledge.disabled.value);
const entries = computed(() =>
  workspace?.domain.value
    ? workspaceNavigation(workspace.domain.value, { knowledgeEnabled: knowledgeEnabled.value })
    : [
      { label: '首页', section: '', to: workspacePath(slug.value), icon: 'i-lucide-home' },
      { label: '题库', section: 'problems', to: workspacePath(slug.value, 'problems'), icon: 'i-lucide-book-open' },
      { label: '比赛', section: 'contests', to: workspacePath(slug.value, 'contests'), icon: 'i-lucide-trophy' },
      {
        label: '题单',
        section: 'trainings',
        to: workspacePath(slug.value, 'trainings'),
        icon: 'i-lucide-list-ordered',
      },
    ]
);
// 「提交」释放回主导航候选池（按宽度溢出时自动进「更多」），低频设置/资源页仍收拢
const candidates = computed(() =>
  entries.value.filter((entry) =>
    !['search', 'members', 'settings', 'llm', 'problem-bindings', 'queue'].includes(entry.section)
  )
);
const visibleCount = ref(Infinity);
const primary = computed(() => candidates.value.slice(0, visibleCount.value));
const more = computed(() =>
  entries.value.filter((entry) => entry.section !== 'search' && !primary.value.includes(entry))
);
const { unreadCount, refresh: refreshNotifications } = useAccountNotifications();
watch(() => user.value?.id, () => {
  void refreshNotifications();
}, { immediate: true });
usePolling({
  active: computed(() => !!user.value),
  fetcher: refreshNotifications,
  intervalMs: 30000,
  immediate: false,
});
watch(() => route.path, () => {
  mobileOpen.value = false;
});
onMounted(() => {
  const element = headerRef.value!;
  const syncHeight = () => document.documentElement.style.setProperty('--header-h', `${element.offsetHeight}px`);
  syncHeight();
  const observer = new ResizeObserver(syncHeight);
  observer.observe(element);
  const fitNavigation = () => {
    if (!navRef.value || !measureRef.value) return;
    navWidth.value = navRef.value.clientWidth;
    const widths = Array.from(measureRef.value.children).map((item) => item.getBoundingClientRect().width + 4);
    const hasOther = entries.value.some((entry) => entry.section !== 'search' && !candidates.value.includes(entry));
    const total = widths.reduce((sum, width) => sum + width, 0);
    let available = navWidth.value - (hasOther || total > navWidth.value ? 80 : 0), count = 0;
    for (const width of widths) {
      if (width > available) break;
      available -= width;
      count++;
    }
    visibleCount.value = count;
  };
  const navigationObserver = new ResizeObserver(fitNavigation);
  if (navRef.value) navigationObserver.observe(navRef.value);
  watch(candidates, () => {
    void nextTick(fitNavigation);
  }, { immediate: true });
  onUnmounted(() => {
    observer.disconnect();
    navigationObserver.disconnect();
  });
});

const { theme: siteTheme, toggle: toggleSiteTheme } = useSiteTheme();
</script>
<template>
  <header ref="headerRef"
    class="fixed inset-x-0 top-0 z-[100] border-b border-border bg-bg-panel/80 text-text backdrop-blur-md supports-[backdrop-filter]:bg-bg-panel/70">
    <div v-if="user?.must_change_password"
      class="border-b border-error-text/25 bg-verdict-wrong-bg px-4 py-2 text-center text-sm text-error-text">
      请先修改临时密码，再使用完整功能。
    </div>
    <div class="flex h-12 items-center gap-2 px-3 sm:px-4">
      <UDrawer v-model:open="mobileOpen" title="导航" direction="left" :handle="false" :close="true">
        <UButton class="lg:hidden text-text-secondary hover:bg-bg-sunken" color="neutral" variant="ghost" square
          icon="i-lucide-menu" aria-label="打开菜单" />
        <template #body>
          <nav class="flex w-64 flex-col gap-1" aria-label="移动端导航">
            <NuxtLink v-for="entry in entries" :key="entry.to" :to="entry.to"
              class="flex items-center gap-3 rounded-sm px-3 py-2.5 text-sm text-text-secondary hover:bg-primary-bg"
              active-class="bg-primary-bg font-semibold text-primary"
              :exact-active-class="entry.section === '' ? 'bg-primary-bg text-primary' : ''"
              @click="mobileOpen = false">
              <UIcon :name="entry.icon" class="size-4" />{{ entry.label }}
            </NuxtLink>
          </nav>
        </template>
      </UDrawer>
      <BrandLogo :to="workspacePath(slug)" :size="5" class="!text-[15px] !font-semibold !text-text"
        text-class="hidden" />
      <!-- 域上下文指示 / 快捷切换器 -->
      <span class="hidden text-border-strong select-none sm:inline" aria-hidden="true">/</span>
      <UDropdownMenu v-if="isLoggedIn" :items="domainSwitcherItems" :content="{ align: 'start' }"
        :ui="{ content: 'w-64' }">
        <button
          type="button"
          class="inline-flex max-w-36 sm:max-w-48 items-center gap-1 rounded-md px-1.5 py-0.5 text-[13px] font-medium text-text transition-colors hover:bg-bg-sunken"
          aria-label="切换当前域"
          :title="`当前域：${currentDomainLabel} (@${slug})`"
        >
          <span class="truncate">{{ currentDomainLabel }}</span>
          <UIcon name="i-lucide-chevrons-up-down" class="size-3 shrink-0 text-text-muted" />
        </button>
      </UDropdownMenu>
      <NuxtLink
        v-else
        :to="workspacePath(slug)"
        class="inline-flex max-w-36 sm:max-w-48 items-center gap-1 rounded-md px-1.5 py-0.5 text-[13px] font-medium text-text no-underline transition-colors hover:bg-bg-sunken"
        :title="`当前域：${currentDomainLabel} (@${slug})`"
      >
        <span class="truncate">{{ currentDomainLabel }}</span>
      </NuxtLink>
      <nav ref="navRef" class="relative ml-3 hidden h-full min-w-0 flex-1 items-stretch gap-0 lg:flex"
        aria-label="空间导航">
        <div ref="measureRef" class="pointer-events-none invisible absolute flex w-max" aria-hidden="true">
          <span v-for="entry in candidates" :key="entry.to"
            class="whitespace-nowrap px-2.5 text-[13px]">{{ entry.label }}</span>
        </div>
        <NuxtLink v-for="entry in primary" :key="entry.to" :to="entry.to"
          class="my-auto flex items-center whitespace-nowrap rounded-md px-2.5 py-1 text-[13px] text-text-secondary no-underline transition-colors hover:bg-bg-sunken hover:text-text"
          :active-class="entry.section === '' ? '' : '!bg-bg-sunken !text-text font-medium'"
          exact-active-class="!bg-bg-sunken !text-text font-medium">{{ entry.label }}</NuxtLink>
        <UDropdownMenu v-if="more.length"
          :items="more.map(entry => ({ label: entry.label, icon: entry.icon, to: entry.to }))">
          <UButton class="self-center text-[13px] text-text-secondary hover:bg-bg-sunken hover:text-text"
            color="neutral"
            variant="ghost" size="xs" trailing-icon="i-lucide-chevron-down">更多</UButton>
        </UDropdownMenu>
      </nav>
      <div class="ml-auto flex min-w-0 items-center gap-1 sm:gap-2">
        <button
          type="button"
          class="hidden sm:inline-flex w-56 items-center gap-2 rounded-md border border-border bg-bg-panel px-2 py-1 text-xs text-text-muted shadow-[0_1px_1px_rgba(0,0,0,0.03)] transition-colors hover:border-border-strong hover:text-text-secondary"
          aria-label="打开域内命令面板 (快捷键 Ctrl+K)"
          @click="commandPalette.open()"
        >
          <UIcon name="i-lucide-search" class="size-3.5" />
          <span class="text-xs">搜索或跳转...</span>
          <kbd
            class="ml-auto inline-flex items-center gap-0.5 rounded-[4px] border border-border bg-bg-sunken px-1 font-mono text-[10px] text-text-muted">
            <span>⌘</span>K
          </kbd>
        </button>
        <UButton class="sm:hidden text-text-secondary hover:bg-bg-sunken" color="neutral" variant="ghost"
          icon="i-lucide-search" aria-label="打开命令搜索" @click="commandPalette.open()" />
        <UButton v-if="user" to="/notifications" color="neutral" variant="ghost" icon="i-lucide-bell" aria-label="通知"
          class="relative text-text-secondary hover:bg-bg-sunken hover:text-text">
          <span v-if="unreadCount"
            class="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-error-text px-1 font-mono text-[9px] font-semibold text-white">{{ unreadCount > 99 ? '99+' : unreadCount }}</span>
        </UButton>
        <UButton color="neutral" variant="ghost" class="text-text-secondary hover:bg-bg-sunken hover:text-text"
          :icon="siteTheme === 'dark' ? 'i-lucide-sun' : 'i-lucide-moon'"
          :aria-label="siteTheme === 'dark' ? '切换到浅色主题' : '切换到深色主题'" @click="toggleSiteTheme()" />
        <UserMenu />
      </div>
    </div>
    <AnnouncementBanner />
  </header>
</template>
