<script setup lang="ts">
import CommunityNotifications from '~/components/feature/community/CommunityNotifications.vue';
definePageMeta({ middleware: 'auth', });
const { key } = useCommunityScope(true);
const route = useRoute();
</script>
<template>
  <CommunityNotifications :key="`${key}:${route.path}`" account />
</template>
