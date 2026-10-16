<script setup lang="ts">
import { extractApiError } from '~/utils/apiError';

const { domain, status, error, refresh } = provideWorkspaceContext();
const route = useRoute();

const apiError = computed(() => (error.value ? extractApiError(error.value) : null));
const errStatus = computed(() => apiError.value?.status);
const isAuthOrNotFound = computed(() => {
  const code = errStatus.value;
  return code === 401 || code === 403 || code === 404;
});
const isForbidden = computed(() => errStatus.value === 403);
const isNotFound = computed(() => errStatus.value === 404);

// 有旧 domain 且遇到 5xx/network 错误时保留 slot 和草稿，显示背景刷新失败
const hasBackgroundError = computed(() => !!domain.value && !!error.value && !isAuthOrNotFound.value);

const contentStatus = computed(() => {
  if (isAuthOrNotFound.value) return 'error';
  if (domain.value) return 'data';
  if (error.value) return 'error';
  if (status.value === 'pending' || status.value === 'idle') return 'loading';
  return 'empty';
});
</script>
<template>
  <NuxtLayout name="default">
    <div class="mx-auto w-full px-4 py-6 sm:px-6"
      :class="route.meta.workspaceWidth === 'home' ? 'max-w-[1360px]' : route.meta.workspaceWidth === 'library' ? 'max-w-[1008px]' : route.meta.problemWorkspace ? 'max-w-[1600px]' : 'max-w-6xl'">
      <AsyncContent
        :status="contentStatus"
        :error="error ? (apiError?.message || '读取空间失败') : undefined" empty-text="空间不存在或不可访问"
        @retry="refresh()">
        <template #loading>
          <div class="space-y-4 py-8 animate-pulse">
            <div class="h-8 w-48 rounded bg-bg-sunken" />
            <div class="h-4 w-96 max-w-full rounded bg-bg-sunken" />
            <div class="mt-8 space-y-3">
              <div class="h-24 rounded bg-bg-sunken" />
              <div class="h-48 rounded bg-bg-sunken" />
            </div>
          </div>
        </template>
        <template #error="{ error: errorMsg }">
          <div v-if="isForbidden" class="flex flex-col items-center justify-center gap-4 px-6 py-20 text-text-muted" role="alert">
            <span class="flex items-center justify-center size-11 rounded bg-amber-500/10 text-amber-500 text-xl font-bold">
              <UIcon name="i-lucide-shield-alert" class="size-[22px]" />
            </span>
            <p class="font-medium text-text">没有访问此空间的权限</p>
            <p class="text-sm text-text-secondary">{{ errorMsg || '请联系空间管理员或尝试以有权账号登录' }}</p>
            <UButton to="/workspaces" color="neutral" variant="outline" size="sm">返回空间列表</UButton>
          </div>
          <div v-else-if="isNotFound" class="flex flex-col items-center justify-center gap-4 px-6 py-20 text-text-muted" role="alert">
            <span class="flex items-center justify-center size-11 rounded bg-bg-sunken text-text-muted text-xl font-bold">
              <UIcon name="i-lucide-file-question" class="size-[22px]" />
            </span>
            <p class="font-medium text-text">空间不存在</p>
            <p class="text-sm text-text-secondary">请检查网址是否正确</p>
            <UButton to="/workspaces" color="neutral" variant="outline" size="sm">返回空间列表</UButton>
          </div>
          <div v-else class="flex flex-col items-center justify-center gap-4 px-6 py-20 text-text-muted" role="alert">
            <span class="flex items-center justify-center size-11 rounded bg-error-text/10 text-error-text text-xl font-bold">
              <UIcon name="i-lucide-alert-circle" class="size-[22px]" />
            </span>
            <p class="font-medium text-text">{{ errorMsg ?? "读取空间失败" }}</p>
            <UButton color="primary" variant="outline" size="sm" @click="refresh()">重试</UButton>
          </div>
        </template>
        <template v-if="domain">
          <UAlert v-if="hasBackgroundError" class="mb-4" color="error" variant="subtle"
            icon="i-lucide-alert-circle"
            title="背景刷新失败，当前展示本地缓存，写入已临时禁用"
            :description="apiError?.message" />
          <UAlert v-if="domain.status !== 'active'" class="mb-4" color="warning" variant="subtle"
            icon="i-lucide-archive"
            :title="domain.status === 'archived' ? '此空间已归档，当前仅可读取历史' : '此空间已暂停，当前为治理视图'" />
          <slot />
        </template>
      </AsyncContent>
    </div>
  </NuxtLayout>
</template>
