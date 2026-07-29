<script setup lang="ts">
import { Plus, Search, Trash2, X } from '@lucide/vue'
import type {
  AdminContestDetail,
  AdminProblemOption,
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

const title = ref('')
const description = ref('')
const announcement = ref('')
const startTime = ref('')
const endTime = ref('')
const type = ref<ContestType>('icpc')
const isPublic = ref(true)
const password = ref('')
const affectGlobalRanking = ref(false)
const penaltyMinutes = ref(20)
const freezeTime = ref('')
const showRankingLive = ref(true)
const selectedProblems = ref<ContestProblemInput[]>([])
const problemQuery = ref('')
const localError = ref('')
let searchTimer: ReturnType<typeof setTimeout> | undefined

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
  startTime.value = toLocalDateTime(contest?.start_time) || toLocalDateTime(new Date(Date.now() + 3_600_000).toISOString())
  endTime.value = toLocalDateTime(contest?.end_time) || toLocalDateTime(new Date(Date.now() + 10_800_000).toISOString())
  type.value = contest?.type ?? 'icpc'
  isPublic.value = contest?.is_public ?? true
  password.value = ''
  affectGlobalRanking.value = contest?.affect_global_ranking ?? false
  penaltyMinutes.value = contest?.config.penalty_minutes ?? 20
  freezeTime.value = toLocalDateTime(contest?.config.freeze_time ?? undefined)
  showRankingLive.value = contest?.config.show_ranking_live ?? type.value === 'ioi'
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
    score: type.value === 'icpc' ? null : problem.score ?? 10000,
  }))
}

function addProblem(problem: AdminProblemOption) {
  selectedProblems.value.push({
    problem_id: problem.id,
    label: labelFor(selectedProblems.value.length),
    sort_order: selectedProblems.value.length,
    score: type.value === 'icpc' ? null : 10000,
  })
  normalizeProblems()
}

function removeProblem(problemId: string) {
  selectedProblems.value = selectedProblems.value.filter((item) => item.problem_id !== problemId)
  normalizeProblems()
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

  const config = type.value === 'icpc'
    ? {
        penalty_minutes: penaltyMinutes.value,
        freeze_time: freezeTime.value ? new Date(freezeTime.value).toISOString() : null,
        unfreeze_after_end: true,
      }
    : { show_ranking_live: type.value === 'ioi' ? showRankingLive.value : false }
  const payload: ContestPayload = {
    title: title.value.trim(),
    description: description.value,
    announcement: announcement.value,
    start_time: new Date(startTime.value).toISOString(),
    end_time: new Date(endTime.value).toISOString(),
    type: type.value,
    config,
    is_public: isPublic.value,
    affect_global_ranking: affectGlobalRanking.value,
    problems: selectedProblems.value.map((problem, index) => ({
      ...problem,
      sort_order: index,
      label: labelFor(index),
      score: type.value === 'icpc' ? null : problem.score ?? 10000,
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
        <button class="rounded-lg p-2 text-text-secondary hover:bg-gray-100" @click="emit('cancel')"><X :size="18" /></button>
      </header>

      <div class="grid flex-1 gap-6 overflow-y-auto p-6 lg:grid-cols-[1fr_1fr]">
        <section class="space-y-4">
          <div><label class="mb-1 block text-xs font-semibold text-text">竞赛标题 *</label><input v-model="title" class="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary" placeholder="例如：NOJ 夏季挑战赛"></div>
          <div class="grid gap-3 sm:grid-cols-2"><div><label class="mb-1 block text-xs font-semibold text-text">开始时间 *</label><input v-model="startTime" type="datetime-local" class="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary"></div><div><label class="mb-1 block text-xs font-semibold text-text">结束时间 *</label><input v-model="endTime" type="datetime-local" class="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary"></div></div>
          <div class="grid gap-3 sm:grid-cols-2"><div><label class="mb-1 block text-xs font-semibold text-text">赛制 *</label><select v-model="type" class="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-primary"><option value="icpc">ICPC 罚时制</option><option value="ioi">IOI 总分制</option><option value="oi">OI 隐藏排名</option></select></div><div><label class="mb-1 block text-xs font-semibold text-text">竞赛密码</label><input v-model="password" type="password" class="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary" :placeholder="contest?.has_password ? '留空则保持原密码' : '留空表示无密码'"></div></div>
          <div v-if="type === 'icpc'" class="grid gap-3 rounded-xl border border-blue-200 bg-blue-50 p-4 sm:grid-cols-2"><div><label class="mb-1 block text-xs font-semibold text-info-text">错误罚时（分钟）</label><input v-model.number="penaltyMinutes" type="number" min="1" class="w-full rounded-lg border border-blue-200 px-3 py-2 text-sm outline-none focus:border-primary"></div><div><label class="mb-1 block text-xs font-semibold text-info-text">封榜时间</label><input v-model="freezeTime" type="datetime-local" class="w-full rounded-lg border border-blue-200 px-3 py-2 text-sm outline-none focus:border-primary"></div></div>
          <label v-if="type === 'ioi'" class="flex items-center gap-2 rounded-lg border border-border p-3 text-sm text-text"><input v-model="showRankingLive" type="checkbox" class="size-4 accent-primary">实时公开排名</label>
          <div><label class="mb-1 block text-xs font-semibold text-text">竞赛说明</label><textarea v-model="description" rows="4" class="w-full resize-y rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary" placeholder="支持 Markdown"></textarea></div>
          <div><label class="mb-1 block text-xs font-semibold text-text">竞赛公告</label><textarea v-model="announcement" rows="3" class="w-full resize-y rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary" placeholder="显示在竞赛详情页顶部"></textarea></div>
          <div class="grid gap-2 sm:grid-cols-2"><label class="flex items-center gap-2 rounded-lg border border-border p-3 text-sm text-text"><input v-model="isPublic" type="checkbox" class="size-4 accent-primary">公开竞赛</label><label class="flex items-center gap-2 rounded-lg border border-border p-3 text-sm text-text"><input v-model="affectGlobalRanking" type="checkbox" class="size-4 accent-primary">计入全局统计</label></div>
        </section>

        <section class="flex min-h-[520px] flex-col rounded-xl border border-border bg-bg-page p-4">
          <div class="mb-3 flex items-center justify-between"><div><h3 class="text-sm font-bold text-text">竞赛题目</h3><p class="text-xs text-text-muted">已选 {{ selectedProblems.length }} 题</p></div></div>
          <div class="relative mb-3"><Search :size="15" class="absolute left-3 top-2.5 text-text-muted" /><input v-model="problemQuery" class="w-full rounded-lg border border-border bg-white py-2 pl-9 pr-3 text-sm outline-none focus:border-primary" placeholder="搜索题号或标题" @input="searchProblems"></div>
          <div class="mb-4 max-h-48 overflow-y-auto rounded-lg border border-border bg-white">
            <button v-for="problem in filteredProblems" :key="problem.id" class="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-xs last:border-0 hover:bg-primary-bg" @click="addProblem(problem)"><Plus :size="14" class="text-primary" /><span class="font-mono text-primary">{{ problem.display_id }}</span><span class="truncate text-text">{{ problem.title }}</span></button>
            <p v-if="filteredProblems.length === 0" class="p-4 text-center text-xs text-text-muted">没有可添加的题目</p>
          </div>
          <div class="flex-1 space-y-2 overflow-y-auto">
            <div v-for="(problem, index) in selectedProblems" :key="problem.problem_id" class="flex items-center gap-2 rounded-lg border border-border bg-white p-3">
              <span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-bg-dark font-mono text-xs font-bold text-white">{{ problem.label }}</span>
              <span class="min-w-0 flex-1 truncate text-xs font-medium text-text">{{ problemName(problem.problem_id) }}</span>
              <input v-if="type !== 'icpc'" :value="(problem.score ?? 10000) / 100" type="number" min="0" class="w-20 rounded border border-border px-2 py-1 text-xs" title="满分" @input="problem.score = Number(($event.target as HTMLInputElement).value) * 100">
              <button class="rounded p-1.5 text-text-muted hover:bg-red-50 hover:text-error-text" @click="removeProblem(problem.problem_id)"><Trash2 :size="14" /></button>
              <span class="hidden">{{ index }}</span>
            </div>
          </div>
        </section>
      </div>

      <footer class="flex items-center justify-between border-t border-border px-6 py-4">
        <p class="text-xs text-error-text">{{ localError || error }}</p>
        <div class="ml-auto flex gap-2"><button class="rounded-lg border border-border px-4 py-2 text-sm text-text-secondary hover:bg-gray-50" :disabled="saving" @click="emit('cancel')">取消</button><button class="rounded-lg bg-primary px-5 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:opacity-50" :disabled="saving" @click="submit">{{ saving ? '保存中...' : '保存竞赛' }}</button></div>
      </footer>
    </div>
  </div>
</template>
