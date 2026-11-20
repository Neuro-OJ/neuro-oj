<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin', });
useRequireLogin();
</script>
<template>
  <AnnouncementManager />
</template>
