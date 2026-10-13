<script setup lang="ts">
import CommunityNotificationDetail from '~/components/feature/community/CommunityNotificationDetail.vue';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'], ssr: false });
const { key } = useCommunityScope();
const route = useRoute();
</script>
<template>
  <CommunityNotificationDetail :key="`${key}:${route.path}`" />
</template>
