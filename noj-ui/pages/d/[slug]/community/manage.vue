<script setup lang="ts">
import { workspacePath, workspaceSlugFromPath } from '~/utils/workspace';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'], ssr: false });
const route = useRoute();
const slug = workspaceSlugFromPath(route.path) ?? 'main';
await navigateTo(workspacePath(slug, 'settings/community'), { replace: true });
</script>

<template>
  <div />
</template>
