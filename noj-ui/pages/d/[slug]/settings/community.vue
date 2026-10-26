<script setup lang="ts">
import CommunityManage from '~/components/feature/community/CommunityManage.vue';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'], ssr: false });
const { key } = useCommunityScope();
useSeoMeta({ title: '社区设置 - 域设置' });
</script>

<template>
  <DomainSettingsShell>
    <CommunityManage :key="key" />
  </DomainSettingsShell>
</template>
