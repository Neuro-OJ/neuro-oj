<script setup lang="ts">
import { extractApiError } from '~/utils/apiError'
import { useToast } from '~/composables/useToast'
import {
  isJobTerminal,
  useProblemVersions,
  type AcceptJobResult,
  type RejudgeRequest,
  type RejudgeScope,
  type RejudgeTarget,
  type SubmissionJobItemView,
  type SubmissionJobView,
} from '~/composables/useProblemVersions'
import type { ContestProblem } from '~/composables/useContests'
import { publicUrl } from '~/utils/publicIdentifiers'

/**
 * 管理端：批量重测任务（Handbook §4.3）。
 *
 * 受理三种范围（手选提交 / 整题 / 整场）× 三种目标（提交时版本 / 当前最新版 /
 * 指定版本），并可选在同一受理事务内切换有效版本策略；任务进度与条目状态由
 * 持久化条目聚合（页面刷新可自愈），重试只覆盖 failed/skipped 条目。
 *
 * 「全部用 V3」在前端展开为逐题版本映射：任一所涉题目没有 V3 时**不发起受理**，
 * 避免产生半套任务（Handbook §7）。
 */
definePageMeta({
  layout: 'admin',
  middleware: 'admin',
  ssr: false,
})

useRequireLogin()

const { api } = useApi()
const toast = useToast()
const { acceptRejudgeJob, getJob, listJobItems, retryJob } = useProblemVersions()

// ── 受理表单 ──
const scopeType = ref<'selected' | 'problem' | 'contest'>('problem')
const selectedIds = ref('')
const scopeProblemId = ref('')
const scopeContestId = ref('')
const targetMode = ref<'submitted' | 'latest' | 'byNumber'>('submitted')
/** 「全部用 V<n>」的版本号（前端展开为逐题映射）。 */
const targetVersionNumber = ref<number | null>(3)
/** `specified` 目标的逐题映射（题目 ID → 版本 ID），由展开或手填得到。 */
const specifiedVersions = ref<Record<string, string>>({})
const expansionNote = ref('')
const submitting = ref(false)
const submitError = ref('')
const accepted = ref<AcceptJobResult | null>(null)

// ── 任务查看 ──
const jobQuery = ref('')
const job = ref<SubmissionJobView | null>(null)
const jobItems = ref<SubmissionJobItemView[]>([])
const jobItemsTotal = ref(0)
const jobItemsPage = ref(1)
const jobItemStatus = ref<string>('')
const jobLoading = ref(false)
const jobError = ref('')
const retrying = ref(false)
const polling = ref(false)
/** 当前展示的任务 ID（供模板中的分页/重试回调使用，避免在闭包里解引用可空对象）。 */
const currentJobId = ref('')

async function loadJob(jobId: string, page = 1) {
  jobLoading.value = true
  jobError.value = ''
  try {
    currentJobId.value = jobId
    job.value = await getJob(jobId)
    const items = await listJobItems(jobId, {
      page,
      perPage: 20,
      ...(jobItemStatus.value ? { status: jobItemStatus.value } : {}),
    })
    jobItems.value = items.data
    jobItemsTotal.value = items.total
    jobItemsPage.value = items.page
    jobQuery.value = jobId
  } catch (err: unknown) {
    job.value = null
    jobItems.value = []
    jobError.value = extractApiError(err).message
  } finally {
    jobLoading.value = false
  }
}

/** 轮询到终态（进度由服务端条目聚合，本地不做计数）。 */
async function waitForTerminal(jobId: string) {
  polling.value = true
  try {
    const deadline = Date.now() + 180_000
    let current = await getJob(jobId)
    while (!isJobTerminal(current.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      current = await getJob(jobId)
      job.value = current
    }
    await loadJob(jobId, 1)
  } finally {
    polling.value = false
  }
}

/** 展开「全部用 V<n>」为逐题版本映射；任一所涉题目缺少该版本号即失败。 */
async function expandVersionNumber(problemIds: string[], versionNumber: number): Promise<Record<string, string>> {
  const mapping: Record<string, string> = {}
  const missing: string[] = []
  for (const problemId of problemIds) {
    const res = await api.get<{ data: Array<{ id: string; version: number }> }>(
      `/api/v1/problems/${problemId}/versions?page=1&per_page=100`,
      { silent: true },
    )
    const match = res.data.find((v) => v.version === versionNumber)
    if (match) mapping[problemId] = match.id
    else missing.push(problemId)
  }
  if (missing.length > 0) {
    throw new Error(
      `以下题目没有 V${versionNumber}，整次受理已取消：${missing.join('、')}`,
    )
  }
  return mapping
}

/** 收集本次范围涉及的题目 ID（手选范围需要逐个查询提交所属题目）。 */
async function collectProblemIds(scope: RejudgeScope): Promise<string[]> {
  if (scope.type === 'problem') return [scope.problem_id]
  if (scope.type === 'contest') {
    const res = await api.get<{ data: ContestProblem[] }>(
      `/api/v1/contests/${scope.contest_id}/problems`,
      { silent: true },
    )
    return res.data.map((item) => item.problem_id)
  }
  // 手选：逐条读取提交详情以取得题目（上限 500，受理前先做数量校验）
  const ids = new Set<string>()
  for (const item of scope.submissions) {
    const res = await api.get<{ data: { problem_id: string } }>(
      item.kind === 'submission'
        ? `/api/v1/submissions/${item.id}`
        : `/api/v1/problems/submissions/${item.id}`,
      { silent: true },
    )
    ids.add(res.data.problem_id)
  }
  return [...ids]
}

function parseSelectedIds(): Array<{ kind: 'submission' | 'objective'; id: string }> {
  return selectedIds.value
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((id) => ({ kind: 'submission' as const, id }))
}

async function submitJob() {
  if (submitting.value) return
  submitError.value = ''
  expansionNote.value = ''
  submitting.value = true
  try {
    let scope: RejudgeScope
    if (scopeType.value === 'problem') {
      if (!scopeProblemId.value.trim()) throw new Error('请输入题目 ID')
      scope = { type: 'problem', problem_id: scopeProblemId.value.trim() }
    } else if (scopeType.value === 'contest') {
      if (!scopeContestId.value.trim()) throw new Error('请输入竞赛 ID')
      scope = { type: 'contest', contest_id: scopeContestId.value.trim() }
    } else {
      const submissions = parseSelectedIds()
      if (submissions.length === 0) throw new Error('请输入至少一条提交 ID')
      if (submissions.length > 500) {
        throw new Error('手选提交单次最多 500 条；整题/整场任务没有该限制')
      }
      scope = { type: 'selected', submissions }
    }

    let target: RejudgeTarget
    if (targetMode.value === 'submitted') {
      target = { mode: 'submitted' }
    } else if (targetMode.value === 'latest') {
      target = { mode: 'latest' }
    } else {
      const versionNumber = targetVersionNumber.value
      if (versionNumber == null || versionNumber < 1) {
        throw new Error('请输入有效的版本号（如 3 表示全部用 V3）')
      }
      const problemIds = await collectProblemIds(scope)
      if (problemIds.length === 0) throw new Error('该范围没有题目')
      specifiedVersions.value = await expandVersionNumber(problemIds, versionNumber)
      expansionNote.value = `已展开「全部用 V${versionNumber}」：${problemIds.length} 道题`
      target = { mode: 'specified', versions: specifiedVersions.value }
    }

    const request: RejudgeRequest = { kind: 'rejudge', scope, target }
    accepted.value = await acceptRejudgeJob(request)
    toast.showToast('success', `任务已受理（${accepted.value.total_items} 条条目）`)
    await loadJob(accepted.value.job_id, 1)
    void waitForTerminal(accepted.value.job_id)
  } catch (err: unknown) {
    submitError.value = extractApiError(err).message || (err as Error).message
  } finally {
    submitting.value = false
  }
}

async function onRetry() {
  if (!job.value || retrying.value) return
  retrying.value = true
  try {
    const next = await retryJob(job.value.id)
    toast.showToast('success', `重试任务已受理（${next.total_items} 条）`)
    await loadJob(next.job_id, 1)
    void waitForTerminal(next.job_id)
  } catch (err: unknown) {
    toast.showToast('error', extractApiError(err).message)
  } finally {
    retrying.value = false
  }
}

function itemStatusColor(status: string): 'success' | 'error' | 'warning' | 'neutral' | 'primary' {
  if (status === 'succeeded') return 'success'
  if (status === 'failed') return 'error'
  if (status === 'skipped') return 'warning'
  if (status === 'dispatched' || status === 'preparing') return 'primary'
  return 'neutral'
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <AdminPageHeader
      title="批量重测"
      description="按手选提交 / 整题 / 整场发起重测，可指定目标版本并在同一事务内切换有效策略"
    />

    <!-- ── 受理 ── -->
    <section class="rounded-lg border border-border bg-white p-4">
      <h2 class="text-sm font-semibold text-text">受理重测任务</h2>
      <div class="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div class="flex flex-col gap-2">
          <label class="text-xs font-semibold text-text-secondary">范围</label>
          <USelect
            v-model="scopeType"
            :items="[
              { value: 'problem', label: '整题（该题全部提交）' },
              { value: 'contest', label: '整场（该场全部题目）' },
              { value: 'selected', label: '手选提交（≤500）' },
            ]"
          />
          <input
            v-if="scopeType === 'problem'"
            v-model="scopeProblemId"
            class="rounded border border-border bg-white px-2.5 py-1.5 text-13px outline-none focus:border-primary"
            placeholder="题目 ID / 题号"
          />
          <input
            v-else-if="scopeType === 'contest'"
            v-model="scopeContestId"
            class="rounded border border-border bg-white px-2.5 py-1.5 text-13px outline-none focus:border-primary"
            placeholder="竞赛 ID / 公开 ID"
          />
          <textarea
            v-else
            v-model="selectedIds"
            rows="4"
            class="rounded border border-border bg-white px-2.5 py-1.5 font-mono text-xs outline-none focus:border-primary"
            placeholder="每行一条提交 ID（支持逗号/空格分隔）"
          />
          <p v-if="scopeType === 'selected'" class="text-11px text-text-muted">
            手选范围按「提交」处理；客观题提交请使用 item kind=objective（API）。
          </p>
        </div>

        <div class="flex flex-col gap-2">
          <label class="text-xs font-semibold text-text-secondary">目标版本</label>
          <USelect
            v-model="targetMode"
            :items="[
              { value: 'submitted', label: '提交时版本（不可变）' },
              { value: 'latest', label: '当前最新版（受理时固定）' },
              { value: 'byNumber', label: '全部用 V<n>（逐题展开）' },
            ]"
          />
          <input
            v-if="targetMode === 'byNumber'"
            v-model.number="targetVersionNumber"
            type="number"
            min="1"
            class="w-[140px] rounded border border-border bg-white px-2.5 py-1.5 text-13px tabular-nums outline-none focus:border-primary"
            placeholder="版本号，如 3"
          />
          <p v-if="targetMode === 'byNumber'" class="text-11px text-text-muted">
            任一所涉题目没有该版本号 → 整次受理取消（不产生任务、不改策略）。
          </p>
          <p v-if="targetMode === 'latest'" class="text-11px text-text-muted">
            「最新版」在受理事务内解析并固定，之后发布的新版本不影响本批任务。
          </p>
        </div>
      </div>

      <div class="mt-3 flex flex-wrap items-center gap-3">
        <UButton color="primary" size="sm" :loading="submitting" @click="submitJob">
          受理任务
        </UButton>
        <span v-if="expansionNote" class="text-xs text-text-muted">{{ expansionNote }}</span>
      </div>

      <p v-if="submitError" class="mt-2 text-xs text-error-text">{{ submitError }}</p>
      <p v-if="accepted" class="mt-2 text-xs text-text-secondary">
        任务 <span class="font-mono text-primary">{{ accepted.job_id }}</span>
        已受理：{{ accepted.total_items }} 条{{ accepted.existing ? '（复用同幂等键的既有任务）' : '' }}
      </p>
    </section>

    <!-- ── 进度与条目 ── -->
    <section class="rounded-lg border border-border bg-white p-4">
      <h2 class="text-sm font-semibold text-text">任务进度</h2>
      <div class="mt-3 flex flex-wrap items-end gap-2">
        <div class="flex min-w-[320px] flex-col gap-1">
          <label class="text-xs font-semibold text-text-secondary">任务 ID</label>
          <input
            v-model="jobQuery"
            class="rounded border border-border bg-white px-2.5 py-1.5 font-mono text-xs outline-none focus:border-primary"
            placeholder="任务 UUID"
            @keyup.enter="loadJob(jobQuery, 1)"
          />
        </div>
        <UButton color="primary" size="sm" :loading="jobLoading" @click="loadJob(jobQuery, 1)">
          查询
        </UButton>
      </div>

      <p v-if="jobError" class="mt-2 text-xs text-error-text">{{ jobError }}</p>

      <div v-if="job" class="mt-4 flex flex-col gap-3 border-t border-border pt-3">
        <div class="flex flex-wrap items-center gap-3 text-sm">
          <UBadge :color="isJobTerminal(job.status) ? 'success' : 'primary'" variant="subtle">
            {{ job.status }}
          </UBadge>
          <span class="font-mono text-xs text-text-muted">{{ job.id }}</span>
          <span class="text-text-secondary">条目 {{ job.total_items }}</span>
          <span v-for="(count, status) in job.counts" :key="status" class="text-xs text-text-muted">
            {{ status }} {{ count }}
          </span>
          <span v-if="polling" class="flex items-center gap-1 text-xs text-text-muted">
            <UIcon name="i-lucide-loader-2" class="size-3.5 animate-spin" />轮询中
          </span>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <USelect
            v-model="jobItemStatus"
            :items="[
              { value: '', label: '全部状态' },
              { value: 'pending', label: 'pending' },
              { value: 'dispatched', label: 'dispatched' },
              { value: 'succeeded', label: 'succeeded' },
              { value: 'failed', label: 'failed' },
              { value: 'skipped', label: 'skipped' },
            ]"
            class="min-w-[160px]"
            @change="loadJob(currentJobId, 1)"
          />
          <UButton
            color="neutral"
            variant="outline"
            size="sm"
            :loading="retrying"
            :disabled="!isJobTerminal(job.status)"
            @click="onRetry"
          >
            重试 failed / skipped
          </UButton>
          <span class="text-11px text-text-muted">重试生成新任务并保留目标版本映射，不再次修改有效策略。</span>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="border-b border-border text-xs uppercase tracking-wider text-text-muted">
              <tr>
                <th class="p-2 text-left">#</th>
                <th class="p-2 text-left">来源</th>
                <th class="p-2 text-left">题目</th>
                <th class="p-2 text-left">目标版本</th>
                <th class="p-2 text-left">状态</th>
                <th class="p-2 text-left">说明</th>
                <th class="p-2 text-left">新提交</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in jobItems" :key="item.id" class="border-b border-border">
                <td class="p-2 tabular-nums">{{ item.ordinal }}</td>
                <td class="p-2 font-mono text-xs">{{ item.source_kind }}:{{ item.source_id.slice(0, 8) }}…</td>
                <td class="p-2 font-mono text-xs">{{ item.problem_id.slice(0, 8) }}…</td>
                <td class="p-2 font-mono text-xs">{{ item.target_version_id?.slice(0, 8) ?? '—' }}</td>
                <td class="p-2">
                  <UBadge :color="itemStatusColor(item.status)" variant="subtle">{{ item.status }}</UBadge>
                </td>
                <td class="p-2 text-xs text-text-secondary">
                  {{ item.reason_code ?? '' }} {{ item.reason_message ?? '' }}
                </td>
                <td class="p-2 text-xs">
                  <NuxtLink
                    v-if="item.result_submission_id"
                    :to="publicUrl('submission', item.result_submission_id)"
                    class="text-primary no-underline hover:underline"
                  >
                    查看
                  </NuxtLink>
                  <span v-else class="text-text-muted">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <PaginationNav
          v-if="jobItemsTotal > 20"
          :current-page="jobItemsPage"
          :total-pages="Math.ceil(jobItemsTotal / 20)"
          @page-change="(page: number) => loadJob(currentJobId, page)"
        />
      </div>
    </section>
  </div>
</template>
