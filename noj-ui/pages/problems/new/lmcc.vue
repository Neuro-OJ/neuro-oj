<script setup lang="ts">
definePageMeta({
  ssr: false,
})

useHead({ title: '创建 LMCC 编程题 - Neuro OJ' })

const router = useRouter()

function onSaved() {
  router.replace("/my/problems")
}
</script>

<template>
  <div class="px-4 py-5 sm:px-7 sm:py-8 max-w-[860px] mx-auto">
    <NuxtLink to="/problems/new" class="text-sm text-text-secondary hover:text-primary no-underline mb-4 inline-block">
      &larr; 返回类型选择
    </NuxtLink>

    <h1 class="text-2xl font-bold text-text mb-5">创建 LMCC 编程题</h1>

    <ProblemEditor mode="create" initial-type="U" @saved="onSaved" />
  </div>
</template>
