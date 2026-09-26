<script setup lang="ts">
import { isNotFoundError } from '~/utils/apiError'
import { toProblemView, type ProblemResource } from '~/utils/problemView'

definePageMeta({
  ssr: false,
})

const router = useRouter()
const route = useRoute()
const problemId = route.params.id as string

// 客观题套卷（is_objective）走套卷编辑器，其余走编程题编辑器
const { data, error } = await useFetch<{ data: ProblemResource }>(
  `/api/v1/problems/${problemId}`,
  { server: false },
)

// 404（题目不存在，或被公开赛保密而对当前用户不可见）→ 404 页。
// 此前本页没有错误分支：404 会静默渲染成一张空白的编辑表单。
if (isNotFoundError(error.value)) {
  throw createError({ statusCode: 404, statusMessage: '题目不存在' })
}

const problem = computed(() =>
  data.value?.data ? toProblemView(data.value.data) : null
)
const isObjective = computed(() => problem.value?.is_objective === true)

function onSaved() {
  router.replace(`/problems/${problemId}`)
}
</script>

<template>
  <div class="px-4 py-5 sm:px-7 sm:py-8 max-w-[860px] mx-auto">
    <!-- 公开赛保密提示：仅所有者/管理员能打开本页（其他人 404） -->
    <ProblemContestNotice :contests="problem?.contest_secrecy ?? []" />

    <h1 class="text-2xl font-bold text-text mb-5">
      {{ isObjective ? '编辑客观题套卷' : '编辑题目' }}
    </h1>

    <ObjectiveProblemEditor v-if="isObjective" :paper-id="problemId" />
    <CodingProblemEditor v-else mode="edit" :problem-id="problemId" @saved="onSaved" />
  </div>
</template>
