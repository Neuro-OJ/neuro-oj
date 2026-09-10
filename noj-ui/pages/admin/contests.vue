<script setup lang="ts">
import { extractApiError, isNetworkError } from '~/utils/apiError'
import type { AdminColumn } from "~/components/admin/AdminTable.vue"
import type {
  AdminContestDetail,
  AdminProblemOption,
  Contest,
  ContestPayload,
  Pagination,
  ContestAntiCheatGroup,
  ContestAntiCheatTimelineItem,
} from '~/composables/useContests'
import { useToast } from '~/composables/useToast'
import { runContestMutation } from '~/utils/contestMutation'

definePageMeta({ layout: 'admin', middleware: 'admin', ssr: false })

const { typeLabels, statusLabels, formatDateTime, statusClass, listAntiCheatGroups, listAntiCheatTimeline } = useContests()
const { toast } = useToast()
const { dialog } = useDialog()
const { api } = useApi()
const contests = ref<Contest[]>([])
const problems = ref<AdminProblemOption[]>([])
const loading = ref(true)
const loadError = ref('')
const currentPage = ref(1)
const totalPages = ref(0)
const formOpen = ref(false)
const editingContest = ref<AdminContestDetail | null>(null)
const saving = ref(false)
const formError = ref('')
const editingId = ref<string | null>(null)
let contestRequestVersion = 0
const antiCheatContest = ref<Contest | null>(null)
const antiCheatGroups = ref<ContestAntiCheatGroup[]>([])
const antiCheatTimeline = ref<ContestAntiCheatTimelineItem[]>([])
const antiCheatIp = ref('')
const antiCheatLoading = ref(false)
const antiCheatError = ref('')
interface SettlementItem {
  submission_id: string
  user_id: string
  username: string
  problem_id: string
  problem_title: string
  status: string
  result_status: string | null
  created_at: string
  kind: 'submission' | 'objective'
}
interface SettlementStatus {
  contest_status: Contest['status']
  pending_count: number
  failed_count: number
  ready: boolean
  items: SettlementItem[]
  truncated: boolean
}
/** 正式成绩版本元数据（列表接口不返回 rows；导出具体版本时才取完整数据）。 */
interface RankingSnapshotMeta {
  id: string
  version: number
  status: string
  note: string
  created_by: string | null
  created_at: string
}
const settlementContest = ref<Contest | null>(null)
const settlement = ref<SettlementStatus | null>(null)
const settlementLoading = ref(false)
const settlementNote = ref('')
const settlementAllowFailed = ref(false)
/** 版本历史，用于导出**历史版本**成绩（此前 UI 只能导出最新版）。 */
const snapshotVersions = ref<RankingSnapshotMeta[]>([])
const snapshotVersionsLoading = ref(false)

// 自动轮询间隔（默认 30s，可由刷新控制条切换/关闭；竞赛状态/人数随刷新更新）
const pollInterval = ref<number | null>(30000)
const lastRefresh = ref<Date | null>(null)

const columns: AdminColumn[] = [
  { key: 'title', label: '竞赛' },
  { key: 'type', label: '赛制' },
  { key: 'status', label: '状态' },
  { key: 'start_time', label: '开始时间' },
  { key: 'participant_count', label: '参赛者' },
  { key: 'problem_count', label: '题目' },
  { key: 'actions', label: '操作' },
]

function contestInfo(message: string, details?: unknown) {
  if (!import.meta.dev) return
  console.info(`[contest-save] ${message}`, details)
}

function contestError(message: string, details?: unknown) {
  if (!import.meta.dev) return
  console.error(`[contest-save] ${message}`, details)
}

/** silent=true 用于轮询：不置 loading、不清错误，失败保留旧数据 */
async function loadContests(page = currentPage.value, silent = false): Promise<boolean> {
  const currentRequest = ++contestRequestVersion
  if (!silent) {
    loading.value = true
    loadError.value = ''
  }
  try {
    const response = await api.get<{ data: Contest[]; pagination: Pagination }>(`/api/v1/admin/contest/contests?page=${page}&per_page=20`, { silent: true })
    if (currentRequest !== contestRequestVersion) return true
    contests.value = response.data
    currentPage.value = response.pagination.page
    totalPages.value = response.pagination.total_pages
    lastRefresh.value = new Date()
    return true
  } catch (fetchError: unknown) {
    if (currentRequest !== contestRequestVersion) return true
    if (!silent) loadError.value = extractApiError(fetchError).message
    return false
  } finally {
    // 无条件复位：避免轮询抢占 requestVersion 后 loading 卡死
    if (currentRequest === contestRequestVersion) loading.value = false
  }
}

let problemRequestVersion = 0

async function loadProblems(keyword = '') {
  const currentRequest = ++problemRequestVersion
  try {
    const response = await api.get<{ data: AdminProblemOption[] }>(`/api/v1/admin/catalog/problems?page=1&limit=20&keyword=${encodeURIComponent(keyword)}`, { silent: true })
    if (currentRequest !== problemRequestVersion) return
    problems.value = response.data
  } catch {
    if (currentRequest === problemRequestVersion) problems.value = []
  }
}

async function openAntiCheat(contest: Contest) {
  antiCheatContest.value = contest
  antiCheatGroups.value = []
  antiCheatTimeline.value = []
  antiCheatIp.value = ''
  antiCheatError.value = ''
  antiCheatLoading.value = true
  try {
    const response = await listAntiCheatGroups(contest.public_id || contest.id, { min_accounts: 2, per_page: 100 })
    antiCheatGroups.value = response.data
  } catch (error: unknown) {
    antiCheatError.value = extractApiError(error).message
  } finally {
    antiCheatLoading.value = false
  }
}

async function openAntiCheatTimeline(ip: string) {
  if (!antiCheatContest.value) return
  antiCheatIp.value = ip
  antiCheatError.value = ''
  try {
    const response = await listAntiCheatTimeline(antiCheatContest.value.public_id || antiCheatContest.value.id, ip)
    antiCheatTimeline.value = response.data
  } catch (error: unknown) {
    antiCheatError.value = extractApiError(error).message
  }
}

onMounted(() => {
  void Promise.all([loadContests(1), loadProblems()])
})

// 竞赛状态/人数自动轮询（页面隐藏自动暂停，卸载自动清理）
usePolling({
  intervalMs: pollInterval,
  fetcher: async () => { await loadContests(currentPage.value, true) },
  immediate: false,
})

function openCreate() {
  editingContest.value = null
  formError.value = ''
  formOpen.value = true
}

async function openEdit(contest: Contest) {
  formError.value = ''
  editingId.value = contest.id
  try {
    // silent: 错误由下方 catch 内联处理（toast.error），避免 useApi 默认 toast 双弹
    const response = await api.get<{ data: AdminContestDetail }>(`/api/v1/admin/contest/contests/${contest.public_id || contest.id}`, { silent: true })
    editingContest.value = response.data
    formOpen.value = true
  } catch (err: unknown) {
    formError.value = extractApiError(err).message
    toast.error(extractApiError(err).message)
  } finally {
    editingId.value = null
  }
}

async function recoverCreatedContest(payload: ContestPayload, error: unknown) {
  const errorInfo = extractApiError(error)
  const networkError = isNetworkError(error)
  contestInfo('开始确认网络异常后的保存结果', {
    networkError,
    status: errorInfo.status,
    message: errorInfo.message,
  })
  if (!networkError) {
    contestInfo('非网络错误，不执行保存结果确认')
    return false
  }
  const refreshed = await loadContests(1)
  contestInfo('保存结果确认列表刷新完成', {
    refreshed,
    contestCount: contests.value.length,
  })
  if (!refreshed) return false
  const found = contests.value.some((contest) =>
    contest.title === payload.title &&
    contest.start_time === payload.start_time &&
    contest.end_time === payload.end_time &&
    contest.type === payload.type &&
    contest.problem_count === payload.problems.length
  )
  contestInfo('保存结果确认完成', { found })
  return found
}

async function saveContest(payload: ContestPayload) {
  formError.value = ''
  const contestId = editingContest.value?.public_id || editingContest.value?.id
  const successMessage = contestId ? '竞赛已更新' : '竞赛已创建'
  const context = {
    mode: contestId ? 'update' : 'create',
    contestId,
    title: payload.title,
    type: payload.type,
    startTime: payload.start_time,
    endTime: payload.end_time,
    problemCount: payload.problems.length,
  }
  contestInfo('提交流程开始', context)
  try {
    await runContestMutation({
      isSaving: () => saving.value,
      setSaving: (value) => {
        saving.value = value
      },
      save: async () => {
        contestInfo('保存请求开始', context)
        if (contestId) {
          await api.put(`/api/v1/admin/contest/contests/${contestId}`, payload, {
            headers: editingContest.value?.updated_at ? { "If-Match": `"${editingContest.value.updated_at}"` } : undefined,
          })
        } else {
          await api.post('/api/v1/admin/contest/contests', payload)
        }
        contestInfo('保存请求成功', context)
      },
      recover: contestId ? undefined : (error) => recoverCreatedContest(payload, error),
      onSaved: () => {
        contestInfo('保存结果确定成功，关闭表单', context)
        toast.success(successMessage)
        formOpen.value = false
      },
      refresh: async () => {
        contestInfo('开始刷新竞赛列表', { page: currentPage.value })
        const refreshed = await loadContests(currentPage.value)
        contestInfo('竞赛列表刷新完成', { refreshed, page: currentPage.value })
        return refreshed
      },
      onRefreshFailed: () => {
        contestError('保存成功但竞赛列表刷新失败', context)
        toast.error('竞赛已保存，但竞赛列表刷新失败，请手动刷新')
      },
    })
  } catch (saveError: unknown) {
    const errorInfo = extractApiError(saveError)
    contestError('保存流程失败', {
      ...context,
      status: errorInfo.status,
      code: errorInfo.code,
      requestId: errorInfo.requestId,
      message: errorInfo.message,
      error: saveError,
    })
    formError.value = errorInfo.message
  }
}

async function removeContest(contest: Contest) {
  const confirmed = await dialog.confirm(`确定删除竞赛“${contest.title}”吗？竞赛提交会保留，但将解除竞赛关联。`, { title: '删除竞赛', confirmText: '删除', danger: true })
  if (!confirmed) return
  try {
    // silent: 错误由下方 catch 内联处理（toast.error），避免 useApi 默认 toast 双弹
    await api.delete(`/api/v1/admin/contest/contests/${contest.public_id || contest.id}`, {
      silent: true,
      headers: { "If-Match": `"${contest.updated_at}"` },
    })
    toast.success('竞赛已删除')
    await loadContests(currentPage.value)
  } catch (err: unknown) {
    toast.error(extractApiError(err).message)
  }
}

async function openSettlement(contest: Contest) {
  settlementContest.value = contest
  settlement.value = null
  settlementNote.value = ''
  settlementAllowFailed.value = false
  settlementLoading.value = true
  snapshotVersions.value = []
  try {
    const result = await api.get<{ data: SettlementStatus }>(`/api/v1/admin/contest/contests/${contest.public_id || contest.id}/ranking-snapshots/readiness`, { silent: true })
    settlement.value = result.data
    // 版本历史并行加载：失败不阻断结算检查（导出是次要功能）
    void loadSnapshotVersions(contest)
  } catch (err: unknown) {
    toast.error(extractApiError(err).message)
    settlementContest.value = null
  } finally {
    settlementLoading.value = false
  }
}

/**
 * 载入正式成绩版本历史。
 *
 * 该列表接口刻意不返回 rows（控响应体大小），因此这里只取元数据；
 * 导出某个版本时再由服务端按版本取完整数据。
 */
async function loadSnapshotVersions(contest: Contest) {
  snapshotVersionsLoading.value = true
  try {
    const result = await api.get<{ data: RankingSnapshotMeta[] }>(
      `/api/v1/admin/contest/contests/${contest.public_id || contest.id}/ranking-snapshots`,
      { silent: true },
    )
    snapshotVersions.value = result.data
  } catch {
    // 静默失败：不干扰结算与发布主流程
    snapshotVersions.value = []
  } finally {
    snapshotVersionsLoading.value = false
  }
}

/**
 * 导出指定版本的正式成绩（CSV 或 JSON）。
 *
 * 与「导出最新版」不同，这里必须显式给出 version —— 历史成绩修订的核对与归档
 * 都需要能取到**当时那一版**的数据，而不是当前最新版。
 */
async function exportSnapshotVersion(contest: Contest, version: number, format: 'csv' | 'json') {
  const base = `/api/v1/admin/contest/contests/${contest.public_id || contest.id}/ranking-snapshots/${version}`
  try {
    // 先探测存在性：404 时给出明确提示，而不是让浏览器下载到一个错误页
    await api.get(base, { silent: true })
    window.location.assign(`${base}.${format}`)
  } catch (err: unknown) {
    toast.error(extractApiError(err).message)
  }
}

async function publishSnapshot() {
  if (!settlementContest.value || !settlement.value) return
  const contest = settlementContest.value
  if (settlement.value.pending_count > 0) {
    toast.error('仍有待处理评测，完成评测后才能发布正式成绩')
    return
  }
  if (settlement.value.failed_count > 0 && (!settlementAllowFailed.value || !settlementNote.value.trim())) {
    toast.error('失败评测需要填写说明，并勾选允许带失败评测发布')
    return
  }
  const confirmed = await dialog.confirm(`确认发布“${contest.title}”当前成绩为正式成绩吗？后续重测将生成新版本，不会覆盖当前快照。`, { title: '确认发布成绩', confirmText: '发布' })
  if (!confirmed) return
  try {
    const result = await api.post<{ data: { version: number } }>(`/api/v1/admin/contest/contests/${contest.public_id || contest.id}/ranking-snapshots`, { note: settlementNote.value.trim() || '管理员确认发布', allow_failed: settlementAllowFailed.value }, { silent: true })
    toast.success(`正式成绩已发布（版本 ${result.data.version}）`)
    settlementContest.value = null
    settlement.value = null
    await loadContests(currentPage.value)
  } catch (err: unknown) {
    toast.error(extractApiError(err).message)
  }
}

async function exportSnapshot(contest: Contest) {
  try {
    await api.get(`/api/v1/admin/contest/contests/${contest.public_id || contest.id}/ranking-snapshots/latest`, { silent: true })
    window.location.assign(`/api/v1/admin/contest/contests/${contest.public_id || contest.id}/ranking-snapshots/latest.csv`)
  } catch (err: unknown) {
    toast.error(extractApiError(err).message)
  }
}

async function makeContestPublic(contest: Contest) {
  const confirmed = await dialog.confirm(`确定将竞赛“${contest.title}”转为公开赛吗？公开后无需邀请码即可报名。`, { title: '转公开赛', confirmText: '转公开赛' })
  if (!confirmed) return
  try {
    await api.patch(`/api/v1/admin/contest/contests/${contest.public_id || contest.id}/kind`, { kind: 'public' }, {
      silent: true,
      headers: { "If-Match": `"${contest.updated_at}"` },
    })
    toast.success('竞赛已转为公开赛')
    await loadContests(currentPage.value)
  } catch (err: unknown) {
    toast.error(extractApiError(err).message)
  }
}

async function resetContestCode(contest: Contest) {
  const confirmed = await dialog.confirm(`确定重置竞赛“${contest.title}”的邀请码吗？旧邀请码将立即失效。`, { title: '重置邀请码', confirmText: '重置' })
  if (!confirmed) return
  try {
    const res = await api.post<{ data: { code: string } }>(
      `/api/v1/admin/contest/contests/${contest.public_id || contest.id}/reset-code`,
      undefined,
      {
        silent: true,
        headers: { "If-Match": `"${contest.updated_at}"` },
      },
    )
    try {
      await navigator.clipboard.writeText(res.data.code)
    } catch {
      // 剪贴板不可用时仍展示邀请码
    }
    toast.success(`新邀请码：${res.data.code}（已复制到剪贴板）`)
    await loadContests(currentPage.value)
  } catch (err: unknown) {
    toast.error(extractApiError(err).message)
  }
}
interface Participant {
  user_id: string
  username: string
  avatar_url: string | null
  registered_at: string
}

interface UserSearchResult {
  id: string
  username: string
  email: string
}

const participantContest = ref<Contest | null>(null)
const participants = ref<Participant[]>([])
const participantLoading = ref(false)
const userQuery = ref('')
const userResults = ref<UserSearchResult[]>([])
const searchingUsers = ref(false)

async function openParticipants(contest: Contest) {
  participantContest.value = contest
  participants.value = []
  userQuery.value = ''
  userResults.value = []
  await loadParticipants()
}

async function loadParticipants() {
  if (!participantContest.value) return
  participantLoading.value = true
  try {
    const response = await api.get<{ data: Participant[] }>(`/api/v1/admin/contest/contests/${participantContest.value.public_id || participantContest.value.id}/participants`, { silent: true })
    participants.value = response.data
  } finally {
    participantLoading.value = false
  }
}

async function searchUsers() {
  if (userQuery.value.trim().length < 2) return
  searchingUsers.value = true
  try {
    const response = await api.get<{
      data: {
        items: Array<{
          entity_id: string
          entity_type: string
          title: string
          metadata: Record<string, unknown>
        }>
      }
    }>(
      `/api/v1/search?q=${encodeURIComponent(userQuery.value.trim())}&type=user`,
    )
    // 排除已是参赛者的用户
    const participantIds = new Set(participants.value.map((p) => p.user_id))
    userResults.value = response.data.items
      .map((item) => ({
        id: item.entity_id,
        username: typeof item.metadata.username === "string"
          ? item.metadata.username
          : "",
        email: typeof item.metadata.email === "string"
          ? item.metadata.email
          : "",
      }))
      .filter((user) => !participantIds.has(user.id))
  } finally {
    searchingUsers.value = false
  }
}

async function addParticipant(user: UserSearchResult) {
  if (!participantContest.value) return
  await api.post(`/api/v1/admin/contest/contests/${participantContest.value.public_id || participantContest.value.id}/participants`, [user.username])
  userResults.value = userResults.value.filter((item) => item.id !== user.id)
  await loadParticipants()
}

async function removeParticipant(participant: Participant) {
  if (!participantContest.value) return
  // NOJ-236：破坏性操作增加二次确认与成功反馈。
  const confirmed = await dialog.confirm(
    `确定移除参赛者“${participant.username}”吗？其竞赛提交关联将一并解除。`,
    { title: '移除参赛者', confirmText: '移除', danger: true },
  )
  if (!confirmed) return
  try {
    await api.delete(
      `/api/v1/admin/contest/contests/${participantContest.value.public_id || participantContest.value.id}/participants/${participant.username}`,
      { silent: true },
    )
    toast.success(`已移除参赛者 ${participant.username}`)
    await loadParticipants()
  } catch (err: unknown) {
    toast.error(extractApiError(err).message)
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <AdminPageHeader title="竞赛管理" description="创建竞赛、配置赛制并管理参赛者">
      <template #actions>
        <div class="flex items-center gap-2">
          <RefreshControl
            v-model:interval="pollInterval"
            :last-refresh="lastRefresh"
            @refresh="loadContests(currentPage)"
          />
          <UButton color="primary" size="sm" @click="openCreate"><UIcon name="i-lucide-plus" class="size-4" />创建竞赛</UButton>
        </div>
      </template>
    </AdminPageHeader>

    <AdminTable
      :columns="columns"
      :items="contests as unknown as Record<string, unknown>[]"
      :loading="loading"
      :error="loadError || undefined"
      :total-pages="totalPages"
      :current-page="currentPage"
      @update:page="loadContests"
    >
      <template #cell="{ row, column }">
        <template v-if="column.key === 'title'">
          <div><div class="font-semibold text-text">{{ (row as unknown as Contest).title }}</div><div class="mt-1 text-xs text-text-muted">{{ (row as unknown as Contest).kind === 'invite' ? '邀请赛' : '公开赛' }}<span v-if="(row as unknown as Contest).has_password"> · {{ (row as unknown as Contest).kind === 'invite' ? '邀请码保护' : '密码保护' }}</span></div></div>
        </template>
        <template v-else-if="column.key === 'type'">
          {{ typeLabels[(row as unknown as Contest).type] }}
        </template>
        <template v-else-if="column.key === 'status'">
          <span class="inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold" :class="statusClass((row as unknown as Contest).status)">{{ statusLabels[(row as unknown as Contest).status] }}</span>
        </template>
        <template v-else-if="column.key === 'start_time'">
          {{ formatDateTime((row as unknown as Contest).start_time) }}
        </template>
        <template v-else-if="column.key === 'participant_count'">
          <span>{{ (row as unknown as Contest).participant_count }} 人</span>
        </template>
        <template v-else-if="column.key === 'problem_count'">
          <span>{{ (row as unknown as Contest).problem_count }} 题</span>
        </template>
      </template>
      <template #actions="{ row }">
        <div class="flex justify-center gap-1.5">
          <UButton color="neutral" variant="outline" class="flex size-9" title="检查结算并发布正式成绩" aria-label="检查结算并发布正式成绩" @click="openSettlement(row as unknown as Contest)"><UIcon name="i-lucide-lock-keyhole" class="size-3.5" /></UButton>
          <UButton color="neutral" variant="outline" class="flex size-9" title="导出正式成绩" aria-label="导出正式成绩" @click="exportSnapshot(row as unknown as Contest)"><UIcon name="i-lucide-download" class="size-3.5" /></UButton>
          <UButton color="neutral" variant="outline" class="flex size-9 border-border text-text-secondary hover:bg-amber-50 hover:text-amber-700" title="风控线索" aria-label="风控线索" @click="openAntiCheat(row as unknown as Contest)"><UIcon name="i-lucide-shield-alert" class="size-3.5" /></UButton>
          <UButton color="neutral" variant="outline" class="flex size-9 border-border text-text-secondary hover:bg-blue-50 hover:text-primary" title="参与者" aria-label="参与者" @click="openParticipants(row as unknown as Contest)"><UIcon name="i-lucide-users" class="size-3.5" /></UButton>
          <UButton color="neutral" variant="outline" class="flex size-9 border-border text-text-secondary hover:bg-primary-bg hover:text-text" title="编辑" aria-label="编辑" :loading="editingId === (row as unknown as Contest).id" :disabled="editingId !== null" @click="openEdit(row as unknown as Contest)"><UIcon name="i-lucide-pencil" class="size-3.5" /></UButton>
          <UButton v-if="(row as unknown as Contest).kind === 'invite'" color="neutral" variant="outline" class="flex size-9 border-border text-text-secondary hover:bg-green-50 hover:text-success-text" title="转公开赛" aria-label="转公开赛" @click="makeContestPublic(row as unknown as Contest)"><UIcon name="i-lucide-globe" class="size-3.5" /></UButton>
          <UButton v-if="(row as unknown as Contest).kind === 'invite'" color="neutral" variant="outline" class="flex size-9 border-border text-text-secondary hover:bg-blue-50 hover:text-primary" title="重置邀请码" aria-label="重置邀请码" @click="resetContestCode(row as unknown as Contest)"><UIcon name="i-lucide-key-round" class="size-3.5" /></UButton>
          <UButton color="neutral" variant="outline" class="flex size-9 border-border text-text-secondary hover:border-error-text/30 hover:bg-red-50 hover:text-error-text" title="删除" aria-label="删除" @click="removeContest(row as unknown as Contest)"><UIcon name="i-lucide-trash-2" class="size-3.5" /></UButton>
        </div>
      </template>
    </AdminTable>
  </div>

  <div v-if="settlementContest" class="fixed inset-0 z-300 flex items-center justify-center bg-black/45 p-4" @click.self="settlementContest = null">
    <div class="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-modal">
      <header class="flex items-center justify-between border-b border-border px-6 py-4"><div><h2 class="text-lg font-bold text-text">结算检查与正式成绩</h2><p class="mt-1 text-xs text-text-muted">{{ settlementContest.title }} · 竞赛结束前禁止发布</p></div><button class="rounded-lg p-2 text-text-secondary hover:bg-primary-hover" @click="settlementContest = null"><UIcon name="i-lucide-x" class="size-4.5" /></button></header>
      <div v-if="settlementLoading" class="py-14 text-center text-sm text-text-muted">正在检查评测状态...</div>
      <template v-else-if="settlement">
        <div class="grid gap-3 border-b border-border bg-bg-page p-5 sm:grid-cols-3"><div class="rounded-xl border border-border bg-white p-3"><div class="text-xs text-text-muted">竞赛状态</div><div class="mt-1 font-semibold text-text">{{ settlement.contest_status === 'ended' ? '已结束' : settlement.contest_status === 'running' ? '进行中' : '未开始' }}</div></div><div class="rounded-xl border border-border bg-white p-3"><div class="text-xs text-text-muted">待处理评测</div><div class="mt-1 font-semibold" :class="settlement.pending_count ? 'text-error-text' : 'text-success-text'">{{ settlement.pending_count }}</div></div><div class="rounded-xl border border-border bg-white p-3"><div class="text-xs text-text-muted">失败评测</div><div class="mt-1 font-semibold" :class="settlement.failed_count ? 'text-amber-700' : 'text-success-text'">{{ settlement.failed_count }}</div></div></div>
        <div class="min-h-0 flex-1 overflow-y-auto p-5"><p v-if="settlement.pending_count" class="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-error-text">待处理评测必须全部完成后才能发布。以下列表展示最多 500 条待处理或失败任务。</p><p v-else-if="settlement.failed_count" class="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">失败评测需要人工处理，或由管理员填写说明并明确允许带失败评测发布。</p><p v-else-if="settlement.contest_status !== 'ended'" class="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">竞赛尚未结束，当前只能查看结算状态，不能发布正式成绩。</p><div v-if="settlement.items.length" class="overflow-x-auto rounded-xl border border-border"><table class="w-full min-w-[680px] text-left text-xs"><thead class="border-b border-border bg-bg-page text-text-muted"><tr><th class="px-3 py-2">用户</th><th class="px-3 py-2">题目</th><th class="px-3 py-2">提交状态</th><th class="px-3 py-2">评测状态</th><th class="px-3 py-2">提交时间</th></tr></thead><tbody><tr v-for="item in settlement.items" :key="`${item.kind}-${item.submission_id}`" class="border-b border-border last:border-0"><td class="px-3 py-2 font-semibold text-text">{{ item.username }}</td><td class="px-3 py-2 text-text-secondary">{{ item.problem_title }}</td><td class="px-3 py-2"><UBadge :color="item.status === 'error' ? 'error' : 'warning'" variant="subtle">{{ item.status }}</UBadge></td><td class="px-3 py-2 text-text-secondary">{{ item.result_status || '缺少结果' }}</td><td class="px-3 py-2 text-text-muted">{{ formatDateTime(item.created_at) }}</td></tr></tbody></table></div><p v-else class="py-8 text-center text-sm text-success-text">所有竞赛评测均已完成，可在竞赛结束后发布。</p><p v-if="settlement.truncated" class="mt-2 text-xs text-text-muted">列表已截断，仅展示前 500 条；计数仍为完整数量。</p></div>
          <!-- 版本历史：导出历史正式成绩（此前 UI 只能导出最新版） -->
          <section class="mt-5 rounded-xl border border-border">
            <header class="flex items-center justify-between border-b border-border px-4 py-3">
              <div>
                <h3 class="text-sm font-bold text-text">正式成绩版本</h3>
                <p class="mt-0.5 text-xs text-text-muted">重测后会生成新版本且不覆盖旧版；此处可导出任一历史版本</p>
              </div>
              <UBadge v-if="snapshotVersions.length" color="neutral" variant="subtle">{{ snapshotVersions.length }} 版</UBadge>
            </header>
            <div v-if="snapshotVersionsLoading" class="px-4 py-6 text-center text-xs text-text-muted">加载中…</div>
            <p v-else-if="!snapshotVersions.length" class="px-4 py-6 text-center text-xs text-text-muted">尚未发布任何正式成绩</p>
            <ul v-else class="divide-y divide-border">
              <li v-for="snapshot in snapshotVersions" :key="snapshot.id" class="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <span class="text-sm font-semibold text-text tabular-nums">第 {{ snapshot.version }} 版</span>
                    <UBadge v-if="snapshot.version === snapshotVersions[0]?.version" color="primary" variant="subtle">最新</UBadge>
                  </div>
                  <p class="mt-0.5 truncate text-xs text-text-muted" :title="snapshot.note">{{ snapshot.note || '（无说明）' }}</p>
                  <p class="mt-0.5 text-xs text-text-muted tabular-nums">{{ formatDateTime(snapshot.created_at) }}</p>
                </div>
                <div class="flex shrink-0 gap-2">
                  <UButton color="neutral" variant="outline" size="xs" icon="i-lucide-table" @click="exportSnapshotVersion(settlementContest!, snapshot.version, 'csv')">CSV</UButton>
                  <UButton color="neutral" variant="outline" size="xs" icon="i-lucide-file-json" @click="exportSnapshotVersion(settlementContest!, snapshot.version, 'json')">JSON</UButton>
                </div>
              </li>
            </ul>
          </section>
        <div class="border-t border-border p-5"><label class="mb-2 block text-xs font-semibold text-text">修订/发布说明（可选；失败评测时必填）</label><textarea v-model="settlementNote" rows="2" class="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-signal" placeholder="例如：已确认失败任务不影响参赛者成绩，按当前结果结算"></textarea><label v-if="settlement.failed_count" class="mt-3 flex items-center gap-2 text-sm text-text-secondary"><input v-model="settlementAllowFailed" type="checkbox" class="size-4 rounded border-border text-primary" />我确认已处理失败评测，并允许带失败评测发布</label><div class="mt-4 flex justify-end gap-2"><UButton color="neutral" variant="outline" @click="settlementContest = null">关闭</UButton><UButton color="primary" :disabled="!settlement.ready || (settlement.failed_count > 0 && (!settlementAllowFailed || !settlementNote.trim()))" @click="publishSnapshot">发布正式成绩</UButton></div></div>
      </template>
    </div>
  </div>

  <div v-if="antiCheatContest" class="fixed inset-0 z-300 flex items-center justify-center bg-black/45 p-4" @click.self="antiCheatContest = null">
    <div class="flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-modal">
      <header class="flex items-center justify-between border-b border-border px-6 py-4"><div><h2 class="text-lg font-bold text-text">竞赛风控线索</h2><p class="mt-1 text-xs text-text-muted">{{ antiCheatContest.title }} · 仅供人工复核，不自动封禁或取消成绩</p></div><button class="rounded-lg p-2 text-text-secondary hover:bg-primary-hover" @click="antiCheatContest = null"><UIcon name="i-lucide-x" class="size-4.5" /></button></header>
      <div class="border-b border-border bg-amber-50 px-6 py-3 text-xs text-amber-800">提交来源 IP 用于竞赛账号关联，默认保留 180 天；仅管理员可见。共享网络、代理和 NAT 可能导致误报，请结合其他证据复核。</div>
      <div class="flex-1 overflow-y-auto p-5"><p v-if="antiCheatError" class="mb-3 text-sm text-error-text">{{ antiCheatError }}</p><p v-if="antiCheatLoading" class="py-12 text-center text-sm text-text-muted">加载中...</p><div v-else-if="antiCheatGroups.length" class="grid gap-4 lg:grid-cols-2"><button v-for="group in antiCheatGroups" :key="group.ip" class="rounded-xl border border-border p-4 text-left transition hover:border-signal" :class="antiCheatIp === group.ip ? 'border-signal bg-signal/5' : ''" @click="openAntiCheatTimeline(group.ip)"><div class="flex items-center justify-between"><code class="font-mono text-sm font-semibold text-text">{{ group.ip }}</code><UBadge color="warning" variant="subtle">{{ group.account_count }} 个账号</UBadge></div><p class="mt-2 text-xs text-text-secondary">{{ group.submission_count }} 次提交 · {{ formatDateTime(group.first_submission_at) }} 至 {{ formatDateTime(group.last_submission_at) }}</p><div class="mt-3 flex flex-wrap gap-1.5"><UBadge v-for="account in group.accounts" :key="account.user_id" color="neutral" variant="subtle">{{ account.username }}（{{ account.submission_count }}）</UBadge></div></button></div><p v-else-if="!antiCheatLoading" class="py-12 text-center text-sm text-text-muted">暂无同 IP 多账号候选组</p><div v-if="antiCheatTimeline.length" class="mt-5 rounded-xl border border-border"><div class="border-b border-border px-4 py-3 text-sm font-semibold text-text">提交时间线：{{ antiCheatIp }}</div><div class="divide-y divide-border"><div v-for="item in antiCheatTimeline" :key="item.submission_id" class="grid grid-cols-[1fr_auto_auto] items-center gap-3 px-4 py-3 text-xs"><span><strong class="text-text">{{ item.username }}</strong><span class="ml-2 text-text-secondary">{{ item.problem_title }} · {{ item.language }}</span></span><span class="text-text-muted">{{ formatDateTime(item.created_at) }}</span><code class="font-mono text-text-muted">{{ item.submission_id.slice(0, 12) }}</code></div></div></div></div>
    </div>
  </div>

  <ContestFormModal v-if="formOpen" :contest="editingContest" :problems="problems" :saving="saving" :error="formError" @save="saveContest" @search-problems="loadProblems" @cancel="formOpen = false" />

  <div v-if="participantContest" class="fixed inset-0 z-300 flex items-center justify-center bg-black/45 p-4" @click.self="participantContest = null">
    <div class="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-modal">
      <header class="flex items-center justify-between border-b border-border px-6 py-4"><div><h2 class="text-lg font-bold text-text">参与者管理</h2><p class="mt-1 text-xs text-text-muted">{{ participantContest.title }} · {{ participants.length }} 人</p></div><button class="rounded-lg p-2 text-text-secondary hover:bg-primary-hover" @click="participantContest = null"><UIcon name="i-lucide-x" class="size-4.5" /></button></header>
      <div class="border-b border-border p-5"><div class="flex gap-2"><input v-model="userQuery" class="min-w-0 flex-1 rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-signal" placeholder="搜索用户名或邮箱" @keyup.enter="searchUsers"><UButton color="primary" size="md" :disabled="searchingUsers" @click="searchUsers"><UIcon name="i-lucide-user-plus" class="size-3.5" />搜索</UButton></div><div v-if="userResults.length" class="mt-2 max-h-36 overflow-y-auto rounded-lg border border-border"><button v-for="user in userResults" :key="user.id" class="flex w-full items-center justify-between border-b border-border px-3 py-2 text-left text-xs last:border-0 hover:bg-primary-bg" @click="addParticipant(user)"><span><strong class="text-text">{{ user.username }}</strong><span class="ml-2 text-text-muted">{{ user.email }}</span></span><UIcon name="i-lucide-plus" class="text-primary size-3.5" /></button></div></div>
      <div class="flex-1 overflow-y-auto p-5"><div v-if="participantLoading" class="py-12 text-center text-sm text-text-muted">加载中...</div><div v-else-if="participants.length" class="divide-y divide-border rounded-xl border border-border"><div v-for="participant in participants" :key="participant.user_id" class="flex items-center gap-3 px-4 py-3"><UserIdentity :user="{ id: participant.user_id, username: participant.username, avatar_url: participant.avatar_url }" size="sm" :link="false" /><div class="min-w-0 flex-1"><div class="truncate text-sm font-semibold text-text">{{ participant.username }}</div><div class="text-xs text-text-muted">{{ formatDateTime(participant.registered_at) }} 报名</div></div><button class="rounded-lg p-2 text-text-muted hover:bg-red-50 hover:text-error-text" title="移除" @click="removeParticipant(participant)"><UIcon name="i-lucide-trash-2" class="size-3.5" /></button></div></div><p v-else class="py-12 text-center text-sm text-text-muted">暂无参与者</p></div>
    </div>
  </div>
</template>
