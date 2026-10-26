<script setup lang="ts">
import CommunityBookmarks from '~/components/feature/community/CommunityBookmarks.vue';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'], ssr: false });
const { key } = useCommunityScope();
const route = useRoute();
</script>
<template>
  <CommunityBookmarks :key="`${key}:${route.path}`" />
</template>
