<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin', ssr: false });
useRequireLogin();
</script>
<template><AnnouncementManager /></template>
