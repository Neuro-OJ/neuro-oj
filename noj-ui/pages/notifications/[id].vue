<script setup lang="ts">
import CommunityNotificationDetail from '~/components/community/CommunityNotificationDetail.vue';
definePageMeta({ middleware: 'auth' });
</script>
<template><CommunityNotificationDetail account /></template>
