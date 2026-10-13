<script setup lang="ts">
import CommunityNotifications from '~/components/feature/community/CommunityNotifications.vue';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'], ssr: false });
const { key } = useCommunityScope();
const route = useRoute();
</script>
<template>
  <CommunityNotifications :key="`${key}:${route.path}`" />
</template>
