<script setup lang="ts">
definePageMeta({
  ssr: false,
})

useHead({ title: '创建客观题套卷 - Neuro OJ' })

const router = useRouter()

function onSaved(id: string) {
  // 创建后进入套卷编辑页添加小题（单选/多选/判断）
  router.replace(`/problems/${id}/edit`)
}
</script>

<template>
  <div class="px-4 py-5 sm:px-7 sm:py-8 max-w-[860px] mx-auto">
    <NuxtLink to="/problems/new" class="text-sm text-text-secondary hover:text-primary no-underline mb-4 inline-block">
      &larr; 返回类型选择
    </NuxtLink>

    <h1 class="text-2xl font-bold text-text mb-1">创建客观题套卷</h1>
    <p class="mb-5 text-sm text-text-secondary">
      单选 / 多选 / 判断小题，服务端即时判定；创建后可继续添加小题。
    </p>

    <ProblemEditor mode="create" initial-type="U" objective @saved="onSaved" />
  </div>
</template>
