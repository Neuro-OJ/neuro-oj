<script setup lang="ts">
import { extractApiError } from "~/utils/apiError"
import { type SubmissionListItem, submissionVersionLabel } from "~/utils/submissionFormat"
import { isJobTerminal, useProblemVersions, type UpgradeJobView } from "~/composables/useProblemVersions"
import { problemUrl, publicUrl } from "~/utils/publicIdentifiers"
import { buildDateRangeParams } from "~/utils/submissionDateRange"
import {
  getStatusColor,
  getStatusLabel,
  formatScore,
  formatTime,
  formatMemory,
  getLanguageLabel,
  formatDateTime,
} from "~/utils/submissionFormat"

definePageMeta({
  ssr: false,
})

const route = useRoute()
const { api } = useApi()
const { isLoggedIn, loading } = useAuth()
const { t, locale } = useI18n()

// 认证守卫：未登录跳转到 /login
useRequireLogin()

/**
 * 题目详情页「全部提交」入口带来的预筛选（#511）。
 * `?problem_id=<uuid>` 由 `MySubmissionCard` 构造；此处仅透传给后端，
 * 不做额外校验（后端按 UUID 精确匹配，非法值只会得到空列表）。
 */
const presetProblemId = computed(() => {
  const value = route.query.problem_id
  return typeof value === 'string' ? value : ''
})

// 列表数据
const submissions = ref<SubmissionListItem[]>([])
const tableLoading = ref(true)
const tableError = ref("")
const currentPage = ref(1)
const totalPages = ref(1)
const perPage = 20

// 筛选条件
const filters = reactive({
  problem_search: "",
  problem_id: presetProblemId.value,
  submission_id: "",
  language: undefined as string | undefined,
  status: undefined as string | undefined,
  // 版本与有效性筛选（Handbook §4.4）：提交时版本来源 / 仅可升级 / 仅有效成绩
  version_origin: undefined as string | undefined,
  upgradable: false,
  valid_only: false,
  // 本地日期 YYYY-MM-DD，发请求前换算为 UTC ISO（#581）
  from_date: "",
  to_date: "",
})

// 语言选项
const languageOptions = [
  { value: "python3", label: "Python 3" },
  { value: "python", label: "Python" },
  { value: "cpp", label: "C++" },
  { value: "c", label: "C" },
  { value: "javascript", label: "JavaScript" },
]

// 版本来源选项（提交时版本）
const versionOriginOptions = computed(() => [
  { value: "known", label: "已知版本" },
  { value: "legacy_unknown", label: "未知历史版本" },
])

// 状态选项
const statusOptions = computed(() => [
  { value: "pending", label: t('submission.pending') },
  { value: "judging", label: t('submission.judging') },
  { value: "finished", label: t('submission.finished') },
  { value: "error", label: t('submission.error') },
])

function buildQuery(page: number): string {
  const params = new URLSearchParams()
  params.set("page", String(page))
  params.set("per_page", String(perPage))
  if (filters.problem_id) params.set("problem_id", filters.problem_id)
  if (filters.problem_search) params.set("problem_search", filters.problem_search)
  if (filters.submission_id) params.set("submission_id", filters.submission_id)
  if (filters.language) params.set("language", filters.language)
  if (filters.status) params.set("status", filters.status)
  if (filters.version_origin) params.set("version_origin", filters.version_origin)
  if (filters.upgradable) params.set("upgradable", "1")
  if (filters.valid_only) params.set("valid_only", "1")
  const { from, to } = buildDateRangeParams(filters.from_date, filters.to_date)
  if (from) params.set("from", from)
  if (to) params.set("to", to)
  return params.toString()
}

async function loadSubmissions(page = 1) {
  if (!isLoggedIn.value) return
  tableLoading.value = true
  tableError.value = ""
  currentPage.value = page
  try {
    const res = await api.get<{ data: SubmissionListItem[]; pagination: { total: number; total_pages: number } }>(
      `/api/v1/submissions?${buildQuery(page)}`,
      { silent: true },
    )
    submissions.value = res.data
    totalPages.value = res.pagination.total_pages
  } catch (err: unknown) {
    tableError.value = extractApiError(err, locale.value).message
  } finally {
    tableLoading.value = false
  }
}

watch(isLoggedIn, (val) => {
  if (val) loadSubmissions()
}, { immediate: true })

function onPageChange(page: number) {
  loadSubmissions(page)
}

function applyFilters() {
  loadSubmissions(1)
}

// ── 用户批量升级（Handbook §4.4）──
const { acceptUpgradeJob, getUpgradeJob } = useProblemVersions()
/** 批量上限（服务端同样校验）：单次最多 500 条。 */
const UPGRADE_BATCH_LIMIT = 500
const selectedIds = ref<Set<string>>(new Set())
const upgrading = ref(false)
const upgradeError = ref("")
const upgradeJob = ref<UpgradeJobView | null>(null)

/** 当前页中可勾选的提交（后端 `upgradable` 筛选给出候选；前端不重复推断）。 */
const selectableIds = computed(() => submissions.value.map((sub) => sub.id))
const allSelected = computed(() =>
  selectableIds.value.length > 0 &&
  selectableIds.value.every((id) => selectedIds.value.has(id))
)

function toggleSelect(id: string) {
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedIds.value = next
}

function toggleSelectAll() {
  selectedIds.value = allSelected.value ? new Set() : new Set(selectableIds.value)
}

/** 升级任务失败/跳过条目的原因统计（供用户判断哪些提交没能升级）。 */
const upgradeIssues = computed(() => {
  const items = upgradeJob.value?.items ?? []
  const counts = new Map<string, number>()
  for (const item of items) {
    if (item.status === 'succeeded' || item.status === 'dispatched' || item.status === 'pending' || item.status === 'preparing') continue
    const key = item.reason_code ?? item.status
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()].map(([code, count]) => ({ code, count }))
})

async function submitUpgrade() {
  if (upgrading.value) return
  const ids = [...selectedIds.value]
  if (ids.length === 0) {
    upgradeError.value = "请先勾选要升级的提交"
    return
  }
  if (ids.length > UPGRADE_BATCH_LIMIT) {
    upgradeError.value = `单次最多升级 ${UPGRADE_BATCH_LIMIT} 条，请减少勾选数量`
    return
  }
  upgradeError.value = ""
  upgrading.value = true
  upgradeJob.value = null
  try {
    const accepted = await acceptUpgradeJob(
      ids.map((id) => ({ kind: "submission" as const, id })),
    )
    // 受理后轮询任务到终态：条目状态由持久化数据聚合，刷新页面也能自愈
    let job = await getUpgradeJob(accepted.job_id)
    const deadline = Date.now() + 120_000
    while (!isJobTerminal(job.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      job = await getUpgradeJob(accepted.job_id)
    }
    upgradeJob.value = job
    selectedIds.value = new Set()
    await loadSubmissions(1)
  } catch (err: unknown) {
    upgradeError.value = extractApiError(err, locale.value).message
  } finally {
    upgrading.value = false
  }
}

function clearFilters() {
  filters.problem_search = ""
  filters.problem_id = ""
  filters.submission_id = ""
  filters.language = undefined
  filters.status = undefined
  filters.version_origin = undefined
  filters.upgradable = false
  filters.valid_only = false
  filters.from_date = ""
  filters.to_date = ""
  selectedIds.value = new Set()
  loadSubmissions(1)
}

// 根据提交状态判断是否有评测结果可展示（类型守卫，收窄后模板可直接访问 result 字段）
function hasResult(
  item: SubmissionListItem,
): item is SubmissionListItem & { result: NonNullable<SubmissionListItem['result']> } {
  return !!(item.result && item.result.status)
}
</script>

<template>
  <div class="py-8">
    <div class="mx-auto max-w-[960px] px-4 sm:px-7">
      <!-- 页面标题 -->
      <div class="mb-6">
        <h1 class="m-0 text-2xl font-bold text-text">{{ t('submission.title') }}</h1>
        <p class="m-0 mt-1 text-sm text-text-secondary">{{ t('submission.subtitle') }}</p>
      </div>

      <!-- 筛选栏 -->
      <div class="mb-4 rounded-lg border border-border bg-white p-4">
        <div class="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div class="flex min-w-[140px] flex-1 flex-col gap-1">
            <label class="text-xs font-semibold text-text-secondary">{{ t('submission.problem') }}</label>
            <input
              v-model="filters.problem_search"
              class="rounded border border-border bg-white px-2.5 py-1.5 text-13px text-text outline-none transition-colors duration-150 focus:border-primary focus:ring-2 focus:ring-primary/10"
              :placeholder="t('submission.problemPlaceholder')"
              @keyup.enter="applyFilters"
            />
          </div>
          <div class="flex min-w-[140px] flex-1 flex-col gap-1">
            <label class="text-xs font-semibold text-text-secondary">{{ t('submission.id') }}</label>
            <input
              v-model="filters.submission_id"
              class="rounded border border-border bg-white px-2.5 py-1.5 text-13px text-text outline-none transition-colors duration-150 focus:border-primary focus:ring-2 focus:ring-primary/10"
              :placeholder="t('submission.idPlaceholder')"
              @keyup.enter="applyFilters"
            />
          </div>
          <div class="flex min-w-[140px] flex-1 flex-col gap-1">
            <label class="text-xs font-semibold text-text-secondary">{{ t('submission.language') }}</label>
            <USelect v-model="filters.language" :items="languageOptions" :placeholder="t('common.all')" class="min-w-[140px]" @change="applyFilters" />
          </div>
          <div class="flex min-w-[140px] flex-1 flex-col gap-1">
            <label class="text-xs font-semibold text-text-secondary">{{ t('submission.status') }}</label>
            <USelect v-model="filters.status" :items="statusOptions" :placeholder="t('common.all')" class="min-w-[140px]" @change="applyFilters" />
          </div>
          <div class="flex min-w-[140px] flex-1 flex-col gap-1">
            <label class="text-xs font-semibold text-text-secondary">作答版本</label>
            <USelect v-model="filters.version_origin" :items="versionOriginOptions" :placeholder="t('common.all')" class="min-w-[140px]" @change="applyFilters" />
          </div>
          <div class="flex min-w-[140px] flex-1 flex-col justify-end gap-1">
            <label class="flex cursor-pointer items-center gap-2 text-xs font-semibold text-text-secondary">
              <input v-model="filters.upgradable" type="checkbox" class="size-3.5 accent-primary" @change="applyFilters" />
              仅显示可升级（不是最新版）
            </label>
            <label class="flex cursor-pointer items-center gap-2 text-xs font-semibold text-text-secondary">
              <input v-model="filters.valid_only" type="checkbox" class="size-3.5 accent-primary" @change="applyFilters" />
              仅显示有效成绩
            </label>
          </div>
          <div class="flex min-w-[140px] flex-1 flex-col gap-1">
            <label for="submission-from-date" class="text-xs font-semibold text-text-secondary">{{ t('submission.fromDate') }}</label>
            <input
              id="submission-from-date"
              v-model="filters.from_date"
              type="date"
              :max="filters.to_date || undefined"
              class="rounded border border-border bg-white px-2.5 py-1.5 text-13px tabular-nums text-text outline-none transition-colors duration-150 focus:border-primary focus:ring-2 focus:ring-primary/10"
              @change="applyFilters"
            />
          </div>
          <div class="flex min-w-[140px] flex-1 flex-col gap-1">
            <label for="submission-to-date" class="text-xs font-semibold text-text-secondary">{{ t('submission.toDate') }}</label>
            <input
              id="submission-to-date"
              v-model="filters.to_date"
              type="date"
              :min="filters.from_date || undefined"
              class="rounded border border-border bg-white px-2.5 py-1.5 text-13px tabular-nums text-text outline-none transition-colors duration-150 focus:border-primary focus:ring-2 focus:ring-primary/10"
              @change="applyFilters"
            />
          </div>
        </div>
        <p v-if="filters.problem_id" class="mb-3 flex items-center gap-2 text-xs text-text-secondary">
          <UIcon name="i-lucide-filter" class="size-3.5" />
          已按题目筛选
          <UButton color="neutral" variant="outline" size="xs" class="border-border text-text-secondary" @click="clearFilters">
            {{ t('common.clear') }}
          </UButton>
        </p>
        <div class="flex gap-2">
          <UButton color="primary" size="sm" class="px-3.5 leading-none" @click="applyFilters">
            <UIcon name="i-lucide-search" class="size-3.5" />
            {{ t('submission.filter') }}
          </UButton>
          <UButton color="neutral" variant="outline" size="sm" class="border-border px-3.5 leading-none text-text-secondary hover:border-text-secondary hover:text-text" @click="clearFilters">
            <UIcon name="i-lucide-x" class="size-3.5" />
            {{ t('common.clear') }}
          </UButton>
        </div>
      </div>

      <!-- 批量升级（Handbook §4.4）：把旧版本提交升级到最新版，生成新提交并保留原成绩 -->
      <div class="mb-4 rounded-lg border border-border bg-white p-4">
        <div class="flex flex-wrap items-center gap-3">
          <UButton
            color="primary"
            size="sm"
            class="px-3.5 leading-none"
            :loading="upgrading"
            :disabled="upgrading || selectedIds.size === 0"
            @click="submitUpgrade"
          >
            <UIcon name="lucide:arrow-up-circle" class="size-3.5" />
            批量升级到最新版（已选 {{ selectedIds.size }}）
          </UButton>
          <UButton
            v-if="selectedIds.size > 0"
            color="neutral"
            variant="outline"
            size="sm"
            class="border-border px-3.5 leading-none text-text-secondary"
            @click="selectedIds = new Set()"
          >
            取消选择
          </UButton>
          <span class="text-xs text-text-muted">
            升级会为每条提交按最新版新建一次提交（原提交与原成绩保留）；单次最多 {{ UPGRADE_BATCH_LIMIT }} 条。
          </span>
        </div>
        <p v-if="upgradeError" class="mt-2 text-xs text-error-text">{{ upgradeError }}</p>
        <div v-if="upgradeJob" class="mt-3 flex flex-col gap-1 text-xs">
          <p class="text-text-secondary">
            任务 <span class="font-mono">{{ upgradeJob.id }}</span> 状态：{{ upgradeJob.status }}
            （成功 {{ upgradeJob.items.filter((item) => item.status === 'succeeded').length }} /
            共 {{ upgradeJob.items.length }}）
          </p>
          <ul v-if="upgradeIssues.length" class="ml-4 list-disc text-text-muted">
            <li v-for="issue in upgradeIssues" :key="issue.code">
              {{ issue.code }} × {{ issue.count }}
            </li>
          </ul>
        </div>
      </div>

      <!-- 加载态 -->
      <TableSkeleton v-if="tableLoading" :rows="8" :columns="['w-4', 'w-20', 'flex-1', 'w-16', 'w-16', 'w-24', 'w-12', 'w-12', 'w-12', 'w-28', 'w-16']" />

      <!-- 错误态 -->
      <div v-else-if="tableError" class="flex flex-col items-center justify-center gap-3 rounded-lg border border-border bg-white px-6 py-16 text-sm text-red-600">
        <span>{{ tableError }}</span>
        <UButton color="primary" size="sm" class="px-3.5 leading-none" @click="loadSubmissions(currentPage)">
          {{ t('common.retry') }}
        </UButton>
      </div>

      <!-- 空态 -->
      <div v-else-if="submissions.length === 0" class="flex flex-col items-center justify-center gap-3 rounded-lg border border-border bg-white px-6 py-16 text-sm text-text-secondary">
        <span>{{ t('submission.empty') }}</span>
      </div>

      <!-- 表格 -->
      <div v-else class="overflow-x-auto rounded-lg border border-border bg-white">
        <table class="w-full border-collapse">
          <thead>
            <tr>
              <th class="w-[40px] border-b border-border bg-bg-page px-3.5 py-3 text-left">
                <input
                  type="checkbox"
                  class="size-3.5 accent-primary"
                  :checked="allSelected"
                  :disabled="selectableIds.length === 0"
                  aria-label="全选本页提交"
                  @change="toggleSelectAll"
                />
              </th>
              <th class="w-[100px] whitespace-nowrap border-b border-border bg-bg-page px-3.5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-text-muted">{{ t('submission.id') }}</th>
              <th class="whitespace-nowrap border-b border-border bg-bg-page px-3.5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-text-muted">{{ t('submission.problem') }}</th>
              <th class="whitespace-nowrap border-b border-border bg-bg-page px-3.5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-text-muted">{{ t('submission.language') }}</th>
              <th class="w-[90px] whitespace-nowrap border-b border-border bg-bg-page px-3.5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-text-muted">作答版本</th>
              <th class="whitespace-nowrap border-b border-border bg-bg-page px-3.5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-text-muted">{{ t('submission.status') }}</th>
              <th class="w-[70px] whitespace-nowrap border-b border-border bg-bg-page px-3.5 py-3 text-right text-xs font-semibold uppercase tracking-wider text-text-muted">{{ t('submission.score') }}</th>
              <th class="w-[70px] whitespace-nowrap border-b border-border bg-bg-page px-3.5 py-3 text-right text-xs font-semibold uppercase tracking-wider text-text-muted">{{ t('submission.time') }}</th>
              <th class="w-[70px] whitespace-nowrap border-b border-border bg-bg-page px-3.5 py-3 text-right text-xs font-semibold uppercase tracking-wider text-text-muted">{{ t('submission.memory') }}</th>
              <th class="whitespace-nowrap border-b border-border bg-bg-page px-3.5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-text-muted">{{ t('submission.createdAt') }}</th>
              <th class="w-[80px] whitespace-nowrap border-b border-border bg-bg-page px-3.5 py-3 text-center text-xs font-semibold uppercase tracking-wider text-text-muted">{{ t('submission.action') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="sub in submissions" :key="sub.id" class="border-b border-border transition-colors duration-150 last:border-b-0 hover:bg-bg-page">
              <td class="px-3.5 py-3">
                <input
                  type="checkbox"
                  class="size-3.5 accent-primary"
                  :checked="selectedIds.has(sub.id)"
                  :aria-label="`选择提交 ${sub.public_id || sub.id}`"
                  @change="toggleSelect(sub.id)"
                />
              </td>
              <td class="px-3.5 py-3 font-mono text-xs text-text-secondary">{{ sub.public_id || sub.id.slice(0, 8) }}...</td>
              <td class="px-3.5 py-3 text-13px text-text">
                <NuxtLink :to="problemUrl(sub.problem_id, sub.problem.display_id)" class="font-medium text-primary no-underline hover:underline">
                  {{ sub.problem.title || sub.problem_id }}
                </NuxtLink>
              </td>
              <td class="px-3.5 py-3 text-13px text-text">{{ getLanguageLabel(sub.language) }}</td>
              <!-- 提交时版本：换版后旧提交仍能看出当时在评哪一版（未知历史版本显式标注） -->
              <td class="px-3.5 py-3 text-13px">
                <UBadge
                  :color="sub.submitted_version != null ? 'primary' : 'neutral'"
                  variant="subtle"
                  size="sm"
                >
                  {{ submissionVersionLabel(sub) }}
                </UBadge>
              </td>
              <td class="px-3.5 py-3 text-13px text-text">
                <span
                  class="inline-block whitespace-nowrap rounded px-2 py-0.5 text-xs font-semibold"
                  :style="{
                    background: getStatusColor(sub.status, sub.result?.status) + '18',
                    color: getStatusColor(sub.status, sub.result?.status),
                  }"
                >
                  {{ getStatusLabel(sub.status, sub.result?.status, locale) }}
                </span>
              </td>
              <td class="px-3.5 py-3 text-right text-13px tabular-nums text-text">
                <template v-if="hasResult(sub)">{{ formatScore(sub.result.score) }}</template>
                <template v-else>--</template>
              </td>
              <td class="px-3.5 py-3 text-right text-13px tabular-nums text-text">
                <template v-if="hasResult(sub)">{{ formatTime(sub.result.time_ms) }}</template>
                <template v-else>--</template>
              </td>
              <td class="px-3.5 py-3 text-right text-13px tabular-nums text-text">
                <template v-if="hasResult(sub)">{{ formatMemory(sub.result.memory_kb) }}</template>
                <template v-else>--</template>
              </td>
              <td class="px-3.5 py-3 text-13px text-text">{{ formatDateTime(sub.created_at) }}</td>
              <td class="px-3.5 py-3 text-center text-13px text-text">
                <NuxtLink :to="publicUrl('submission', sub.public_id || sub.id)" class="inline-flex cursor-pointer items-center gap-1 rounded border border-primary bg-transparent px-2.5 py-1 text-xs font-semibold leading-none text-primary no-underline transition-all duration-150 hover:bg-primary hover:text-white">
                  {{ t('common.view') }}
                </NuxtLink>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 分页 -->
      <PaginationNav
        :current-page="currentPage"
        :total-pages="totalPages"
        @page-change="onPageChange"
      />
    </div>
  </div>
</template>
