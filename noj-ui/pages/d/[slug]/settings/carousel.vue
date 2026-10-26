<script setup lang="ts">
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'], ssr: false });
const { domain, can } = useWorkspace();
useSeoMeta({ title: '轮播管理 · 域设置' });
</script>
<template>
  <DomainSettingsShell>
    <CarouselManager v-if="domain && can('domain:settings')" :key="domain.id + ':' + domain.actor_id"
      :domain-slug="domain.slug" />
    <UAlert v-else color="neutral" title="你没有管理本域轮播的权限" />
  </DomainSettingsShell>
</template>
