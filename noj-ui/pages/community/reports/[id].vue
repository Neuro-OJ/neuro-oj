<script setup lang="ts">
import CommunityReportDetail from '~/components/feature/community/CommunityReportDetail.vue';
definePageMeta({ middleware: 'auth', ssr: false });
const { key } = useCommunityScope(true);
const route = useRoute();
</script>
<template>
  <CommunityReportDetail :key="`${key}:${route.path}`" account />
</template>
