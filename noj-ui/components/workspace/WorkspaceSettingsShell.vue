<script setup lang="ts">
import { workspaceSettingsNavigation, type WorkspaceSettingsNavItem } from '~/utils/workspace-settings';
import { workspacePath } from '~/utils/workspace';

const { domain, slug, status } = useWorkspace();
const route = useRoute();

const entries = computed(() => domain.value ? workspaceSettingsNavigation(domain.value) : []);
const current = computed(() =>
  entries.value.find((item) => item.to === route.path + route.hash)?.to ??
  entries.value.find((item) => item.to === route.path)?.to ??
  route.path
);

const groupedEntries = computed(() => {
  const map = new Map<string, WorkspaceSettingsNavItem[]>();
  for (const item of entries.value) {
    const list = map.get(item.group) || [];
    list.push(item);
    map.set(item.group, list);
  }
  return Array.from(map.entries()).map(([group, items]) => ({ group, items }));
});

function select(value: string) {
  return navigateTo(value);
}
</script>

<template>
  <div class="space-y-6">
    <AdminPageHeader
      title="域设置"
      :description="domain?.name ? `配置「${domain.name}」的空间基本信息、访问权限与资源治理` : '管理空间配置与资源限额'"
      icon="i-lucide-settings"
    >
      <template #actions>
        <UButton
          v-if="slug"
          :to="workspacePath(slug)"
          color="neutral"
          variant="outline"
          icon="i-lucide-arrow-left"
        >
          返回域首页
        </UButton>
      </template>
    </AdminPageHeader>

    <!-- 手机端平级选择（包含组名和当前位置） -->
    <div class="md:hidden">
      <USelect
        v-if="entries.length"
        :model-value="current"
        :items="entries.map(item => ({ label: `${item.group} · ${item.label}`, value: item.to, icon: item.icon }))"
        class="w-full"
        aria-label="域设置导航"
        @update:model-value="select"
      />
    </div>

    <div class="grid min-w-0 gap-6 md:grid-cols-[220px_minmax(0,1fr)]">
      <!-- 桌面端侧边栏导航卡片 -->
      <aside class="hidden md:block">
        <nav
          v-if="entries.length"
          aria-label="域设置"
          class="sticky top-20 rounded-lg border border-border bg-white dark:bg-bg-panel p-3 space-y-4 shadow-card"
        >
          <div v-for="grp in groupedEntries" :key="grp.group" class="space-y-1.5">
            <div class="px-2.5 text-xs font-bold text-text-muted uppercase tracking-wider">
              {{ grp.group }}
            </div>
            <div class="space-y-0.5">
              <NuxtLink
                v-for="item in grp.items"
                :key="item.to"
                :to="item.to"
                class="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm no-underline transition-colors"
                :class="current === item.to
                  ? 'bg-primary-bg font-semibold text-primary shadow-xs'
                  : 'text-text-secondary hover:bg-bg-sunken hover:text-text'"
                :aria-current="current === item.to ? 'page' : undefined"
              >
                <UIcon :name="item.icon" class="size-4 shrink-0" />
                <span class="truncate">{{ item.label }}</span>
              </NuxtLink>
            </div>
          </div>
        </nav>
        <div
          v-else-if="status === 'pending' || status === 'idle'"
          class="sticky top-20 rounded-lg border border-border bg-white dark:bg-bg-panel p-3 space-y-2 animate-pulse shadow-card"
          aria-hidden="true"
        >
          <div v-for="i in 6" :key="i" class="h-8 rounded bg-bg-sunken" />
        </div>
      </aside>

      <!-- 设置内容区 -->
      <div class="min-w-0 space-y-6">
        <slot />
      </div>
    </div>
  </div>
</template>
