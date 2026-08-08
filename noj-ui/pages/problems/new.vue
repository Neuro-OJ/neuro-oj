<script setup lang="ts">
definePageMeta({
  ssr: false,
})

const router = useRouter()

// 客观题套卷：创建 is_objective=true 的题目（type 可选 U/P，权限随类型）
const isObjective = ref(false)

function onSaved(id: string) {
  router.replace(isObjective.value ? `/problems/${id}/edit` : "/my/problems")
}
</script>

<template>
  <div class="px-4 py-5 sm:px-7 sm:py-8 max-w-[860px] mx-auto">
    <h1 class="text-2xl font-bold text-text mb-5">创建题目</h1>

    <div class="mb-4 flex items-center gap-2 rounded-xl border border-border bg-white px-4 py-3">
      <input
        id="objective-toggle"
        v-model="isObjective"
        type="checkbox"
        class="accent-primary"
      />
      <label for="objective-toggle" class="text-sm text-text">
        客观题套卷<span class="text-text-muted">（单选/多选/判断小题，服务端即时判定，无需评测配置）</span>
      </label>
    </div>

    <ProblemEditor mode="create" initial-type="U" :objective="isObjective" @saved="onSaved" />
  </div>
</template>
