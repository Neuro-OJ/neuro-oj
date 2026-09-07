<script setup lang="ts">
import type {
  AdminContestDetail,
  AdminProblemOption,
  ContestKind,
  ContestPayload,
  ContestProblemInput,
  ContestType,
} from '~/composables/useContests'

const { contest, problems, saving = false, error = '' } = defineProps<{
  contest?: AdminContestDetail | null
  problems: AdminProblemOption[]
  saving?: boolean
  error?: string
}>()
const emit = defineEmits<{
  save: [payload: ContestPayload]
  cancel: []
  searchProblems: [keyword: string]
}>()

const { user } = useAuth()
const canPublic = computed(() =>
  user.value?.is_admin === true ||
  user.value?.permissions?.includes('admin:full_access') === true
)

const title = ref('')
const description = ref('')
const announcement = ref('')
const startTime = ref('')
const endTime = ref('')
const type = ref<ContestType>('kaggle')
const kind = ref<ContestKind>('invite')
const password = ref('')
const affectGlobalRanking = ref(false)
const rankingVisibility = ref<'public' | 'participants' | 'hidden'>('public')
const freezeMinutes = ref(0)
const hasExplicitFreezeStart = ref(false)
const submissionLimits = ref<Record<string, number>>({})
const selectedProblems = ref<ContestProblemInput[]>([])
const problemQuery = ref('')
const localError = ref('')
let searchTimer: ReturnType<typeof setTimeout> | undefined

// 默认时长（新建竞赛预填：开始 +1h，结束 +3h）与满分（×100 存储）
const HOUR_MS = 3_600_000
const DEFAULT_FULL_SCORE = 10000

function searchProblems() {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => emit('searchProblems', problemQuery.value.trim()), 250)
}

const filteredProblems = computed(() => {
  const query = problemQuery.value.trim().toLowerCase()
  return problems.filter((problem) => {
    if (selectedProblems.value.some((item) => item.problem_id === problem.id)) return false
    return !query || problem.title.toLowerCase().includes(query) || problem.display_id.toLowerCase().includes(query)
  }).slice(0, 20)
})

function toLocalDateTime(value: string | undefined) {
  if (!value) return ''
  const date = new Date(value)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function resetForm() {
  title.value = contest?.title ?? ''
  description.value = contest?.description ?? ''
  announcement.value = contest?.announcement ?? ''
  startTime.value = toLocalDateTime(contest?.start_time) || toLocalDateTime(new Date(Date.now() + HOUR_MS).toISOString())
  endTime.value = toLocalDateTime(contest?.end_time) || toLocalDateTime(new Date(Date.now() + 3 * HOUR_MS).toISOString())
  type.value = contest?.type ?? 'kaggle'
  kind.value = contest?.kind ?? 'invite'
  password.value = ''
  affectGlobalRanking.value = contest?.affect_global_ranking ?? false
  rankingVisibility.value = contest?.ranking_visibility ?? 'public'
  hasExplicitFreezeStart.value = Boolean(contest?.freeze_start_time)
  freezeMinutes.value = Math.floor((contest?.freeze_duration_seconds ?? 0) / 60)
  submissionLimits.value = { ...(contest?.config.submission_limits ?? {}) }
  selectedProblems.value = (contest?.problems ?? []).map((problem, index) => ({
    problem_id: problem.problem_id,
    label: problem.label,
    sort_order: index,
    score: problem.score,
  }))
  problemQuery.value = ''
  localError.value = ''
}

watch(() => contest, resetForm, { immediate: true })

function labelFor(index: number) {
  return String.fromCharCode(65 + index)
}

function normalizeProblems() {
  selectedProblems.value = selectedProblems.value.map((problem, index) => ({
    ...problem,
    label: labelFor(index),
    sort_order: index,
    score: problem.score ?? DEFAULT_FULL_SCORE,
  }))
}

function addProblem(problem: AdminProblemOption) {
  selectedProblems.value.push({
    problem_id: problem.id,
    label: labelFor(selectedProblems.value.length),
    sort_order: selectedProblems.value.length,
    score: DEFAULT_FULL_SCORE,
  })
  normalizeProblems()
}

function removeProblem(problemId: string) {
  selectedProblems.value = selectedProblems.value.filter((item) => item.problem_id !== problemId)
  delete submissionLimits.value[problemId]
  normalizeProblems()
}

function setSubmissionLimit(problemId: string, event: Event) {
  const value = (event.target as HTMLInputElement).value
  if (value === '') {
    delete submissionLimits.value[problemId]
  } else {
    submissionLimits.value[problemId] = Number(value)
  }
}

function problemName(problemId: string) {
  const problem = problems.find((item) => item.id === problemId)
  if (problem) return `${problem.display_id} ${problem.title}`
  const selected = contest?.problems.find((item) => item.problem_id === problemId)
  return selected ? `${selected.display_id} ${selected.title}` : problemId
}

watch(type, normalizeProblems)

function submit() {
  localError.value = ''
  if (!title.value.trim()) {
    localError.value = '竞赛标题不能为空'
    return
  }
  if (!startTime.value || !endTime.value || Date.parse(endTime.value) <= Date.parse(startTime.value)) {
    localError.value = '结束时间必须晚于开始时间'
    return
  }
  if (selectedProblems.value.length === 0) {
    localError.value = '请至少选择一道题目'
    return
  }
  if (kind.value === 'invite' && !password.value && !contest?.has_password) {
    localError.value = '邀请赛必须设置邀请码'
    return
  }

  const config = {
    ...(Object.keys(submissionLimits.value).length > 0
      ? { submission_limits: { ...submissionLimits.value } }
      : {}),
  }
  const payload: ContestPayload = {
    title: title.value.trim(),
    description: description.value,
    announcement: announcement.value,
    start_time: new Date(startTime.value).toISOString(),
    end_time: new Date(endTime.value).toISOString(),
    type: type.value,
    kind: kind.value,
    config,
    is_public: kind.value === 'public',
    affect_global_ranking: affectGlobalRanking.value,
    ranking_visibility: rankingVisibility.value,
    freeze_duration_seconds: Math.max(0, Math.floor(freezeMinutes.value * 60)),
    freeze_start_time: null,
    problems: selectedProblems.value.map((problem, index) => ({
      ...problem,
      sort_order: index,
      label: labelFor(index),
      score: problem.score ?? DEFAULT_FULL_SCORE,
    })),
  }
  if (password.value) payload.password = password.value
  emit('save', payload)
}
</script>

<template>
  <div class="fixed inset-0 z-300 flex items-center justify-center bg-black/45 p-4" @click.self="emit('cancel')">
    <div class="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-modal">
      <header class="flex items-center justify-between border-b border-border px-6 py-4">
        <div><h2 class="text-lg font-bold text-text">{{ contest ? '编辑竞赛' : '创建竞赛' }}</h2><p class="mt-1 text-xs text-text-muted">配置赛制、时间与竞赛题目</p></div>
        <button class="rounded-lg p-2 text-text-secondary hover:bg-gray-100" @click="emit('cancel')"><UIcon name="i-lucide-x" class="size-4.5" /></button>
      </header>

      <div class="grid flex-1 gap-6 overflow-y-auto p-6 lg:grid-cols-[1fr_1fr]">
        <section class="space-y-4">
          <div><label class="mb-1 block text-xs font-semibold text-text">竞赛标题 *</label><input v-model="title" class="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-signal" placeholder="例如：NOJ 夏季挑战赛"></div>
          <div class="grid gap-3 sm:grid-cols-2"><div><label class="mb-1 block text-xs font-semibold text-text">开始时间 *</label><input v-model="startTime" type="datetime-local" class="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-signal"></div><div><label class="mb-1 block text-xs font-semibold text-text">结束时间 *</label><input v-model="endTime" type="datetime-local" class="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-signal"></div></div>
          <div class="grid gap-3 sm:grid-cols-2"><div><label class="mb-1 block text-xs font-semibold text-text">赛制 *</label><span class="block rounded-lg border border-border bg-gray-50 px-3 py-2 text-sm text-text-secondary">类 Kaggle 分数赛</span></div><div><label class="mb-1 block text-xs font-semibold text-text">{{ kind === 'invite' ? '邀请码' : '竞赛密码' }} <span v-if="kind === 'invite'" class="text-error-text">*</span></label><input v-model="password" type="password" class="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-signal" :placeholder="contest?.has_password ? '留空则保持原邀请码' : (kind === 'invite' ? '必填，用于邀请用户参赛' : '留空表示无密码')"></div></div>
          <p class="text-xs text-text-muted">类 Kaggle 赛制：每题取历史最高分，总分求和；可在题目列表中为每道题设置提交次数上限。</p>
          <div><label class="mb-1 block text-xs font-semibold text-text">竞赛说明</label><textarea v-model="description" rows="4" class="w-full resize-y rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-signal" placeholder="支持 Markdown"></textarea></div>
          <div><label class="mb-1 block text-xs font-semibold text-text">竞赛公告</label><textarea v-model="announcement" rows="3" class="w-full resize-y rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-signal" placeholder="显示在竞赛详情页顶部"></textarea></div>
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="rounded-lg border border-border p-3">
              <p class="mb-2 text-xs font-semibold text-text">竞赛类型</p>
              <div class="flex items-center gap-4 text-sm text-text">
                <label class="flex items-center gap-2"><input v-model="kind" type="radio" value="invite" class="size-4 accent-primary">邀请赛</label>
                <label class="flex items-center gap-2" :class="canPublic ? '' : 'opacity-50 cursor-not-allowed'"><input v-model="kind" type="radio" value="public" class="size-4 accent-primary" :disabled="!canPublic">公开赛</label>
              </div>
              <p v-if="!canPublic" class="mt-2 text-xs text-warning-text">公开赛需管理员权限，请联系管理员开通</p>
            </div>
            <label class="flex items-center gap-2 rounded-lg border border-border p-3 text-sm text-text"><input v-model="affectGlobalRanking" type="checkbox" class="size-4 accent-primary">计入全局统计</label>
          </div>
          <div class="grid gap-3 sm:grid-cols-2"><label class="block text-xs font-semibold text-text">榜单可见性<select v-model="rankingVisibility" class="mt-1 w-full rounded-lg border border-border px-3 py-2 text-sm font-normal"><option value="public">公开榜</option><option value="participants">仅参赛者</option><option value="hidden">完全隐藏</option></select></label><label class="block text-xs font-semibold text-text">结束前封榜（分钟）<input v-model.number="freezeMinutes" type="number" min="0" class="mt-1 w-full rounded-lg border border-border px-3 py-2 text-sm font-normal" placeholder="0 表示不封榜"></label></div>
          <p v-if="hasExplicitFreezeStart" class="text-xs text-warning-text">该竞赛已设置显式封榜起点；保存后将切换为“结束前 N 分钟”模式并清除显式起点。</p>
          <p class="text-xs text-text-muted">封榜从比赛结束前指定时刻开始，服务端会在 REST 与 SSE 中返回稳定冻结视图；管理员始终可查看实时完整榜。</p>
        </section>

        <section class="flex min-h-[520px] flex-col rounded-xl border border-border bg-bg-page p-4">
          <div class="mb-3 flex items-center justify-between"><div><h3 class="text-sm font-bold text-text">竞赛题目</h3><p class="text-xs text-text-muted">已选 {{ selectedProblems.length }} 题</p></div></div>
          <div class="relative mb-3"><UIcon name="i-lucide-search" class="absolute left-3 top-2.5 text-text-muted size-3.5" /><input v-model="problemQuery" class="w-full rounded-lg border border-border bg-white py-2 pl-9 pr-3 text-sm outline-none focus:border-signal" placeholder="搜索题号或标题" @input="searchProblems"></div>
          <div class="mb-4 max-h-48 overflow-y-auto rounded-lg border border-border bg-white">
            <button v-for="problem in filteredProblems" :key="problem.id" class="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-xs last:border-0 hover:bg-primary-bg" @click="addProblem(problem)"><UIcon name="i-lucide-plus" class="text-primary size-3.5" /><span class="font-mono text-primary">{{ problem.display_id }}</span><span class="truncate text-text">{{ problem.title }}</span></button>
            <p v-if="filteredProblems.length === 0" class="p-4 text-center text-xs text-text-muted">没有可添加的题目</p>
          </div>
          <div class="flex-1 space-y-2 overflow-y-auto">
            <div v-for="problem in selectedProblems" :key="problem.problem_id" class="flex items-center gap-2 rounded-lg border border-border bg-white p-3">
              <span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-bg-dark font-mono text-xs font-bold text-white">{{ problem.label }}</span>
              <span class="min-w-0 flex-1 truncate text-xs font-medium text-text">{{ problemName(problem.problem_id) }}</span>
              <input :value="(problem.score ?? DEFAULT_FULL_SCORE) / 100" type="number" min="0" class="w-20 rounded border border-border px-2 py-1 text-xs" title="满分" @input="problem.score = Number(($event.target as HTMLInputElement).value) * 100">
              <input :value="submissionLimits[problem.problem_id] ?? ''" type="number" min="1" class="w-20 rounded border border-border px-2 py-1 text-xs" title="提交次数上限（留空不限）" placeholder="上限" @input="setSubmissionLimit(problem.problem_id, $event)">
              <button class="rounded p-1.5 text-text-muted hover:bg-red-50 hover:text-error-text" @click="removeProblem(problem.problem_id)"><UIcon name="i-lucide-trash-2" class="size-3.5" /></button>
            </div>
          </div>
        </section>
      </div>

      <footer class="flex items-center justify-between border-t border-border px-6 py-4">
        <p class="text-xs text-error-text">{{ localError || error }}</p>
        <div class="ml-auto flex gap-2"><UButton color="neutral" variant="outline" size="md" class="border-border text-text-secondary hover:bg-gray-50" :disabled="saving" @click="emit('cancel')">取消</UButton><UButton color="primary" size="md" :loading="saving" :disabled="saving" @click="submit">{{ saving ? '保存中...' : '保存竞赛' }}</UButton></div>
      </footer>
    </div>
  </div>
</template>
