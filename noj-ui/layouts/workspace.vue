<script setup lang="ts">
import { extractApiError } from '~/utils/apiError';
const { domain, status, error, refresh } = provideWorkspaceContext();
const route = useRoute();
</script>
<template>
  <NuxtLayout name="default">
    <div class="mx-auto w-full px-4 py-6 sm:px-6" :class="route.meta.workspaceWidth === 'home' ? 'max-w-[1360px]' : route.meta.workspaceWidth === 'library' ? 'max-w-[1008px]' : route.meta.problemWorkspace ? 'max-w-[1600px]' : 'max-w-6xl'">
      <AsyncContent :status="error ? 'error' : domain ? 'data' : status === 'pending' || status === 'idle' ? 'loading' : 'empty'"
        :error="error ? extractApiError(error).message : undefined" empty-text="空间不存在或不可访问" @retry="refresh()">
        <template v-if="domain">
          <UAlert v-if="domain.status !== 'active'" class="mb-4" color="warning" variant="subtle" icon="i-lucide-archive"
            :title="domain.status === 'archived' ? '此空间已归档，当前仅可读取历史' : '此空间已暂停，当前为治理视图'" />
          <slot />
        </template>
      </AsyncContent>
    </div>
  </NuxtLayout>
</template>
