<script setup lang="ts">
import { workspacePath } from '~/utils/workspace';

definePageMeta({
  layout: 'workspace',
  middleware: [
    'auth',
    'workspace-context',
    (to) => {
      const slug = String(to.params.slug || 'main');
      return navigateTo({
        path: workspacePath(slug, 'submissions'),
        query: {
          kind: 'objective',
          ...(to.query.problem_id ? { problem_id: String(to.query.problem_id) } : {}),
        },
        replace: true,
      });
    },
  ],
});
</script>

<template>
  <div class="flex items-center justify-center py-16 text-text-muted">
    <UIcon name="i-lucide-loader-2" class="size-6 animate-spin" />
    <span class="ml-2">正在重定向至客观题提交...</span>
  </div>
</template>
