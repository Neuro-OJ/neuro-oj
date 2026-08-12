<script setup lang="ts">
const route = useRoute()
const contestId = route.params.contestId as string
</script>

<template>
  <div class="min-h-full bg-bg-page py-8">
    <div class="mx-auto max-w-[960px] px-4 sm:px-7">
      <div class="mb-4 flex items-center gap-2 text-sm">
        <NuxtLink :to="`/contests/${contestId}`" class="inline-flex items-center gap-1.5 text-text-muted no-underline hover:text-primary"><UIcon name="i-lucide-arrow-left" class="size-4" />返回竞赛</NuxtLink>
      </div>
      <ContestRanking :contest-id="contestId" />
    </div>
  </div>
</template>
