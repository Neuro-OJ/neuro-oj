<script setup lang="ts">
useHead({ title: '题单管理 - Neuro OJ' })

definePageMeta({ layout: 'admin', middleware: 'admin', ssr: false })
</script>

<template>
  <div class="space-y-6">
    <PageHeader title="题单管理" description="管理题单可见性、置顶与删除。" />
    <TrainingManagementSection />
  </div>
</template>
