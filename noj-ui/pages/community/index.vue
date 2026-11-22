<script setup lang="ts">
import CommunityIndex from '~/components/community/CommunityIndex.vue';
definePageMeta({ breadcrumbWidth: '56rem' });
const { key } = useCommunityScope();
const route = useRoute();
</script>
<template>
    <CommunityIndex :key="`${key}:${route.path}`" />
</template>
