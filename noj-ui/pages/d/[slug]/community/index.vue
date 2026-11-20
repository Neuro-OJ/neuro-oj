<script setup lang="ts">
import CommunityIndex from '~/components/feature/community/CommunityIndex.vue';
definePageMeta({ layout: 'workspace', middleware: 'workspace-context', workspaceWidth: 'library', breadcrumbWidth: '1008px' });
const { key } = useCommunityScope();
const route = useRoute();
</script>
<template>
  <CommunityIndex :key="`${key}:${route.path}`" embedded />
</template>
