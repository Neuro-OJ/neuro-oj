<script setup lang="ts">
definePageMeta({
  ssr: false,
})

const router = useRouter()
const route = useRoute()
const problemId = route.params.id as string

// 客观题套卷（is_objective）走套卷编辑器，其余走编程题编辑器
const { data } = await useFetch<{ data: { is_objective: boolean } }>(
  `/api/v1/problems/${problemId}`,
  { server: false },
)
const isObjective = computed(() => data.value?.data?.is_objective === true)

function onSaved() {
  router.replace(`/problems/${problemId}`)
}
</script>

<template>
  <div class="px-4 py-5 sm:px-7 sm:py-8 max-w-[860px] mx-auto">
    <NuxtLink :to="`/problems/${problemId}`" class="inline-flex items-center gap-1.5 text-base text-text-secondary hover:text-primary no-underline mb-4">
      <UIcon name="i-lucide-arrow-left" class="size-4" />返回题目
    </NuxtLink>

    <h1 class="text-2xl font-bold text-text mb-5">
      {{ isObjective ? '编辑客观题套卷' : '编辑题目' }}
    </h1>

    <ObjectiveProblemEditor v-if="isObjective" :paper-id="problemId" />
    <CodingProblemEditor v-else mode="edit" :problem-id="problemId" @saved="onSaved" />
  </div>
</template>
