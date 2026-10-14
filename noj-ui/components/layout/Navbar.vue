<script setup lang="ts">
import { workspacePath } from '~/utils/workspace';
import { workspaceNavigation } from '~/utils/workspace-navigation';
import { communityPath } from '~/utils/community-workspace';
const { user } = useAuth(), { t, isEnglish, setLocale } = useI18n();
const route = useRoute(), slug = useNavigationDomain(), workspace = useOptionalWorkspace();
const mobileOpen = ref(false), headerRef = ref<HTMLElement | null>(null);
const entries = computed(() => workspace?.domain.value
  ? workspaceNavigation(workspace.domain.value)
  : [
    { label: '首页', section: '', to: workspacePath(slug.value), icon: 'i-lucide-home' },
    { label: '题库', section: 'problems', to: workspacePath(slug.value, 'problems'), icon: 'i-lucide-book-open' },
    { label: '比赛', section: 'contests', to: workspacePath(slug.value, 'contests'), icon: 'i-lucide-trophy' },
    { label: '题单', section: 'trainings', to: workspacePath(slug.value, 'trainings'), icon: 'i-lucide-list-ordered' },
  ]);
const primary = computed(() => entries.value.filter(entry => !['search', 'members', 'settings', 'llm', 'problem-bindings', 'submissions'].includes(entry.section)).slice(0, 6));
const more = computed(() => entries.value.filter(entry => entry.section !== 'search' && !primary.value.includes(entry)));
const communityEnabled = computed(() => !!workspace?.domain.value?.configuration.features.community);
const teachingEnabled = computed(() => !!workspace?.domain.value?.configuration.features.assignment);
const { loadConfig } = useCommunity();
const scope = useCommunityScope();
const { unreadCount, loadUnreadCount } = useCommunityNotifications();
watch([scope.key, communityEnabled], async () => {
  if (!import.meta.client || !communityEnabled.value) return;
  await loadConfig(true);
  if (user.value) await loadUnreadCount();
}, { immediate: true });
useEventSource({
  url: computed(() => scope.capture().apiPath('notifications/events')),
  scopeKey: scope.key,
  enabled: computed(() => !!user.value && communityEnabled.value),
  onEvent: { 'notification:new': () => loadUnreadCount() },
  fetchFn: () => loadUnreadCount(),
  fallbackIntervalMs: 30000,
});
const educationApi = useEducationApi();
const educationNotifications = useAsyncData(
  computed(() => `navbar-education:${slug.value}:${user.value?.id ?? ''}:${teachingEnabled.value}`),
  () => user.value && teachingEnabled.value && (workspace?.domain.value?.is_member || workspace?.domain.value?.platform_admin)
    ? educationApi.notifications(slug.value)
    : Promise.resolve({ data: { unread: 0 } }),
);
useEventSource({
  url: computed(() => `/api/v1/domains/${encodeURIComponent(slug.value)}/notifications/events`),
  scopeKey: computed(() => `${slug.value}:${user.value?.id ?? ''}`),
  enabled: computed(() => !!user.value && teachingEnabled.value && !!(workspace?.domain.value?.is_member || workspace?.domain.value?.platform_admin)),
  onEvent: { 'education:sync': () => educationNotifications.refresh(), 'education:notification': () => educationNotifications.refresh() },
  fetchFn: () => educationNotifications.refresh(),
  fallbackIntervalMs: 15000,
});
watch(() => route.path, () => { mobileOpen.value = false; });
onMounted(() => {
  const element = headerRef.value!;
  const syncHeight = () => document.documentElement.style.setProperty('--header-h', `${element.offsetHeight}px`);
  syncHeight();
  const observer = new ResizeObserver(syncHeight);
  observer.observe(element);
  onUnmounted(() => observer.disconnect());
});
</script>
<template>
  <header ref="headerRef" class="fixed inset-x-0 top-0 z-[100] border-b border-border bg-white/95 backdrop-blur-sm">
    <div v-if="user?.must_change_password" class="border-b border-red-200 bg-red-50 px-4 py-2 text-center text-sm text-red-700">
      请先修改临时密码，再使用完整功能。
    </div>
    <div class="mx-auto flex h-16 max-w-[1440px] items-center gap-3 px-4 sm:px-6">
      <UDrawer v-model:open="mobileOpen" title="导航" direction="left" :handle="false" :close="true">
        <UButton class="lg:hidden" color="neutral" variant="ghost" square icon="i-lucide-menu" aria-label="打开菜单" />
        <template #body>
          <nav class="flex w-64 flex-col gap-1" aria-label="移动端导航">
            <NuxtLink v-for="entry in entries" :key="entry.to" :to="entry.to"
              class="flex items-center gap-3 rounded px-3 py-2.5 text-sm text-text-secondary hover:bg-primary-bg"
              active-class="bg-primary-bg font-semibold text-primary" :exact-active-class="entry.section === '' ? 'bg-primary-bg text-primary' : ''"
              @click="mobileOpen = false">
              <UIcon :name="entry.icon" class="size-4" />{{ entry.label }}
            </NuxtLink>
          </nav>
        </template>
      </UDrawer>
      <BrandLogo :to="workspacePath(slug)" text-class="hidden sm:inline" />
      <nav class="ml-3 hidden min-w-0 flex-1 items-center gap-1 lg:flex" aria-label="空间导航">
        <NuxtLink v-for="entry in primary" :key="entry.to" :to="entry.to"
          class="whitespace-nowrap rounded px-3 py-2 text-sm text-text-secondary hover:bg-primary-bg"
          :active-class="entry.section === '' ? '' : 'bg-primary-bg font-semibold text-primary'"
          exact-active-class="bg-primary-bg font-semibold text-primary">{{ entry.label }}</NuxtLink>
        <UDropdownMenu v-if="more.length" :items="more.map(entry => ({ label: entry.label, icon: entry.icon, to: entry.to }))">
          <UButton color="neutral" variant="ghost" trailing-icon="i-lucide-chevron-down">更多</UButton>
        </UDropdownMenu>
      </nav>
      <div class="ml-auto flex min-w-0 items-center gap-1 sm:gap-2">
        <UButton :to="workspacePath(slug, 'search')" color="neutral" variant="ghost" icon="i-lucide-search" aria-label="搜索当前域" />
        <UButton v-if="user && communityEnabled" :to="communityPath(slug, 'notifications')" color="neutral"
          variant="ghost" icon="i-lucide-bell" aria-label="社区通知">
          <span v-if="unreadCount" class="text-xs tabular-nums">{{ unreadCount > 99 ? '99+' : unreadCount }}</span>
        </UButton>
        <UButton v-if="user && teachingEnabled" :to="workspacePath(slug, 'notifications')" color="neutral"
          variant="ghost" icon="i-lucide-bell-ring" aria-label="教学通知">
          <span v-if="educationNotifications.data.value?.data.unread" class="text-xs tabular-nums">{{ educationNotifications.data.value.data.unread > 99 ? '99+' : educationNotifications.data.value.data.unread }}</span>
        </UButton>
        <UButton color="neutral" variant="ghost" size="sm" :aria-label="t('common.language')"
          @click="setLocale(isEnglish ? 'zh-CN' : 'en-US')">{{ isEnglish ? '中文' : 'EN' }}</UButton>
        <UserMenu />
      </div>
    </div>
    <AnnouncementBanner />
  </header>
</template>
