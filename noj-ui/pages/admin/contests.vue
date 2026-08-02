<script setup lang="ts">
import { extractApiError } from '~/utils/apiError'
import type {
  AdminContestDetail,
  AdminProblemOption,
  Contest,
  ContestPayload,
  Pagination,
} from '~/composables/useContests'

definePageMeta({ layout: 'admin', middleware: 'admin', ssr: false })

const { typeLabels, statusLabels, formatDateTime, statusClass } = useContests()
const toast = useToast()
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
let contestRequestVersion = 0

function reloadAfterContestMutation() {
  reloadNuxtApp({ path: '/admin/contests', persistState: false })
}

const columns = [
  { accessorKey: 'title', header: '竞赛' },
  { accessorKey: 'type', header: '赛制', cell: (info) => typeLabels[info.getValue() as Contest['type']] },
  { accessorKey: 'status', header: '状态' },
  { accessorKey: 'start_time', header: '开始时间', cell: (info) => formatDateTime(info.getValue() as string) },
  { accessorKey: 'participant_count', header: '参赛者' },
  { accessorKey: 'problem_count', header: '题目' },

  { accessorKey: "actions", header: "操作" },]

async function loadContests(page = currentPage.value) {
  const currentRequest = ++contestRequestVersion
  loading.value = true
  loadError.value = ''
  try {
    const response = await api.get<{ data: Contest[]; pagination: Pagination }>(`/api/v1/admin/contests?page=${page}&per_page=20`, { silent: true })
    if (currentRequest !== contestRequestVersion) return
    contests.value = response.data
    currentPage.value = response.pagination.page
    totalPages.value = response.pagination.total_pages
  } catch (fetchError: unknown) {
    if (currentRequest !== contestRequestVersion) return
    loadError.value = extractApiError(fetchError).message
  } finally {
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

function openCreate() {
  editingContest.value = null
  formError.value = ''
  formOpen.value = true
}

async function openEdit(contest: Contest) {
  formError.value = ''
  const response = await api.get<{ data: AdminContestDetail }>(`/api/v1/admin/contests/${contest.id}`)
  editingContest.value = response.data
  formOpen.value = true
}

async function saveContest(payload: ContestPayload) {
  saving.value = true
  formError.value = ''
  try {
    if (editingContest.value) {
      await api.put(`/api/v1/admin/contests/${editingContest.value.id}`, payload)
    } else {
      await api.post('/api/v1/admin/contests', payload)
    }
    toast.showToast('success', editingContest.value ? '竞赛已更新' : '竞赛已创建')
    formOpen.value = false
    reloadAfterContestMutation()
  } catch (saveError: unknown) {
    formError.value = extractApiError(saveError).message
  } finally {
    saving.value = false
  }
}

async function removeContest(contest: Contest) {
  const confirmed = await dialog.confirm(`确定删除竞赛“${contest.title}”吗？竞赛提交会保留，但将解除竞赛关联。`, { title: '删除竞赛', confirmText: '删除', danger: true })
  if (!confirmed) return
  await api.delete(`/api/v1/admin/contests/${contest.id}`)
  toast.showToast('success', '竞赛已删除')
  reloadAfterContestMutation()
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
    const response = await api.get<{ data: Participant[] }>(`/api/v1/admin/contests/${participantContest.value.id}/participants`, { silent: true })
    participants.value = response.data
  } finally {
    participantLoading.value = false
  }
}

async function searchUsers() {
  if (userQuery.value.trim().length < 2) return
  searchingUsers.value = true
  try {
    const response = await api.get<{ data: UserSearchResult[] }>(`/api/v1/users/search?q=${encodeURIComponent(userQuery.value.trim())}`)
    participants.value.forEach((participant) => {
      response.data = response.data.filter((user) => user.id !== participant.user_id)
    })
    userResults.value = response.data
  } finally {
    searchingUsers.value = false
  }
}

async function addParticipant(user: UserSearchResult) {
  if (!participantContest.value) return
  await api.post(`/api/v1/admin/contests/${participantContest.value.id}/participants`, [user.id])
  userResults.value = userResults.value.filter((item) => item.id !== user.id)
  await loadParticipants()
}

async function removeParticipant(participant: Participant) {
  if (!participantContest.value) return
  await api.delete(`/api/v1/admin/contests/${participantContest.value.id}/participants/${participant.user_id}`)
  await loadParticipants()
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <PageHeader title="竞赛管理" description="创建竞赛、配置赛制并管理参赛者">
      <template #actions><UButton color="primary" size="sm" @click="openCreate"><UIcon name="i-lucide-plus" class="size-4" />创建竞赛</UButton></template>
    </PageHeader>

    <div v-if="loadError" class="flex flex-col items-center justify-center gap-2 px-6 py-12 text-sm text-error-text"><span>{{ loadError }}</span></div>
    <UTable :columns="columns" :data="contests" :loading="loading" :empty="'暂无竞赛'">
      <template #title-cell="{ row }"><div><div class="font-semibold text-text">{{ row.original.title }}</div><div class="mt-1 text-xs text-text-muted">{{ row.original.is_public ? '公开' : '邀请制' }}<span v-if="row.original.has_password"> · 密码保护</span></div></div></template>
      <template #status-cell="{ row }"><span class="inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold" :class="statusClass(row.original.status)">{{ statusLabels[row.original.status] }}</span></template>
      <template #participant_count-cell="{ row }"><span>{{ row.original.participant_count }} 人</span></template>
      <template #problem_count-cell="{ row }"><span>{{ row.original.problem_count }} 题</span></template>
      <template #actions-cell="{ row }"><div class="flex justify-center gap-1.5"><UButton color="neutral" variant="outline" class="flex size-[30px] border-border text-text-secondary hover:bg-blue-50 hover:text-primary" title="参与者" @click="openParticipants(row.original)"><UIcon name="i-lucide-users" class="size-3.5" /></UButton><UButton color="neutral" variant="outline" class="flex size-[30px] border-border text-text-secondary hover:bg-gray-100 hover:text-text" title="编辑" @click="openEdit(row.original)"><UIcon name="i-lucide-pencil" class="size-3.5" /></UButton><UButton color="neutral" variant="outline" class="flex size-[30px] border-border text-text-secondary hover:border-red-200 hover:bg-red-50 hover:text-error-text" title="删除" @click="removeContest(row.original)"><UIcon name="i-lucide-trash-2" class="size-3.5" /></UButton></div></template>
    </UTable>

    <PaginationNav :current-page="currentPage" :total-pages="totalPages" @page-change="loadContests" />
  </div>

  <ContestFormModal v-if="formOpen" :contest="editingContest" :problems="problems" :saving="saving" :error="formError" @save="saveContest" @search-problems="loadProblems" @cancel="formOpen = false" />

  <div v-if="participantContest" class="fixed inset-0 z-300 flex items-center justify-center bg-black/45 p-4" @click.self="participantContest = null">
    <div class="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-modal">
      <header class="flex items-center justify-between border-b border-border px-6 py-4"><div><h2 class="text-lg font-bold text-text">参与者管理</h2><p class="mt-1 text-xs text-text-muted">{{ participantContest.title }} · {{ participants.length }} 人</p></div><button class="rounded-lg p-2 text-text-secondary hover:bg-gray-100" @click="participantContest = null"><UIcon name="i-lucide-x" class="size-4.5" /></button></header>
      <div class="border-b border-border p-5"><div class="flex gap-2"><input v-model="userQuery" class="min-w-0 flex-1 rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary" placeholder="搜索用户名或邮箱" @keyup.enter="searchUsers"><UButton color="primary" size="md" :disabled="searchingUsers" @click="searchUsers"><UIcon name="i-lucide-user-plus" class="size-3.5" />搜索</UButton></div><div v-if="userResults.length" class="mt-2 max-h-36 overflow-y-auto rounded-lg border border-border"><button v-for="user in userResults" :key="user.id" class="flex w-full items-center justify-between border-b border-border px-3 py-2 text-left text-xs last:border-0 hover:bg-primary-bg" @click="addParticipant(user)"><span><strong class="text-text">{{ user.username }}</strong><span class="ml-2 text-text-muted">{{ user.email }}</span></span><UIcon name="i-lucide-plus" class="text-primary size-3.5" /></button></div></div>
      <div class="flex-1 overflow-y-auto p-5"><div v-if="participantLoading" class="py-12 text-center text-sm text-text-muted">加载中...</div><div v-else-if="participants.length" class="divide-y divide-border rounded-xl border border-border"><div v-for="participant in participants" :key="participant.user_id" class="flex items-center gap-3 px-4 py-3"><div class="flex size-9 items-center justify-center rounded-full bg-primary-bg text-sm font-bold text-primary">{{ participant.username.slice(0, 1).toUpperCase() }}</div><div class="min-w-0 flex-1"><div class="truncate text-sm font-semibold text-text">{{ participant.username }}</div><div class="text-xs text-text-muted">{{ formatDateTime(participant.registered_at) }} 报名</div></div><button class="rounded-lg p-2 text-text-muted hover:bg-red-50 hover:text-error-text" title="移除" @click="removeParticipant(participant)"><UIcon name="i-lucide-trash-2" class="size-3.5" /></button></div></div><p v-else class="py-12 text-center text-sm text-text-muted">暂无参与者</p></div>
    </div>
  </div>
</template>
