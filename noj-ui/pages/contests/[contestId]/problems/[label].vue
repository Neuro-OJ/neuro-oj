<script setup lang="ts">
import type { Contest, ContestProblem } from '~/composables/useContests'
import type { WorkspaceSubmission } from '~/components/editor/EditorWorkspace.vue'

/**
 * 竞赛做题页：复用独立做题工作区（EditorWorkspace），
 * 仅注入竞赛数据源与提交链路。
 */
definePageMeta({ middleware: 'auth', ssr: false })

const route = useRoute()
const contestId = route.params.contestId as string
const label = route.params.label as string
const { api } = useApi()

const { data: contestData } = await useFetch<{ data: Contest }>(
  `/api/v1/contests/${contestId}`,
  { server: false },
)
const { data, pending, error, refresh } = await useFetch<{ data: ContestProblem }>(
  `/api/v1/contests/${contestId}/problems/${label}`,
  { server: false },
)
const problem = computed(() => data.value?.data ?? null)
const contest = computed(() => contestData.value?.data ?? null)

const workspaceProblem = computed(() => {
  const p = problem.value
  if (!p) return null
  return {
    id: p.problem_id,
    display_id: p.display_id,
    label: p.label,
    title: p.title,
    description: p.description,
    difficulty: p.difficulty,
    type: 'P' as const,
    categories: [],
  }
})

const canSubmit = computed(() => contest.value?.status === 'running')

function submit(problemId: string, language: string, code: string) {
  return api
    .post<{ data: { id: string } }>(`/api/v1/contests/${contestId}/submit`, {
      problem_id: problemId,
      language,
      code,
    })
    .then((r) => r.data)
}

// 竞赛 my-submissions 返回该竞赛全部提交，按当前题目过滤
function submissionFilter(s: WorkspaceSubmission): boolean {
  return !problem.value || s.problem_id === problem.value.problem_id
}
</script>

<template>
  <EditorWorkspace
    :problem="workspaceProblem"
    :pending="pending"
    :error="error"
    :retry="refresh"
    :history-url="`/api/v1/contests/${contestId}/my-submissions?per_page=100`"
    :submit="submit"
    :draft-key="`contest:${contestId}:${label}`"
    :open-submission-url="(id: string) => `/submissions/${id}`"
    :back-url="`/contests/${contestId}`"
    :back-label="'返回竞赛'"
    :subtitle="contest?.title ?? ''"
    :can-submit="canSubmit"
    :submission-filter="submissionFilter"
  >
    <template #toolbar-actions>
      <UButton
        color="neutral"
        variant="outline"
        size="sm"
        class="gap-1.5 px-3 py-1.5 text-xs"
        :to="`/contests/${contestId}/ranking`"
      >
        <UIcon name="i-lucide-trophy" class="size-3.5" />排名
      </UButton>
    </template>
  </EditorWorkspace>
</template>
