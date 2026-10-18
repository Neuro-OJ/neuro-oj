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

})

useRequireLogin()

const { api } = useApi()
const toast = useToast()
const { acceptRejudgeJob, getJob, listJobItems, retryJob } = useProblemVersions()

// ── 受理表单 ──
const scopeType = ref<'selected' | 'problem' | 'contest'>('problem')
const selectedIds = ref('')
/** 手选提交的默认类型（缺陷 #54②）；单条可用 `objective:` / `submission:` 前缀覆盖。 */
const selectedKind = ref<'submission' | 'objective'>('submission')
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

/** 内部 UUID 判定：只有 UUID 才直接当 ID 使用，其余一律先解析（题号 / 公开 ID）。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** 版本列表单页上限（core 分页上限 100）。 */
const VERSION_PAGE_SIZE = 100
/** 版本分页遍历的防御性上限，避免服务端 total 异常时死循环。 */
const MAX_VERSION_PAGES = 200
/** 外部标识解析后的内部 ID 提示（题号 / 公开 ID → UUID）。 */
const resolvedNote = ref('')

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

/**
 * 外部标识 → 内部 UUID（缺陷 #54③）。
 *
 * 输入框接受题号（`P1001` / `U42` / 纯数字）等外部标识，但受理服务按内部 ID
 * 查询；直接下发会得到零条任务的「成功」受理。这里统一先解析成 UUID，解析失败
 * 明确报错，绝不静默发起受理。
 */
async function resolveProblemInternalId(input: string): Promise<string> {
  const value = input.trim()
  if (UUID_RE.test(value)) return value
  try {
    const res = await api.get<{ data: { id: string } }>(
      `/api/v1/problems/${encodeURIComponent(value)}`,
      { silent: true },
    )
    if (!res.data?.id) throw new Error('未返回题目 ID')
    return res.data.id
  } catch (err: unknown) {
    throw new Error(`无法解析题目「${value}」：${extractApiError(err).message}`)
  }
}

/** 竞赛外部标识（公开 ID）→ 内部 UUID（core 的 `/contests/:id` 支持 public_id）。 */
async function resolveContestInternalId(input: string): Promise<string> {
  const value = input.trim()
  if (UUID_RE.test(value)) return value
  try {
    const res = await api.get<{ data: { id: string } }>(
      `/api/v1/contests/${encodeURIComponent(value)}`,
      { silent: true },
    )
    if (!res.data?.id) throw new Error('未返回竞赛 ID')
    return res.data.id
  } catch (err: unknown) {
    throw new Error(`无法解析竞赛「${value}」：${extractApiError(err).message}`)
  }
}

/**
 * 读取某题指定版本号的版本 ID。
 *
 * 必须遍历**全部分页**：只查第一页（100 条）会把排在第 101 位之后的老版本误判为
 * 不存在，进而取消整次受理（缺陷 #54①）。
 */
async function findVersionIdByNumber(
  problemId: string,
  versionNumber: number,
): Promise<string | null> {
  for (let page = 1; page <= MAX_VERSION_PAGES; page += 1) {
    const res = await api.get<{
      data: Array<{ id: string; version: number }>
      total: number
      per_page: number
    }>(
      `/api/v1/problems/${problemId}/versions?page=${page}&per_page=${VERSION_PAGE_SIZE}`,
      { silent: true },
    )
    const match = res.data.find((v) => v.version === versionNumber)
    if (match) return match.id
    const size = res.per_page || VERSION_PAGE_SIZE
    const loaded = (page - 1) * size + res.data.length
    // 已取完（或本页为空，服务端数据异常）→ 该题确实没有这个版本号
    if (res.data.length === 0 || loaded >= res.total) return null
  }
  return null
}

/** 展开「全部用 V<n>」为逐题版本映射；任一所涉题目缺少该版本号即失败。 */
async function expandVersionNumber(problemIds: string[], versionNumber: number): Promise<Record<string, string>> {
  const mapping: Record<string, string> = {}
  const missing: string[] = []
  for (const problemId of problemIds) {
    const versionId = await findVersionIdByNumber(problemId, versionNumber)
    if (versionId) mapping[problemId] = versionId
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
  // 手选：逐条读取提交详情以取得题目（上限 500，受理前先做数量校验）。
  // 客观题提交详情返回的是 `paper_id`（套卷题目 ID），普通提交返回 `problem_id`
  // （缺陷 #54②：此前只读 problem_id，客观题会取到 undefined）。
  const ids = new Set<string>()
  for (const item of scope.submissions) {
    const res = await api.get<{ data: { problem_id?: string; paper_id?: string } }>(
      item.kind === 'submission'
        ? `/api/v1/submissions/${item.id}`
        : `/api/v1/problems/submissions/${item.id}`,
      { silent: true },
    )
    const problemId = res.data.problem_id ?? res.data.paper_id
    if (!problemId) {
      throw new Error(`提交 ${item.kind}:${item.id} 未返回所属题目，无法展开目标版本`)
    }
    ids.add(problemId)
  }
  return [...ids]
}

/**
 * 解析手选提交列表（缺陷 #54②）。
 *
 * 支持三类写法，互不冲突：
 * - 裸 ID（沿用「提交类型」选择器的默认值，默认普通提交）；
 * - `submission:<提交 ID>` / `objective:<客观题提交 ID>` 前缀，可在一份列表里混排；
 * - 其它含冒号的输入原样当作 ID（避免把 UUID 之外的合法值切坏）。
 */
function parseSelectedIds(
  defaultKind: 'submission' | 'objective' = 'submission',
): Array<{ kind: 'submission' | 'objective'; id: string }> {
  return selectedIds.value
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((token) => {
      const separator = token.indexOf(':')
      if (separator > 0) {
        const prefix = token.slice(0, separator).toLowerCase()
        const rest = token.slice(separator + 1).trim()
        if (rest && (prefix === 'submission' || prefix === 'objective')) {
          return { kind: prefix, id: rest }
        }
      }
      return { kind: defaultKind, id: token }
    })
}

async function submitJob() {
  if (submitting.value) return
  submitError.value = ''
  expansionNote.value = ''
  resolvedNote.value = ''
  submitting.value = true
  try {
    let scope: RejudgeScope
    if (scopeType.value === 'problem') {
      const raw = scopeProblemId.value.trim()
      if (!raw) throw new Error('请输入题目 ID / 题号')
      // 题号 / 公开标识先解析为内部 UUID（缺陷 #54③）
      const problemId = await resolveProblemInternalId(raw)
      if (problemId !== raw) resolvedNote.value = `已解析题目「${raw}」→ ${problemId}`
      scope = { type: 'problem', problem_id: problemId }
    } else if (scopeType.value === 'contest') {
      const raw = scopeContestId.value.trim()
      if (!raw) throw new Error('请输入竞赛 ID / 公开 ID')
      const contestId = await resolveContestInternalId(raw)
      if (contestId !== raw) resolvedNote.value = `已解析竞赛「${raw}」→ ${contestId}`
      scope = { type: 'contest', contest_id: contestId }
    } else {
      const submissions = parseSelectedIds(selectedKind.value)
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
            placeholder="每行一条提交 ID（支持逗号/空格分隔；客观题写 objective:<提交 ID>）"
          />
          <div v-if="scopeType === 'selected'" class="flex flex-col gap-1.5">
            <USelect
              v-model="selectedKind"
              :items="[
                { value: 'submission', label: '默认普通提交（submission）' },
                { value: 'objective', label: '默认客观题提交（objective）' },
              ]"
              class="min-w-[220px]"
            />
            <p class="text-11px text-text-muted">
              客观题提交必须按 <code class="font-mono">objective:&lt;提交 ID&gt;</code> 处理（可用上方默认类型，或在行内写前缀）。
              受理范围会按类型分别读取所属题目（客观题为套卷题目）。
            </p>
          </div>
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
        <span v-if="resolvedNote" class="font-mono text-11px text-text-muted">{{ resolvedNote }}</span>
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
