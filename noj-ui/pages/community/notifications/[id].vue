<script setup lang="ts">
import CommunityNotificationDetail from '~/components/community/CommunityNotificationDetail.vue';
definePageMeta({ middleware: 'auth' });
const { key } = useCommunityScope(true);
const route = useRoute();
</script>
<template>
  <CommunityNotificationDetail :key="`${key}:${route.path}`" account />
</template>
