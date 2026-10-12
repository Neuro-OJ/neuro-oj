<script setup lang="ts">
definePageMeta({ layout: "admin", middleware: "admin", ssr: false })
await navigateTo("/admin/problem-new?type=oi", { replace: true })
</script>
<template><div /></template>
