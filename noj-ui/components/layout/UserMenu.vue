<script setup lang="ts">
import { workspaceSettingsNavigation } from '~/utils/workspace-settings';
import type { WorkspaceDetail } from '~/utils/workspace';
import { domainIdentityLabel } from '~/utils/domain-navigation';
import { userUrl } from '~/utils/publicIdentifiers';
import { workspaceCacheKey, workspacePath } from '~/utils/workspace';
import type { WorkspaceSummary } from '~/utils/workspace';
const route = useRoute(), slug = useNavigationDomain();
const { user, isLoggedIn, logout } = useAuth();
const workspaces = useWorkspaceApi(), { api } = useApi(), { dialog } = useDialog();
const workspace = useOptionalWorkspace();
const label = computed(() => domainIdentityLabel(user.value?.username ?? '', slug.value));
const spaces = useAsyncData(
  () => workspaceCacheKey('', user.value?.id ?? null, 'user-menu-domains'),
  () => user.value ? workspaces.list(true) : Promise.resolve({ data: [] as WorkspaceSummary[] }),
);
const menuDomain = useAsyncData(
  () => workspaceCacheKey(slug.value, user.value?.id ?? null, 'menu-permissions'),
  async () => {
    if (!user.value || workspace) return null;
    try {
      return (await api.get<{ data: WorkspaceDetail }>(`/api/v1/domains/${slug.value}`, {
        silent: true,
        redirectOnUnauthorized: false,
      })).data;
    } catch {
      return null;
    }
  },
);
const domainSettingsEntry = computed(() => {
  const domain = workspace?.domain.value ?? menuDomain.data.value;
  return domain ? workspaceSettingsNavigation(domain)[0] : undefined;
});
const unreadCount = ref(0);
async function refreshMessages() {
  const response = await api.get<{ data: { unread_count: number } }>('/api/v1/conversations/unread-count', {
    silent: true,
  });
  unreadCount.value = response.data.unread_count;
}
usePolling({ intervalMs: 30000, active: isLoggedIn, fetcher: refreshMessages });
watch(isLoggedIn, (loggedIn) => {
  if (!loggedIn) unreadCount.value = 0;
});
async function selectDomain(space: WorkspaceSummary) {
  await workspaces.remember(space.slug);
  await navigateTo(workspacePath(space.slug));
}
async function handleLogout() {
  if (!await dialog.confirm('确定要登出当前账号吗？', { title: '确认登出', confirmText: '确认登出' })) return;
  await logout();
  await navigateTo(workspacePath(slug.value));
}
const accountLink = (path: string) => ({ path, query: { domain: slug.value } });
const items = computed(() => [
  [{ label: label.value, type: 'label' as const }],
  [
    { label: '用户主页', icon: 'i-lucide-user-round', to: accountLink(userUrl(user.value?.username ?? '')) },
    { label: '提交', icon: 'i-lucide-file-code-2', to: workspacePath(slug.value, 'submissions') },
    ...(user.value?.is_admin || workspace?.can('problem:write_own') || workspace?.can('problem:write_any')
      ? [{ label: '我的题目', icon: 'i-lucide-book-open', to: workspacePath(slug.value, 'problem-drafts') }]
      : []),
    { label: '消息', icon: 'i-lucide-mail', to: accountLink('/messages'), badge: unreadCount.value || undefined },
  ],
  [
    {
      label: '切换域',
      icon: 'i-lucide-building-2',
      children: [
        ...(spaces.data.value?.data ?? []).map((space) => ({
          label: `${space.name} · ${space.slug}`,
          icon: space.slug === slug.value ? 'i-lucide-check' : 'i-lucide-building-2',
          onSelect: () => selectDomain(space),
        })),
        { label: '浏览与管理域', icon: 'i-lucide-grid-2x2', to: '/workspaces' },
      ],
    },
    ...(domainSettingsEntry.value
      ? [{ label: '域设置', icon: 'i-lucide-building-2', to: domainSettingsEntry.value.to }]
      : []),
    { label: '账号设置', icon: 'i-lucide-settings', to: accountLink('/settings') },
    ...(user.value?.is_admin ? [{ label: '实例管理', icon: 'i-lucide-shield-check', to: '/admin' }] : []),
  ],
  [{ label: '登出', icon: 'i-lucide-log-out', color: 'error' as const, onSelect: handleLogout }],
]);
</script>
<template>
  <template v-if="!isLoggedIn">
    <UButton variant="outline" :to="{ path: '/login', query: { redirect: route.fullPath } }">登录</UButton>
    <UButton :to="{ path: '/register', query: { redirect: route.fullPath } }">注册</UButton>
  </template>
  <UDropdownMenu v-else :items="items" :content="{ align: 'end' }" :ui="{ content: 'w-64' }">
    <UButton color="neutral" variant="ghost" aria-label="用户菜单" :title="label" class="min-w-0 gap-2 px-1.5">
      <UserIdentity v-if="user" :user="user" :show-username="false" size="sm" :link="false" />
      <span class="hidden max-w-56 truncate text-sm sm:inline" data-testid="domain-identity">{{ label }}</span>
      <UIcon name="i-lucide-chevron-down" class="size-3.5 shrink-0 text-text-muted" />
    </UButton>
  </UDropdownMenu>
</template>
