<script setup lang="ts">
definePageMeta({
  ssr: false,
})

const router = useRouter()
const route = useRoute()
const problemId = route.params.id as string

function onSaved() {
  router.replace(`/problems/${problemId}`)
}
</script>

<template>
  <div class="px-4 py-5 sm:px-7 sm:py-8 max-w-[860px] mx-auto">
    <NuxtLink :to="`/problems/${problemId}`" class="text-sm text-text-secondary hover:text-primary no-underline mb-4 inline-block">
      &larr; 返回题目
    </NuxtLink>

    <h1 class="text-2xl font-bold text-text mb-5">编辑题目</h1>

    <ProblemEditor mode="edit" :problem-id="problemId" @saved="onSaved" />
  </div>
</template>
