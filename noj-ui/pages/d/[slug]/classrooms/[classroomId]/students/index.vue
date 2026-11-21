<script setup lang="ts">
import { workspacePath } from '~/utils/workspace';

definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });

const route = useRoute();
const { slug } = useWorkspace();
const membersPath = computed(() =>
  workspacePath(slug.value!, `classrooms/${String(route.params.classroomId)}/members`)
);

if (import.meta.client) {
  await navigateTo(membersPath.value, { replace: true });
} else if (slug.value) {
  await navigateTo(membersPath.value, { replace: true });
}
</script>

<template>
  <div class="flex items-center justify-center py-12 text-sm text-text-secondary">
    正在前往
    <NuxtLink :to="membersPath" class="mx-1 text-primary hover:underline">班级成员与学员训练目录</NuxtLink>
    …
  </div>
</template>
