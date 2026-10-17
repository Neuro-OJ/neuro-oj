<script setup lang="ts">
definePageMeta({
  ssr: false,
})

useHead({ title: '创建 Coding 编程题 - Neuro OJ' })

const router = useRouter()
const route = useRoute()

// 建题后直接进入该题编辑页：支持包只能在那里上传，题目也在那里核对与发布。
// （此前跳到「我的题目」，而该列表只显示 U 型题，新建的 P 型题会"消失"。）
function onSaved(problemId: string) {
  router.replace(`/problems/${problemId}/edit`)
}
</script>

<template>
  <div class="px-4 py-5 sm:px-7 sm:py-8 max-w-[860px] mx-auto">
    <h1 class="text-2xl font-bold text-text mb-5">创建 Coding 编程题</h1>

    <ProblemEditor mode="create" :initial-judge-type="route.query.type === 'oi' ? 'oi' : 'dual'" initial-type="U" @saved="onSaved" />
  </div>
</template>
