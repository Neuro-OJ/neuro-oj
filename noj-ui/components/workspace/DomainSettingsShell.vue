<script setup lang="ts">
import { workspaceSettingsNavigation } from '~/utils/workspace-settings';
import { workspacePath } from '~/utils/workspace';
const { domain, slug, status } = useWorkspace();
const route = useRoute();
const entries = computed(() => domain.value ? workspaceSettingsNavigation(domain.value) : []);
const current = computed(() =>
  entries.value.find((item) => item.to === route.path + route.hash)?.to ??
  entries.value.find((item) => item.to === route.path)?.to ??
  route.path
);
function select(value: string) {
  return navigateTo(value);
}
</script>

<template>
  <div class="space-y-5">
    <AdminPageHeader title="域设置" :description="domain?.name" icon="i-lucide-settings">
      <template #actions>
        <UButton v-if="slug" :to="workspacePath(slug)" color="neutral" variant="outline"
          icon="i-lucide-arrow-left">返回域首页</UButton>
      </template>
    </AdminPageHeader>
    <USelect v-if="entries.length" :model-value="current"
      :items="entries.map(item => ({ label: item.label, value: item.to, icon: item.icon }))"
      class="w-full md:hidden" aria-label="域设置分组" @update:model-value="select" />
    <div class="grid min-w-0 gap-6 md:grid-cols-[200px_minmax(0,1fr)]">
      <aside class="hidden md:block">
        <nav v-if="entries.length" aria-label="域设置" class="sticky top-20 rounded border border-border bg-bg-panel p-2">
          <NuxtLink v-for="item in entries" :key="item.to" :to="item.to"
            class="flex items-center gap-2 rounded px-3 py-2 text-sm no-underline transition-colors"
            :class="current === item.to ? 'bg-primary-bg font-semibold text-primary' : 'text-text-secondary hover:bg-primary-hover-bg hover:text-text'"
            :aria-current="current === item.to ? 'page' : undefined">
            <UIcon :name="item.icon" class="size-4 shrink-0" />{{ item.label }}
          </NuxtLink>
        </nav>
        <div v-else-if="status === 'pending' || status === 'idle'" class="sticky top-20 rounded border border-border bg-bg-panel p-2 space-y-2 animate-pulse" aria-hidden="true">
          <div v-for="i in 5" :key="i" class="h-8 rounded bg-bg-sunken" />
        </div>
      </aside>
      <div class="min-w-0"><slot /></div>
    </div>
  </div>
</template>
