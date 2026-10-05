<script setup lang="ts">
definePageMeta({ ssr: false })

useHead({ title: "创建传统 OI 题 - Neuro OJ" })

const router = useRouter()
function onSaved() {
  router.replace("/my/problems")
}
</script>

<template>
  <div class="mx-auto max-w-[980px] px-4 py-5 sm:px-7 sm:py-8">
    <div class="mb-5 flex items-center gap-3">
      <NuxtLink to="/problems/new" class="text-text-secondary hover:text-primary"><UIcon name="i-lucide-arrow-left" class="size-4" /></NuxtLink>
      <div><h1 class="text-2xl font-bold text-text">创建传统 OI 题</h1><p class="mt-1 text-sm text-text-secondary">C/C++ 非交互题、子任务与标准 OI 判定</p></div>
    </div>
    <OiProblemEditor initial-type="U" @saved="onSaved" />
  </div>
</template>
