<script setup lang="ts">
import CommunityPostDetail from '~/components/feature/community/CommunityPostDetail.vue';
definePageMeta({ breadcrumbWidth: '56rem' });
const { key } = useCommunityScope();
const route = useRoute();
</script>
<template>
  <CommunityPostDetail :key="`${key}:${route.path}`" />
</template>
