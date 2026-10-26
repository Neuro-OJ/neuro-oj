<script setup lang="ts">
import CommunityManage from '~/components/feature/community/CommunityManage.vue';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'], ssr: false });
const { key } = useCommunityScope();
</script>
<template>
  <CommunityManage :key="key" />
</template>
