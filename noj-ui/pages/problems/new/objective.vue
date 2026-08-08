<script setup lang="ts">
definePageMeta({
  ssr: false,
})

useHead({ title: '创建客观题套卷 - Neuro OJ' })
</script>

<template>
  <div class="px-4 py-5 sm:px-7 sm:py-8 max-w-[860px] mx-auto">
    <NuxtLink to="/problems/new" class="text-sm text-text-secondary hover:text-primary no-underline mb-4 inline-block">
      &larr; 返回类型选择
    </NuxtLink>

    <h1 class="text-2xl font-bold text-text mb-5">创建客观题套卷</h1>

    <ObjectiveProblemEditor />
  </div>
</template>
