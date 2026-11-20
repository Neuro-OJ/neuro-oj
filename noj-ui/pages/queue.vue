<script setup lang="ts">
definePageMeta({
  middleware: [
    (to) => {
      return navigateTo({
        path: '/d/main/queue',
        query: to.query,
        replace: true,
      });
    },
  ],
});
</script>

<template>
  <div class="flex items-center justify-center py-16 text-text-muted">
    <UIcon name="i-lucide-loader-2" class="size-6 animate-spin" />
    <span class="ml-2">正在重定向至评测队列...</span>
  </div>
</template>
