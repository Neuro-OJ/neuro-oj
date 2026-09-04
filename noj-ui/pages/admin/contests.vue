<script setup lang="ts">
import { extractApiError, isNetworkError } from '~/utils/apiError'
import type {
  AdminContestDetail,
  AdminProblemOption,
  Contest,
  ContestPayload,
  Pagination,
} from '~/composables/useContests'
import { useToast } from '~/composables/useToast'
import { runContestMutation } from '~/utils/contestMutation'

definePageMeta({ layout: 'admin', middleware: 'admin', ssr: false })

const { typeLabels, statusLabels, formatDateTime, statusClass } = useContests()
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

// 自动轮询间隔（默认 30s，可由刷新控制条切换/关闭；竞赛状态/人数随刷新更新）
const pollInterval = ref<number | null>(30000)
const lastRefresh = ref<Date | null>(null)

const columns = [
  { accessorKey: 'title', header: '竞赛' },
  { accessorKey: 'type', header: '赛制', cell: (info) => typeLabels[info.getValue() as Contest['type']] },
  { accessorKey: 'status', header: '状态' },
  { accessorKey: 'start_time', header: '开始时间', cell: (info) => formatDateTime(info.getValue() as string) },
  { accessorKey: 'participant_count', header: '参赛者' },
  { accessorKey: 'problem_count', header: '题目' },

  { accessorKey: "actions", header: "操作" },]

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
    const response = await api.get<{ data: Contest[]; pagination: Pagination }>(`/api/v1/admin/contests?page=${page}&per_page=20`, { silent: true })
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
    const response = await api.get<{ data: AdminProblemOption[] }>(`/api/v1/admin/problems?page=1&limit=20&keyword=${encodeURIComponent(keyword)}`, { silent: true })
    if (currentRequest !== problemRequestVersion) return
    problems.value = response.data
  } catch {
    if (currentRequest === problemRequestVersion) problems.value = []
  }
}

onMounted(() => {
  void Promise.all([loadContests(1), loadProblems()])
})

// 竞赛状态/人数自动轮询（页面隐藏自动暂停，卸载自动清理）
usePolling({
  intervalMs: pollInterval,
  fetcher: () => loadContests(currentPage.value, true),
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
    const response = await api.get<{ data: AdminContestDetail }>(`/api/v1/admin/contests/${contest.public_id || contest.id}`, { silent: true })
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
          await api.put(`/api/v1/admin/contests/${contestId}`, payload)
        } else {
          await api.post('/api/v1/admin/contests', payload)
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
    await api.delete(`/api/v1/admin/contests/${contest.public_id || contest.id}`, { silent: true })
    toast.success('竞赛已删除')
    await loadContests(currentPage.value)
  } catch (err: unknown) {
    toast.error(extractApiError(err).message)
  }
}

interface Participant {
  user_id: string
  username: string
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
    const response = await api.get<{ data: Participant[] }>(`/api/v1/admin/contests/${participantContest.value.public_id || participantContest.value.id}/participants`, { silent: true })
    participants.value = response.data
  } finally {
    participantLoading.value = false
  }
}

async function searchUsers() {
  if (userQuery.value.trim().length < 2) return
  searchingUsers.value = true
  try {
    const response = await api.get<{ data: { items: UserSearchResult[] } }>(
      `/api/v1/search?q=${encodeURIComponent(userQuery.value.trim())}&type=user`,
    )
    // 排除已是参赛者的用户
    const participantIds = new Set(participants.value.map((p) => p.user_id))
    userResults.value = response.data.items.filter((user) => !participantIds.has(user.id))
  } finally {
    searchingUsers.value = false
  }
}

async function addParticipant(user: UserSearchResult) {
  if (!participantContest.value) return
  await api.post(`/api/v1/admin/contests/${participantContest.value.public_id || participantContest.value.id}/participants`, [user.username])
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
      `/api/v1/admin/contests/${participantContest.value.public_id || participantContest.value.id}/participants/${participant.username}`,
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
    <PageHeader title="竞赛管理" description="创建竞赛、配置赛制并管理参赛者">
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
    </PageHeader>

    <div v-if="loadError" class="flex flex-col items-center justify-center gap-2 px-6 py-12 text-sm text-error-text"><span>{{ loadError }}</span></div>
    <UTable :columns="columns" :data="contests" :loading="loading" :empty="'暂无竞赛'">
      <template #title-cell="{ row }"><div><div class="font-semibold text-text">{{ row.original.title }}</div><div class="mt-1 text-xs text-text-muted">{{ row.original.is_public ? '公开' : '邀请制' }}<span v-if="row.original.has_password"> · 密码保护</span></div></div></template>
      <template #status-cell="{ row }"><span class="inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold" :class="statusClass(row.original.status)">{{ statusLabels[row.original.status] }}</span></template>
      <template #participant_count-cell="{ row }"><span>{{ row.original.participant_count }} 人</span></template>
      <template #problem_count-cell="{ row }"><span>{{ row.original.problem_count }} 题</span></template>
      <template #actions-cell="{ row }"><div class="flex justify-center gap-1.5"><UButton color="neutral" variant="outline" class="flex size-9 border-border text-text-secondary hover:bg-blue-50 hover:text-primary" title="参与者" aria-label="参与者" @click="openParticipants(row.original)"><UIcon name="i-lucide-users" class="size-3.5" /></UButton><UButton color="neutral" variant="outline" class="flex size-9 border-border text-text-secondary hover:bg-primary-bg hover:text-text" title="编辑" aria-label="编辑" :loading="editingId === row.original.id" :disabled="editingId !== null" @click="openEdit(row.original)"><UIcon name="i-lucide-pencil" class="size-3.5" /></UButton><UButton color="neutral" variant="outline" class="flex size-9 border-border text-text-secondary hover:border-error-text/30 hover:bg-red-50 hover:text-error-text" title="删除" aria-label="删除" @click="removeContest(row.original)"><UIcon name="i-lucide-trash-2" class="size-3.5" /></UButton></div></template>
    </UTable>

    <PaginationNav :current-page="currentPage" :total-pages="totalPages" @page-change="loadContests" />
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
