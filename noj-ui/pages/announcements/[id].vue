<script setup lang="ts">
const route = useRoute();
</script>
<template><div class="px-4 py-6 pb-16"><AnnouncementDetail :announcement-id="String(route.params.id)" /></div></template>
