<script setup lang="ts">
import { workspacePath, workspaceSlugFromPath } from '~/utils/workspace';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const route = useRoute();
const slug = workspaceSlugFromPath(route.path) ?? 'main';
await navigateTo(workspacePath(slug, 'settings/members'), { replace: true });
</script>

<template>
  <div />
</template>
