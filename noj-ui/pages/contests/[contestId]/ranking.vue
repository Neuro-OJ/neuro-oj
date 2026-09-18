<script setup lang="ts">
definePageMeta({ ssr: false })

const route = useRoute()
const contestId = route.params.contestId as string
</script>

<template>
  <div class="min-h-full bg-bg-page py-8">
    <div class="mx-auto max-w-[960px] px-4 sm:px-7">
      <ContestRanking :contest-id="contestId" />
    </div>
  </div>
</template>
