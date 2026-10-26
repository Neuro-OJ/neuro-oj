<script setup lang="ts">
import CommunityIndex from '~/components/feature/community/CommunityIndex.vue';
definePageMeta({ layout: 'workspace', middleware: 'workspace-context', breadcrumbWidth: '56rem' });
const { key } = useCommunityScope();
const route = useRoute();
</script>
<template>
  <CommunityIndex :key="`${key}:${route.path}`" />
</template>
