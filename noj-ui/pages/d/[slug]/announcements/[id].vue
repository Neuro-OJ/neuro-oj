<script setup lang="ts">
definePageMeta({ layout: 'workspace', middleware: 'workspace-context' });
const { domain } = useWorkspace(), route = useRoute();
</script>
<template>
  <AnnouncementDetail v-if="domain" :key="domain.id + ':' + domain.actor_id + ':' + route.params.id"
    :domain-slug="domain.slug" :announcement-id="String(route.params.id)" />
</template>
