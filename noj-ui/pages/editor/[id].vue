<script setup lang="ts">
import type { Contest, ContestProblem } from '~/composables/useContests'
import type { WorkspaceSubmission } from '~/components/editor/EditorWorkspace.vue'
import { getProblemTemplateUrl } from '~/utils/problemTemplate'
import { publicUrl } from '~/utils/publicIdentifiers'

/**
 * 独立做题页（标准题库与竞赛共用）。
 *
 * 竞赛模式：`/editor/:problemId?contest=<contestId>&label=<label>`
 * - 题目/提交/历史走竞赛接口，提交计入竞赛
 * - 仅参赛者/管理员可在进行中进入做题；结束后拦截（仅可查看）
 */
definePageMeta({ layout: false, ssr: false })

const route = useRoute()
const problemId = computed(() => route.params.id as string)
const contestId = computed(() => (route.query.contest as string) || '')
const label = computed(() => (route.query.label as string) || '')
const isContest = computed(() => !!contestId.value)
const { user } = useAuth()
const { api } = useApi()

// 竞赛上下文（subtitle / 状态 / 报名身份）
const { data: contestData } = useFetch<{ data: Contest }>(
  () => (isContest.value ? `/api/v1/contests/${contestId.value}` : ''),
  { server: false },
)
const contest = computed(() => contestData.value?.data ?? null)

type StandardProblem = {
  id: string
  display_id: string
  title: string
  description: string
  difficulty: string
  type: 'U' | 'P'
  submission_mode?: 'code' | 'artifact'
  tags: { id: string; name: string; kind: 'problem' | 'algorithm' }[]
}

const { data, pending, error, refresh } = useFetch<{
  data: StandardProblem | ContestProblem
}>(
  () => isContest.value
    ? `/api/v1/contests/${contestId.value}/problems/${label.value}`
    : `/api/v1/problems/${problemId.value}`,
  { server: false },
)

const workspaceProblem = computed(() => {
  const d = data.value?.data
  if (!d) return null
  if (isContest.value) {
    const p = d as ContestProblem
    return {
      id: p.problem_id,
      display_id: p.display_id,
      label: p.label,
      title: p.title,
      description: p.description,
      difficulty: p.difficulty,
      type: 'P' as const,
      submission_mode: p.submission_mode ?? 'code',
      tags: [],
    }
  }
  const p = d as StandardProblem
  return {
    id: p.id,
    display_id: p.display_id,
    title: p.title,
    description: p.description,
    difficulty: p.difficulty,
    type: p.type,
    submission_mode: p.submission_mode ?? 'code',
    tags: p.tags ?? [],
  }
})

const isArtifact = computed(() => workspaceProblem.value?.submission_mode === 'artifact')

// 竞赛访问控制：仅进行中且参赛者/管理员可进入编辑器
const canUseEditor = computed(() => {
  if (!isContest.value) return true
  const c = contest.value
  if (!c) return false
  const isAdmin = user.value?.is_admin === true
  const isParticipant = c.is_registered === true
  return c.status === 'running' && (isParticipant || isAdmin)
})

const accessMessage = computed(() => {
  if (!isContest.value) return ''
  const c = contest.value
  if (!c) return ''
  if (c.status === 'pending') return '竞赛尚未开始，暂不能进入做题'
  if (c.status === 'ended') return '比赛已结束，仅可查看题目'
  if (!(c.is_registered === true || user.value?.is_admin === true)) {
    return '仅参赛者可进入做题，请先报名参赛'
  }
  return ''
})

const canSubmit = computed(
  () => !isContest.value || contest.value?.status === 'running',
)

function submit(pid: string, language: string, code: string) {
  const url = isContest.value
    ? `/api/v1/contests/${contestId.value}/submit`
    : '/api/v1/submissions'
  return api
    .post<{ data: { id: string } }>(url, {
      problem_id: pid,
      language,
      code,
    })
    .then((r) => r.data)
}

function selfTest(pid: string, language: string, code: string) {
  return api
    .post<{ data: { id: string } }>(`/api/v1/problems/${pid}/self-test`, {
      language,
      code,
    })
    .then((r) => r.data)
}

function submissionFilter(s: WorkspaceSubmission): boolean {
  if (!isContest.value) return true
  const p = data.value?.data as ContestProblem | undefined
  return !p || s.problem_id === p.problem_id
}

const historyUrl = computed(() => isContest.value
  ? `/api/v1/contests/${contestId.value}/my-submissions?per_page=100`
  : `/api/v1/submissions?problem_id=${problemId.value}&limit=20`)

const backUrl = computed(() => isContest.value
  ? `/contests/${contestId.value}/problems/${label.value}`
  : `/problems/${problemId.value}`)

const draftKey = computed(() => isContest.value
  ? `contest:${contestId.value}:${label.value}`
  : problemId.value)

const templateUrl = getProblemTemplateUrl
</script>

<template>
  <!-- 页面级标题（WCAG 1.3.1）：编辑器为满屏工作区，无可见标题，用 sr-only 提供语义 -->
  <h1 class="sr-only">做题</h1>
  <!-- 竞赛访问拦截：结束后 / 未报名 / 未开始 → 提示并返回详情页 -->
  <div
    v-if="isContest && !pending && contest && !canUseEditor"
    class="h-screen flex items-center justify-center bg-bg-page"
  >
    <div class="flex flex-col items-center gap-3 rounded-xl border border-border bg-white px-8 py-10 text-center">
      <span class="flex size-11 items-center justify-center rounded-full bg-amber-100 text-amber-700 text-xl font-bold">
        <UIcon name="i-lucide-lock" class="size-5" />
      </span>
      <p class="text-sm font-medium text-text">{{ accessMessage || '暂无权限进入做题' }}</p>
      <div class="mt-1 flex gap-2">
        <UButton color="neutral" variant="outline" size="sm" :to="backUrl">
          返回题目详情
        </UButton>
        <UButton
          v-if="isContest"
          color="neutral"
          variant="outline"
          size="sm"
          :to="publicUrl('contest', contestId)"
        >
          返回竞赛
        </UButton>
      </div>
    </div>
  </div>

  <!-- artifact 题：不使用代码编辑器，引导返回详情页上传 zip -->
  <div
    v-else-if="isArtifact"
    class="h-screen flex items-center justify-center bg-bg-page"
  >
    <div class="flex flex-col items-center gap-3 rounded-xl border border-border bg-white px-8 py-10 text-center">
      <span class="flex size-11 items-center justify-center rounded-full bg-primary/10 text-primary text-xl font-bold">
        <UIcon name="i-lucide-package" class="size-5" />
      </span>
      <p class="text-sm font-medium text-text">该题为产物提交题，请返回题目详情上传 zip 文件。</p>
      <UButton color="primary" variant="outline" size="sm" :to="backUrl">
        返回题目详情
      </UButton>
    </div>
  </div>

  <EditorWorkspace
    v-else
    :problem="workspaceProblem"
    :pending="pending"
    :error="error"
    :retry="refresh"
    :history-url="historyUrl"
    :submit="submit"
    :self-test="isContest ? undefined : selfTest"
    :template-url="templateUrl"
    :draft-key="draftKey"
    :open-submission-url="(id: string) => publicUrl('submission', id)"
    :back-url="backUrl"
    :back-label="'返回题目详情'"
    :subtitle="isContest ? (contest?.title ?? '') : ''"
    :can-submit="canSubmit"
    :submission-filter="submissionFilter"
    @accepted="refresh"
  >
    <template v-if="isContest" #toolbar-actions>
      <UButton
        color="neutral"
        variant="outline"
        size="sm"
        class="gap-1.5 px-3 py-1.5 text-xs"
        :to="`${publicUrl('contest', contestId)}/ranking`"
      >
        <UIcon name="i-lucide-trophy" class="size-3.5" />排名
      </UButton>
    </template>
  </EditorWorkspace>
</template>
