<script setup lang="ts">
/**
 * 标准题库独立做题页。
 * 完整 IDE 工作区（草稿/轮询/侧栏/状态栏等）由 EditorWorkspace 提供。
 */
definePageMeta({
  layout: false,
  ssr: false,
})

const route = useRoute()
const problemId = computed(() => route.params.id as string)
const { api } = useApi()

const { data, pending, error, refresh } = useFetch<{
  data: {
    id: string
    display_id: string
    title: string
    description: string
    difficulty: string
    type: 'U' | 'P'
    categories: { id: string; name: string; slug: string }[]
  }
}>(`/api/v1/problems/${problemId.value}`, { server: false })

const workspaceProblem = computed(() => {
  const p = data.value?.data
  if (!p) return null
  return {
    id: p.id,
    display_id: p.display_id,
    title: p.title,
    description: p.description,
    difficulty: p.difficulty,
    type: p.type,
    categories: p.categories,
  }
})

function submit(problemIdValue: string, language: string, code: string) {
  return api
    .post<{ data: { id: string } }>('/api/v1/submissions', {
      problem_id: problemIdValue,
      language,
      code,
    })
    .then((r) => r.data)
}
</script>

<template>
  <EditorWorkspace
    :problem="workspaceProblem"
    :pending="pending"
    :error="error"
    :retry="refresh"
    :history-url="() => `/api/v1/submissions?problem_id=${problemId}&limit=20`"
    :submit="submit"
    :template-url="(id: string) => `/api/v1/problems/${id}/template`"
    :draft-key="problemId"
    :open-submission-url="(id: string) => `/submissions/${id}`"
    :back-url="`/problems/${problemId}`"
    :back-label="'返回题目详情'"
  />
</template>
