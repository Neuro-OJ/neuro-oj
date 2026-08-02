<script setup lang="ts">
import type { Contest, ContestProblem } from '~/composables/useContests'
import type { WorkspaceSubmission } from '~/components/editor/EditorWorkspace.vue'

/**
 * 竞赛做题页：复用独立做题工作区（EditorWorkspace），
 * 仅注入竞赛数据源与提交链路。
 * 路径与详情页平级（/contests/:id/editor/:label），避免嵌套路由
 * 依赖父页面渲染 <NuxtPage /> 的问题（NUXT_E4016）。
 */
definePageMeta({ middleware: 'auth', ssr: false })

const route = useRoute()
const contestId = route.params.contestId as string
const label = route.params.label as string
const { api } = useApi()
const { user } = useAuth()

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

// 编辑器访问控制：仅竞赛进行中且为参赛者/管理员可进入；
// 结束后不允许使用编辑器（仅可查看题目，由详情页承担）。
const canUseEditor = computed(() => {
  const c = contest.value
  if (!c) return false
  const isAdmin = user.value?.is_admin === true
  const isParticipant = c.is_registered === true
  return c.status === 'running' && (isParticipant || isAdmin)
})

const accessMessage = computed(() => {
  const c = contest.value
  if (!c) return ''
  if (c.status === 'pending') return '竞赛尚未开始，暂不能进入做题'
  if (c.status === 'ended') return '比赛已结束，仅可查看题目'
  if (!(c.is_registered === true || user.value?.is_admin === true)) {
    return '仅参赛者可进入做题，请先报名参赛'
  }
  return ''
})

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
  <!-- 访问拦截：结束后 / 未报名 / 未开始 → 仅提示并返回详情页 -->
  <div
    v-if="!pending && contest && !canUseEditor"
    class="h-screen flex items-center justify-center bg-bg-page"
  >
    <div class="flex flex-col items-center gap-3 rounded-xl border border-border bg-white px-8 py-10 text-center">
      <span class="flex size-11 items-center justify-center rounded-full bg-amber-100 text-amber-700 text-xl font-bold">
        <UIcon name="i-lucide-lock" class="size-5" />
      </span>
      <p class="text-sm font-medium text-text">{{ accessMessage || '暂无权限进入做题' }}</p>
      <div class="mt-1 flex gap-2">
        <UButton
          color="neutral"
          variant="outline"
          size="sm"
          :to="`/contests/${contestId}/problems/${label}`"
        >
          返回题目详情
        </UButton>
        <UButton color="neutral" variant="outline" size="sm" :to="`/contests/${contestId}`">
          返回竞赛
        </UButton>
      </div>
    </div>
  </div>

  <EditorWorkspace
    v-else
    :problem="workspaceProblem"
    :pending="pending"
    :error="error"
    :retry="refresh"
    :history-url="`/api/v1/contests/${contestId}/my-submissions?per_page=100`"
    :submit="submit"
    :draft-key="`contest:${contestId}:${label}`"
    :open-submission-url="(id: string) => `/submissions/${id}`"
    :back-url="`/contests/${contestId}/problems/${label}`"
    :back-label="'返回题目详情'"
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
