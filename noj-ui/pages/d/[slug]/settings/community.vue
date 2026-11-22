<script setup lang="ts">
import CommunityManage from '~/components/community/CommunityManage.vue';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const { key } = useCommunityScope();
useSeoMeta({ title: '社区设置 - 域设置' });
</script>

<template>
  <WorkspaceSettingsShell>
    <CommunityManage :key="key" />
  </WorkspaceSettingsShell>
</template>
