<script setup lang="ts">
import { extractApiError } from '~/utils/apiError';
import { workspacePath } from '~/utils/workspace';
const { domain, status, error, refresh, can } = provideWorkspaceContext();
const tabs = computed(() =>
  domain.value
    ? [
      { label: '概览', to: workspacePath(domain.value.slug), icon: 'i-lucide-building-2' },
      ...(can('domain:members')
        ? [{ label: '成员', to: workspacePath(domain.value.slug, 'members'), icon: 'i-lucide-users' }]
        : []),
      ...(can('domain:settings')
        ? [{ label: '设置', to: workspacePath(domain.value.slug, 'settings'), icon: 'i-lucide-settings' }]
        : []),
    ]
    : []
);
</script>

<template>
  <NuxtLayout name="default">
    <div class="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
      <AsyncContent
        :status="error ? 'error' : domain ? 'data' : status === 'pending' || status === 'idle' ? 'loading' : 'empty'"
        :error="error ? extractApiError(error).message : undefined" empty-text="空间不存在或不可访问"
        @retry="refresh()">
        <template v-if="domain">
          <div class="mb-6 flex flex-wrap items-start justify-between gap-3">
            <div>
              <p class="mb-1 text-xs text-text-muted">{{ domain.slug }}</p>
              <h1 class="text-2xl font-bold text-text">{{ domain.name }}</h1>
              <p v-if="domain.description"
                class="mt-2 max-w-3xl text-sm text-text-secondary">{{ domain.description }}</p>
            </div>
            <UButton to="/workspaces" color="neutral" variant="outline" icon="i-lucide-grid-2x2">所有空间</UButton>
          </div>
          <UAlert v-if="domain.status !== 'active'" class="mb-4" color="warning" variant="subtle"
            icon="i-lucide-archive"
            :title="domain.status === 'archived' ? '此空间已归档，当前仅可读取历史' : '此空间已暂停，当前为治理视图'" />
          <nav class="mb-6 flex flex-wrap gap-2 border-b border-border pb-3" aria-label="空间导航">
            <UButton v-for="tab in tabs" :key="tab.to" :to="tab.to" :icon="tab.icon" color="neutral" variant="ghost"
              active-class="text-primary bg-primary-bg" exact>{{ tab.label }}</UButton>
          </nav>
          <slot />
        </template>
      </AsyncContent>
    </div>
  </NuxtLayout>
</template>
