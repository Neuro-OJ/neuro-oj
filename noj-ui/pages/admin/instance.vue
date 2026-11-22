<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin', });
const route = useRoute();
if (route.path === '/admin/instance' || route.path === '/admin/instance/') {
  await navigateTo('/admin/instance/access', { replace: true });
}
</script>

<template>
  <NuxtPage />
</template>
