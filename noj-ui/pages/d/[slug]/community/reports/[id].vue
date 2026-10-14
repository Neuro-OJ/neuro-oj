<script setup lang="ts">
import CommunityReportDetail from '~/components/feature/community/CommunityReportDetail.vue';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'], ssr: false });
const { key } = useCommunityScope();
const route = useRoute();
</script>
<template>
  <CommunityReportDetail :key="`${key}:${route.path}`" />
</template>
