<script setup lang="ts">
definePageMeta({ layout: 'workspace', middleware: 'workspace-context' });
const { domain } = useWorkspace();
</script>
<template>
  <AnnouncementList v-if="domain" :key="domain.id + ':' + domain.actor_id" :domain-slug="domain.slug" />
</template>
