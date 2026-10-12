<script setup lang="ts">
import { extractApiError } from '~/utils/apiError'
import { useToast } from '~/composables/useToast'
import {
  useProblemVersions,
  type EffectiveVersionPolicy,
  type ProblemVersionSummary,
} from '~/composables/useProblemVersions'
import type { ProblemResource } from '~/utils/problemView'
import type { ContestProblem } from '~/composables/useContests'

/**
 * 管理端：题目版本策略与竞赛固定版本（Handbook §4.5）。
 *
 * 三个独立动作在这里各有一处入口，互不耦合：
 * - 题库有效版本策略（`any` / `exact(X)`）——不修改最新版指针；
 * - 「竞赛 × 题目」有效版本策略——`exact(X)` 同时把固定作答版本设为 X；
 * - 单独升级竞赛固定作答版本——不撤销旧成绩，策略冲突时要求同请求显式给出新策略。
 *
 * 所有写操作都带**预期 revision**（乐观锁）：并发点击/他人先改会返回 409，
 * 页面提示刷新后再试，绝不静默覆盖。
 */
definePageMeta({
  layout: 'admin',
  middleware: 'admin',
  ssr: false,
})

useRequireLogin()

const { api } = useApi()
const toast = useToast()
const {
  listVersions,
  setProblemPolicy,
  setContestProblemPolicy,
  setContestProblemVersion,
} = useProblemVersions()

// ── 题库策略 ──
const problemInput = ref('')
const problemLoading = ref(false)
const problemError = ref('')
const problem = ref<ProblemResource | null>(null)
const problemVersions = ref<ProblemVersionSummary[]>([])
/** 当前策略 revision（服务端下发，写操作必须回传）。 */
const problemPolicyRevision = ref(0)
/** 草稿态：待提交的策略。 */
const problemPolicyMode = ref<'any' | 'exact'>('any')
const problemPolicyVersionId = ref('')
const problemSaving = ref(false)

async function loadProblem() {
  const id = problemInput.value.trim()
  if (!id) {
    problemError.value = '请输入题目 ID 或题号（如 P1001）'
    return
  }
  problemLoading.value = true
  problemError.value = ''
  try {
    const detail = await api.get<{ data: ProblemResource }>(
      `/api/v1/problems/${id}`,
      { silent: true },
    )
    problem.value = detail.data
    problemPolicyRevision.value = detail.data.effective_version_policy_revision ?? 0
    const policy = detail.data.effective_version_policy
    problemPolicyMode.value = policy?.mode === 'exact' ? 'exact' : 'any'
    problemPolicyVersionId.value = policy?.mode === 'exact'
      ? (policy.version_id ?? '')
      : (detail.data.version_id ?? '')
    const versions = await listVersions(detail.data.id, 1, 100)
    problemVersions.value = versions.data
  } catch (err: unknown) {
    problem.value = null
    problemVersions.value = []
    problemError.value = extractApiError(err).message
  } finally {
    problemLoading.value = false
  }
}

async function saveProblemPolicy() {
  const p = problem.value
  if (!p || problemSaving.value) return
  if (problemPolicyMode.value === 'exact' && !problemPolicyVersionId.value) {
    problemError.value = 'exact 策略必须选择一个已发布版本'
    return
  }
  const policy: EffectiveVersionPolicy = problemPolicyMode.value === 'exact'
    ? { mode: 'exact', version_id: problemPolicyVersionId.value }
    : { mode: 'any' }
  problemSaving.value = true
  problemError.value = ''
  try {
    const res = await setProblemPolicy(p.id, policy, problemPolicyRevision.value)
    problemPolicyRevision.value = res.data.revision
    await loadProblem()
    toast.showToast(
      'success',
      `题库策略已切换（revision ${res.data.revision}，重算 ${res.data.affected_submissions} 条提交）`,
    )
  } catch (err: unknown) {
    problemError.value = extractApiError(err).message
    // 409（revision 过时）后重新载入，拿到最新 revision 再让管理员决定
    await loadProblem().catch(() => {})
  } finally {
    problemSaving.value = false
  }
}

// ── 竞赛 × 题目 固定版本与策略 ──
const contestInput = ref('')
const contestLoading = ref(false)
const contestError = ref('')
const contestProblems = ref<ContestProblem[]>([])
const contestId = ref('')
/** 每题的目标版本与目标策略（管理员在表格内直接编辑）。 */
const contestDraft = ref<Record<string, { versionId: string; mode: 'any' | 'exact'; versionChoice: string }>>({})
const contestSavingId = ref('')

async function loadContest() {
  const id = contestInput.value.trim()
  if (!id) {
    contestError.value = '请输入竞赛 ID 或公开 ID（如 ct-xxxxxxxx）'
    return
  }
  contestLoading.value = true
  contestError.value = ''
  try {
    const res = await api.get<{ data: ContestProblem[] }>(
      `/api/v1/contests/${id}/problems`,
      { silent: true },
    )
    contestId.value = id
    contestProblems.value = res.data
    const draft: Record<string, { versionId: string; mode: 'any' | 'exact'; versionChoice: string }> = {}
    for (const item of res.data) {
      draft[item.problem_id] = {
        versionId: item.version_id ?? '',
        mode: item.effective_version_policy?.mode === 'exact' ? 'exact' : 'any',
        versionChoice: item.effective_version_policy?.mode === 'exact'
          ? (item.effective_version_policy.version_id ?? '')
          : (item.version_id ?? ''),
      }
    }
    contestDraft.value = draft
  } catch (err: unknown) {
    contestProblems.value = []
    contestId.value = ''
    contestError.value = extractApiError(err).message
  } finally {
    contestLoading.value = false
  }
}

function contestRowVersionChoice(problemId: string): string {
  return contestDraft.value[problemId]?.versionChoice ?? ''
}

function setContestRowVersionChoice(problemId: string, value: string) {
  const row = contestDraft.value[problemId]
  if (!row) return
  contestDraft.value = { ...contestDraft.value, [problemId]: { ...row, versionChoice: value } }
}

function setContestRowMode(problemId: string, mode: 'any' | 'exact') {
  const row = contestDraft.value[problemId]
  if (!row) return
  contestDraft.value = { ...contestDraft.value, [problemId]: { ...row, mode } }
}

/**
 * 保存单题的竞赛设置。
 *
 * - 目标固定版本与当前不同 → 调「升级固定版本」（可同时给新策略）；
 * - 固定版本不变、只改策略 → 调「切换竞赛策略」。
 * 两条路径都带预期 revision，冲突时提示刷新。
 */
async function saveContestRow(item: ContestProblem) {
  const row = contestDraft.value[item.problem_id]
  if (!row || !contestId.value) return
  const policy: EffectiveVersionPolicy = row.mode === 'exact'
    ? { mode: 'exact', version_id: row.versionChoice }
    : { mode: 'any' }
  if (row.mode === 'exact' && !row.versionChoice) {
    contestError.value = 'exact 策略必须选择目标版本'
    return
  }
  contestSavingId.value = item.problem_id
  contestError.value = ''
  try {
    const revision = item.effective_version_policy_revision ?? 0
    if (row.versionChoice && row.versionChoice !== item.version_id) {
      await setContestProblemVersion(contestId.value, item.problem_id, row.versionChoice, {
        policy,
        expectedRevision: revision,
      })
      toast.showToast('success', `${item.label} 固定版本已升级（旧成绩保留，是否有效由策略决定）`)
    } else if (row.versionChoice) {
      await setContestProblemPolicy(contestId.value, item.problem_id, policy, revision)
      toast.showToast('success', `${item.label} 竞赛策略已切换`)
    } else {
      contestError.value = '请先选择目标版本'
      return
    }
    await loadContest()
  } catch (err: unknown) {
    contestError.value = extractApiError(err).message
    await loadContest().catch(() => {})
  } finally {
    contestSavingId.value = ''
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <AdminPageHeader
      title="题目版本策略"
      description="切换题库/竞赛的有效版本策略，或单独升级竞赛固定作答版本（三个动作互不耦合）"
    />

    <!-- ── 题库有效版本策略 ── -->
    <section class="rounded-lg border border-border bg-white p-4">
      <h2 class="text-sm font-semibold text-text">题库有效版本策略</h2>
      <p class="mt-1 text-xs text-text-muted">
        <code class="font-mono">any</code>：历史版本均可产生有效成绩；
        <code class="font-mono">exact(X)</code>：只采用 X 的成绩（X+1 不自动有效）。
        策略切换不修改最新版指针，提交后立即生效。
      </p>

      <div class="mt-3 flex flex-wrap items-end gap-2">
        <div class="flex min-w-[220px] flex-col gap-1">
          <label class="text-xs font-semibold text-text-secondary">题目 ID / 题号</label>
          <input
            v-model="problemInput"
            class="rounded border border-border bg-white px-2.5 py-1.5 text-13px text-text outline-none focus:border-primary"
            placeholder="P1001 或 UUID"
            @keyup.enter="loadProblem"
          />
        </div>
        <UButton color="primary" size="sm" :loading="problemLoading" @click="loadProblem">
          载入
        </UButton>
      </div>

      <p v-if="problemError" class="mt-2 text-xs text-error-text">{{ problemError }}</p>

      <div v-if="problem" class="mt-4 flex flex-col gap-3 border-t border-border pt-3 text-sm">
        <div class="flex flex-wrap items-center gap-3">
          <span class="text-text-secondary">题目</span>
          <span class="font-medium text-text">{{ problem.display_id }} {{ problem.title }}</span>
          <UBadge color="neutral" variant="subtle">策略 revision {{ problemPolicyRevision }}</UBadge>
          <UBadge v-if="problem.version != null" color="primary" variant="subtle">
            当前作答版本 v{{ problem.version }}
          </UBadge>
          <UBadge v-if="problem.latest_version != null" color="neutral" variant="subtle">
            最新版 v{{ problem.latest_version }}
          </UBadge>
        </div>

        <div class="flex flex-wrap items-end gap-2">
          <div class="flex min-w-[160px] flex-col gap-1">
            <label class="text-xs font-semibold text-text-secondary">策略</label>
            <USelect
              v-model="problemPolicyMode"
              :items="[{ value: 'any', label: 'any（全部版本有效）' }, { value: 'exact', label: 'exact（仅指定版本）' }]"
              class="min-w-[160px]"
            />
          </div>
          <div v-if="problemPolicyMode === 'exact'" class="flex min-w-[200px] flex-col gap-1">
            <label class="text-xs font-semibold text-text-secondary">要求版本</label>
            <USelect
              v-model="problemPolicyVersionId"
              :items="problemVersions.map((v) => ({ value: v.id, label: `v${v.version}${v.is_latest ? '（最新）' : ''}` }))"
              class="min-w-[200px]"
            />
          </div>
          <UButton color="primary" size="sm" :loading="problemSaving" @click="saveProblemPolicy">
            保存策略
          </UButton>
        </div>
      </div>
    </section>

    <!-- ── 竞赛 × 题目 固定版本与策略 ── -->
    <section class="rounded-lg border border-border bg-white p-4">
      <h2 class="text-sm font-semibold text-text">竞赛固定版本与策略</h2>
      <p class="mt-1 text-xs text-text-muted">
        竞赛固定作答版本决定选手提交时使用的版本；升级固定版本本身不撤销旧成绩。
        竞赛策略为 <code class="font-mono">exact(X)</code> 时，固定作答版本必须同时为 X。
      </p>

      <div class="mt-3 flex flex-wrap items-end gap-2">
        <div class="flex min-w-[220px] flex-col gap-1">
          <label class="text-xs font-semibold text-text-secondary">竞赛 ID / 公开 ID</label>
          <input
            v-model="contestInput"
            class="rounded border border-border bg-white px-2.5 py-1.5 text-13px text-text outline-none focus:border-primary"
            placeholder="ct-xxxxxxxx 或 UUID"
            @keyup.enter="loadContest"
          />
        </div>
        <UButton color="primary" size="sm" :loading="contestLoading" @click="loadContest">
          载入题目
        </UButton>
      </div>

      <p v-if="contestError" class="mt-2 text-xs text-error-text">{{ contestError }}</p>

      <div v-if="contestProblems.length > 0" class="mt-4 overflow-x-auto border-t border-border pt-3">
        <table class="w-full text-sm">
          <thead class="border-b border-border text-xs uppercase tracking-wider text-text-muted">
            <tr>
              <th class="p-2 text-left">题号</th>
              <th class="p-2 text-left">题目</th>
              <th class="p-2 text-left">固定版本</th>
              <th class="p-2 text-left">策略</th>
              <th class="p-2 text-left">目标版本 / 要求版本</th>
              <th class="p-2 text-left">策略 revision</th>
              <th class="p-2 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in contestProblems" :key="item.problem_id" class="border-b border-border">
              <td class="p-2 font-mono">{{ item.label }}</td>
              <td class="p-2">{{ item.title }}</td>
              <td class="p-2 tabular-nums">
                {{ item.version != null ? `v${item.version}` : '未固定' }}
              </td>
              <td class="p-2">
                <USelect
                  :model-value="contestDraft[item.problem_id]?.mode ?? 'any'"
                  :items="[{ value: 'any', label: 'any' }, { value: 'exact', label: 'exact' }]"
                  class="min-w-[100px]"
                  @update:model-value="(value: string) => setContestRowMode(item.problem_id, value as 'any' | 'exact')"
                />
              </td>
              <td class="p-2">
                <input
                  :value="contestRowVersionChoice(item.problem_id)"
                  class="w-[260px] rounded border border-border bg-white px-2 py-1 font-mono text-xs outline-none focus:border-primary"
                  placeholder="版本 UUID"
                  @input="(e: Event) => setContestRowVersionChoice(item.problem_id, (e.target as HTMLInputElement).value.trim())"
                />
              </td>
              <td class="p-2 tabular-nums">{{ item.effective_version_policy_revision ?? 0 }}</td>
              <td class="p-2 text-right">
                <UButton
                  color="primary"
                  size="xs"
                  :loading="contestSavingId === item.problem_id"
                  @click="saveContestRow(item)"
                >
                  保存
                </UButton>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
