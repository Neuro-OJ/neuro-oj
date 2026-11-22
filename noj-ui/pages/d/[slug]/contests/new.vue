<script setup lang="ts">
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const { slug, can } = useWorkspace();
useSeoMeta({ title: '创建比赛' });
</script>
<template>
  <DomainContestForm v-if="can('contest:manage') || can('contest:manage_own')" :slug="slug!" />
  <UAlert v-else color="warning" title="没有当前空间的比赛管理权限" />
</template>
