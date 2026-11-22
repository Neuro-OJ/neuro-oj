<script setup lang="ts">
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const { domain, can } = useWorkspace();
useSeoMeta({ title: '公告管理 · 域设置' });
</script>
<template>
  <DomainSettingsShell>
    <AnnouncementManager v-if="domain && can('domain:settings')" :key="domain.id + ':' + domain.actor_id"
      :domain-slug="domain.slug" />
    <UAlert v-else color="neutral" title="你没有管理本域公告的权限" />
  </DomainSettingsShell>
</template>
