<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type {
  AdminContestDetail,
  AdminProblemOption,
  ContestKind,
  ContestPayload,
  ContestProblemInput,
  ContestType,
} from '~/composables/useContests'
import {
  invitePublicProblemIds,
  INVITE_PUBLIC_PROBLEM_WARNING,
} from '~/utils/contestSelection'

const {
  open = false,
  contest = null,
  problems = [],
  saving = false,
  error = '',
} = defineProps<{
  open?: boolean
  contest?: AdminContestDetail | null
  problems?: AdminProblemOption[]
  saving?: boolean
  error?: string
}>()
const emit = defineEmits<{
  'update:open': [val: boolean]
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

/**
 * 邀请赛挂载公开题的保密风险提示（VULN-04 / VULN-05）。
 *
 * 公开题不会被全站保密遮蔽（反 DoS 设计），管理员需要显式知情。
 * 仅提示、不阻塞保存，也不改动任何权限模型。
 */
const publicInviteProblemIds = computed(() =>
  invitePublicProblemIds(
    kind.value,
    selectedProblems.value.map((item) => item.problem_id),
    problems,
  )
)
const invitePublicWarning = computed(() => publicInviteProblemIds.value.length > 0)
/** 公开题在选题列表里的标记：帮助管理员在选中前就做出判断。 */
function isPublicProblem(problem: AdminProblemOption): boolean {
  return problem.visibility === 'public'
}

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
  submissionLimits.value = { ...(contest?.config?.submission_limits ?? {}) }
  selectedProblems.value = (contest?.problems ?? []).map((problem, index) => ({
    problem_id: problem.problem_id,
    label: problem.label,
    sort_order: index,
    score: problem.score,
  }))
  problemQuery.value = ''
  localError.value = ''
}

watch(() => [contest, open], resetForm, { immediate: true })

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

const draggedIndex = ref<number | null>(null)
const dragOverIndex = ref<number | null>(null)

function onDragStart(index: number, event: DragEvent) {
  const target = event.target as HTMLElement | null
  if (target?.tagName === 'INPUT') {
    event.preventDefault()
    return
  }
  draggedIndex.value = index
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(index))
  }
}

function onDragOver(index: number, event: DragEvent) {
  if (draggedIndex.value === null || draggedIndex.value === index) return
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move'
  }
  dragOverIndex.value = index
}

function onDragEnter(index: number) {
  if (draggedIndex.value === null || draggedIndex.value === index) return
  dragOverIndex.value = index
}

function onDragLeave(index: number) {
  if (dragOverIndex.value === index) {
    dragOverIndex.value = null
  }
}

function onDrop(targetIndex: number) {
  const fromIndex = draggedIndex.value
  draggedIndex.value = null
  dragOverIndex.value = null
  if (fromIndex === null || fromIndex === targetIndex) return
  moveProblem(fromIndex, targetIndex)
}

function onDragEnd() {
  draggedIndex.value = null
  dragOverIndex.value = null
}

function moveProblem(fromIndex: number, toIndex: number) {
  if (fromIndex < 0 || fromIndex >= selectedProblems.value.length) return
  if (toIndex < 0 || toIndex >= selectedProblems.value.length) return
  const [item] = selectedProblems.value.splice(fromIndex, 1)
  if (!item) return
  selectedProblems.value.splice(toIndex, 0, item)
  normalizeProblems()
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
  <USlideover
    :open="open"
    side="right"
    :ui="{
      content: 'w-full sm:max-w-2xl lg:max-w-4xl xl:max-w-5xl h-screen max-h-screen flex flex-col',
      header: 'px-6 py-4 border-b border-border bg-bg-page/40',
      body: 'p-6 overflow-y-auto flex-1',
      footer: 'px-6 py-3.5 border-t border-border bg-bg-page/30 flex items-center justify-between',
    }"
    @update:open="(val: boolean) => {
      emit('update:open', val)
      if (!val) emit('cancel')
    }"
  >
    <template #title>
      <div class="flex items-center gap-2.5 text-base font-bold text-text">
        <div class="size-8 rounded-md bg-primary-bg text-primary flex items-center justify-center shrink-0 border border-primary/20">
          <UIcon name="i-lucide-trophy" class="size-4.5" />
        </div>
        <div class="flex flex-col">
          <span>{{ contest ? '编辑竞赛' : '创建竞赛' }}</span>
          <span class="text-xs font-normal text-text-muted">配置赛制模式、时间跨度、榜单规则与关联题目</span>
        </div>
      </div>
    </template>

    <template #body>
      <div class="grid gap-6 lg:grid-cols-[1fr_1fr]">
        <section class="space-y-4">
          <div>
            <label class="mb-1 block text-xs font-semibold text-text">竞赛标题 *</label>
            <input v-model="title" class="w-full rounded-md border border-border px-3 py-2 text-sm outline-none focus:border-primary transition-colors" placeholder="例如：NOJ 夏季挑战赛">
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <div>
              <label class="mb-1 block text-xs font-semibold text-text">开始时间 *</label>
              <input v-model="startTime" type="datetime-local" class="w-full rounded-md border border-border px-3 py-2 text-sm outline-none focus:border-primary transition-colors">
            </div>
            <div>
              <label class="mb-1 block text-xs font-semibold text-text">结束时间 *</label>
              <input v-model="endTime" type="datetime-local" class="w-full rounded-md border border-border px-3 py-2 text-sm outline-none focus:border-primary transition-colors">
            </div>
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <div>
              <label class="mb-1 block text-xs font-semibold text-text">赛制 *</label>
              <span class="block rounded-md border border-border bg-gray-50 px-3 py-2 text-sm text-text-secondary">类 Kaggle 分数赛</span>
            </div>
            <div>
              <label class="mb-1 block text-xs font-semibold text-text">{{ kind === 'invite' ? '邀请码' : '竞赛密码' }} <span v-if="kind === 'invite'" class="text-error-text">*</span></label>
              <input v-model="password" type="password" class="w-full rounded-md border border-border px-3 py-2 text-sm outline-none focus:border-primary transition-colors" :placeholder="contest?.has_password ? '留空则保持原邀请码' : (kind === 'invite' ? '必填，用于邀请用户参赛' : '留空表示无密码')">
            </div>
          </div>
          <p class="text-xs text-text-muted">类 Kaggle 赛制：每题取历史最高分，总分求和；可在题目列表中为每道题设置提交次数上限。</p>
          <div>
            <label class="mb-1 block text-xs font-semibold text-text">竞赛说明</label>
            <textarea v-model="description" rows="4" class="w-full resize-y rounded-md border border-border px-3 py-2 text-sm outline-none focus:border-primary transition-colors" placeholder="支持 Markdown"></textarea>
          </div>
          <div>
            <label class="mb-1 block text-xs font-semibold text-text">竞赛公告</label>
            <textarea v-model="announcement" rows="3" class="w-full resize-y rounded-md border border-border px-3 py-2 text-sm outline-none focus:border-primary transition-colors" placeholder="显示在竞赛详情页顶部"></textarea>
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="rounded-md border border-border p-3">
              <p class="mb-2 text-xs font-semibold text-text">竞赛类型</p>
              <div class="flex items-center gap-4 text-sm text-text">
                <label class="flex items-center gap-2 cursor-pointer"><input v-model="kind" type="radio" value="invite" class="size-4 accent-primary">邀请赛</label>
                <label class="flex items-center gap-2 cursor-pointer" :class="canPublic ? '' : 'opacity-50 cursor-not-allowed'"><input v-model="kind" type="radio" value="public" class="size-4 accent-primary" :disabled="!canPublic">公开赛</label>
              </div>
              <p v-if="!canPublic" class="mt-2 text-xs text-warning-text">公开赛需管理员权限，请联系管理员开通</p>
            </div>
            <label class="flex items-center gap-2 rounded-md border border-border p-3 text-sm text-text cursor-pointer"><input v-model="affectGlobalRanking" type="checkbox" class="size-4 accent-primary">计入全局统计</label>
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="block text-xs font-semibold text-text">
              榜单可见性
              <select v-model="rankingVisibility" class="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm font-normal bg-white">
                <option value="public">公开榜</option>
                <option value="participants">仅参赛者</option>
                <option value="hidden">完全隐藏</option>
              </select>
            </label>
            <label class="block text-xs font-semibold text-text">
              结束前封榜（分钟）
              <input v-model.number="freezeMinutes" type="number" min="0" class="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm font-normal" placeholder="0 表示不封榜">
            </label>
          </div>
          <p v-if="hasExplicitFreezeStart" class="text-xs text-warning-text">该竞赛已设置显式封榜起点；保存后将切换为“结束前 N 分钟”模式并清除显式起点。</p>
          <p class="text-xs text-text-muted">封榜从比赛结束前指定时刻开始，服务端会在 REST 与 SSE 中返回稳定冻结视图；管理员始终可查看实时完整榜。</p>
        </section>

        <section class="flex min-h-[520px] flex-col rounded-lg border border-border bg-bg-page/70 p-4">
          <div class="mb-3 flex items-center justify-between">
            <div>
              <h3 class="text-sm font-bold text-text">竞赛题目关联</h3>
              <p class="text-xs text-text-muted">已选 {{ selectedProblems.length }} 题（可按住左侧手柄拖动或使用上下箭头调整顺序）</p>
            </div>
          </div>

          <!-- 邀请赛 + 公开题风险提示 -->
          <div
            v-if="invitePublicWarning"
            role="status"
            class="mb-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
          >
            <UIcon name="i-lucide-shield-alert" class="mt-0.5 size-3.5 shrink-0" />
            <p class="min-w-0">
              {{ INVITE_PUBLIC_PROBLEM_WARNING }}
              <span class="mt-1 block">
                已选中的公开题目：
                <span class="font-mono">{{ publicInviteProblemIds.map(problemName).join('、') }}</span>
              </span>
            </p>
          </div>

          <div class="relative mb-3">
            <UIcon name="i-lucide-search" class="absolute left-3 top-2.5 text-text-muted size-3.5" />
            <input v-model="problemQuery" class="w-full rounded-md border border-border bg-white py-2 pl-9 pr-3 text-sm outline-none focus:border-primary transition-colors" placeholder="搜索题号或标题" @input="searchProblems">
          </div>
          <div class="mb-4 max-h-48 overflow-y-auto rounded-md border border-border bg-white">
            <button v-for="problem in filteredProblems" :key="problem.id" class="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-xs last:border-0 hover:bg-primary-bg transition-colors" @click="addProblem(problem)">
              <UIcon name="i-lucide-plus" class="text-primary size-3.5" /><span class="font-mono text-primary">{{ problem.display_id }}</span><span class="truncate text-text">{{ problem.title }}</span>
              <span v-if="isPublicProblem(problem)" class="ml-auto shrink-0 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-800">公开</span>
            </button>
            <p v-if="filteredProblems.length === 0" class="p-4 text-center text-xs text-text-muted">没有可添加的题目</p>
          </div>
          <!-- 已选题目列表列头说明 -->
          <div v-if="selectedProblems.length > 0" class="mb-1 flex items-center justify-between px-2 text-[11px] text-text-muted select-none">
            <span>题目与排序（可拖动调整）</span>
            <div class="flex items-center gap-10 pr-16">
              <span>单题分值</span>
              <span>提交限次</span>
            </div>
          </div>

          <div class="flex-1 space-y-2 overflow-y-auto">
            <div
              v-for="(problem, index) in selectedProblems"
              :key="problem.problem_id"
              draggable="true"
              class="flex items-center gap-2 rounded-md border p-2.5 shadow-2xs transition-all duration-150"
              :class="[
                draggedIndex === index
                  ? 'opacity-40 border-dashed border-primary bg-primary/5'
                  : 'bg-white border-border',
                dragOverIndex === index && draggedIndex !== index
                  ? 'ring-2 ring-primary border-primary bg-primary-bg/20'
                  : '',
              ]"
              @dragstart="onDragStart(index, $event)"
              @dragover.prevent="onDragOver(index, $event)"
              @dragenter.prevent="onDragEnter(index)"
              @dragleave="onDragLeave(index)"
              @drop.prevent="onDrop(index)"
              @dragend="onDragEnd"
            >
              <!-- 拖拽手柄 -->
              <div
                class="cursor-grab active:cursor-grabbing p-1 -ml-1 text-text-muted hover:text-primary transition-colors flex items-center shrink-0"
                title="拖动调整题目顺序"
              >
                <UIcon name="i-lucide-grip-vertical" class="size-4" />
              </div>

              <!-- 题目标签 (A, B, C...) -->
              <span class="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary-bg font-mono text-xs font-bold text-primary border border-primary/20">
                {{ problem.label }}
              </span>

              <!-- 题目名称 -->
              <span class="min-w-0 flex-1 truncate text-xs font-medium text-text select-text" :title="problemName(problem.problem_id)">
                {{ problemName(problem.problem_id) }}
              </span>

              <span v-if="publicInviteProblemIds.includes(problem.problem_id)" class="shrink-0 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-800">
                公开
              </span>

              <!-- 分值与限次参数输入组 -->
              <div class="flex items-center gap-2 shrink-0 select-text">
                <!-- 满分分值输入 -->
                <div
                  class="flex items-center rounded border border-border bg-bg-page/50 focus-within:border-primary focus-within:bg-white focus-within:ring-1 focus-within:ring-primary/20 transition-all overflow-hidden"
                  title="本题满分分值（分，默认 100 分）"
                >
                  <span class="bg-bg-page px-1.5 py-1 text-[11px] font-medium text-text-muted border-r border-border select-none shrink-0">
                    满分
                  </span>
                  <input
                    :value="(problem.score ?? DEFAULT_FULL_SCORE) / 100"
                    type="number"
                    min="0"
                    class="w-13 bg-transparent px-1.5 py-1 text-xs text-text tabular-nums outline-none text-right [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    placeholder="100"
                    draggable="false"
                    @input="problem.score = Number(($event.target as HTMLInputElement).value) * 100"
                  >
                  <span class="pr-1.5 text-[11px] text-text-muted select-none">分</span>
                </div>

                <!-- 提交上限输入 -->
                <div
                  class="flex items-center rounded border border-border bg-bg-page/50 focus-within:border-primary focus-within:bg-white focus-within:ring-1 focus-within:ring-primary/20 transition-all overflow-hidden"
                  title="单人提交次数上限（留空表示不限制提交次数）"
                >
                  <span class="bg-bg-page px-1.5 py-1 text-[11px] font-medium text-text-muted border-r border-border select-none shrink-0">
                    限次
                  </span>
                  <input
                    :value="submissionLimits[problem.problem_id] ?? ''"
                    type="number"
                    min="1"
                    class="w-11 bg-transparent px-1.5 py-1 text-xs text-text tabular-nums outline-none text-right [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    placeholder="不限"
                    draggable="false"
                    @input="setSubmissionLimit(problem.problem_id, $event)"
                  >
                  <span
                    v-if="submissionLimits[problem.problem_id]"
                    class="pr-1.5 text-[11px] text-text-muted select-none"
                  >次</span>
                </div>
              </div>

              <!-- 排序微调与移除 -->
              <div class="flex items-center gap-0.5 shrink-0">
                <button
                  type="button"
                  :disabled="index === 0"
                  class="rounded p-1 text-text-muted hover:bg-bg-page hover:text-text disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors"
                  title="上移"
                  @click="moveProblem(index, index - 1)"
                >
                  <UIcon name="i-lucide-arrow-up" class="size-3.5" />
                </button>
                <button
                  type="button"
                  :disabled="index === selectedProblems.length - 1"
                  class="rounded p-1 text-text-muted hover:bg-bg-page hover:text-text disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors"
                  title="下移"
                  @click="moveProblem(index, index + 1)"
                >
                  <UIcon name="i-lucide-arrow-down" class="size-3.5" />
                </button>
                <button
                  type="button"
                  class="rounded p-1 text-text-muted hover:bg-red-50 hover:text-error-text transition-colors"
                  title="移除题目"
                  @click="removeProblem(problem.problem_id)"
                >
                  <UIcon name="i-lucide-trash-2" class="size-3.5" />
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </template>

    <template #footer>
      <p class="text-xs text-error-text">{{ localError || error }}</p>
      <div class="ml-auto flex items-center gap-2">
        <UButton color="neutral" variant="outline" size="sm" :disabled="saving" @click="emit('cancel')">取消</UButton>
        <UButton color="primary" size="sm" :loading="saving" :disabled="saving" @click="submit">{{ saving ? '保存中...' : (contest ? '保存修改' : '创建竞赛') }}</UButton>
      </div>
    </template>
  </USlideover>
</template>
