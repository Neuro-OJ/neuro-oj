<script setup lang="ts">
import CommunityReportDetail from '~/components/community/CommunityReportDetail.vue';
definePageMeta({ middleware: 'auth' });
const { key } = useCommunityScope(true);
const route = useRoute();
</script>
<template>
    <CommunityReportDetail :key="`${key}:${route.path}`" account />
</template>
