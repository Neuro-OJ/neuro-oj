<script setup lang="ts">
definePageMeta({
  ssr: false,
})

useHead({ title: '创建 Coding 编程题 - Neuro OJ' })

const router = useRouter()

function onSaved() {
  router.replace("/my/problems")
}
</script>

<template>
  <div class="px-4 py-5 sm:px-7 sm:py-8 max-w-[860px] mx-auto">
    <h1 class="text-2xl font-bold text-text mb-5">创建 Coding 编程题</h1>

    <CodingProblemEditor mode="create" initial-type="U" @saved="onSaved" />
  </div>
</template>
