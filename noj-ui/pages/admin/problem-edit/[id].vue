<script setup lang="ts">
import { isNotFoundError } from '~/utils/apiError'
import { toProblemView, type ProblemResource } from '~/utils/problemView'

definePageMeta({
  layout: "admin",
  middleware: "admin",
  ssr: false,
})

const router = useRouter()
const route = useRoute()
const problemId = route.params.id as string
// 客观题套卷（is_objective）走套卷编辑器，其余走编程题编辑器（与前台编辑页一致）。
// 此前本页无条件渲染编程题编辑器，后台列表点「编辑」客观题会进入错误的表单。
const { data, error, pending } = await useFetch<{ data: ProblemResource }>(
  `/api/v1/problems/${problemId}`,
  { server: false },
)

if (isNotFoundError(error.value)) {
  throw createError({ statusCode: 404, statusMessage: '题目不存在' })
}

const problem = computed(() =>
  data.value?.data ? toProblemView(data.value.data) : null
)
const isOi = computed(() => data.value?.data?.judge_type === 'oi')
const isObjective = computed(() => problem.value?.is_objective === true)

function onSaved() {
  router.replace("/admin/problems")
}
</script>

<template>
  <div class="flex flex-col gap-4 max-w-[800px]">
    <AdminPageHeader
      :title="isObjective ? '编辑客观题套卷' : '编辑题目'"
      description="编辑现有题目"
    >
      <template #breadcrumb>
        <NuxtLink to="/admin/problems" class="inline-flex items-center gap-1.5 text-sm text-text-secondary no-underline hover:text-primary">
          <UIcon name="i-lucide-arrow-left" class="size-4" />
          返回题目列表
        </NuxtLink>
      </template>
    </AdminPageHeader>

    <!-- 题目类型确定后才挂载对应编辑器 -->
    <template v-if="!pending">
      <ObjectiveProblemEditor v-if="isObjective" :paper-id="problemId" />
      <OiProblemEditor v-else-if="isOi" mode="edit" :problem-id="problemId" @saved="onSaved" />
      <CodingProblemEditor v-else mode="edit" :problem-id="problemId" @saved="onSaved" />
    </template>
  </div>
</template>
