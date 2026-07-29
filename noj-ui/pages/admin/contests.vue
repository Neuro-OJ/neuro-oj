<script setup lang="ts">
import { Pencil, Plus, Trash2, UserPlus, Users, X } from '@lucide/vue'
import type { Column } from '~/components/admin/AdminTable.vue'
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

const columns: Column<Contest>[] = [
  { key: 'title', label: '竞赛' },
  { key: 'type', label: '赛制', format: (value) => typeLabels[value as Contest['type']] },
  { key: 'status', label: '状态' },
  { key: 'start_time', label: '开始时间', format: (value) => formatDateTime(value as string) },
  { key: 'participant_count', label: '参赛者' },
  { key: 'problem_count', label: '题目' },
]

async function loadContests(page = currentPage.value) {
  const currentRequest = ++contestRequestVersion
  loading.value = true
  loadError.value = ''
  try {
    const response = await $fetch<{ data: Contest[]; pagination: Pagination }>(`/api/v1/admin/contests?page=${page}&per_page=20`)
    if (currentRequest !== contestRequestVersion) return
    contests.value = response.data
    currentPage.value = response.pagination.page
    totalPages.value = response.pagination.total_pages
  } catch (fetchError: unknown) {
    if (currentRequest !== contestRequestVersion) return
    const detail = fetchError as { data?: { error?: string }; message?: string }
    loadError.value = detail.data?.error || detail.message || '竞赛列表加载失败'
  } finally {
    if (currentRequest === contestRequestVersion) loading.value = false
  }
}

let problemRequestVersion = 0

async function loadProblems(keyword = '') {
  const currentRequest = ++problemRequestVersion
  try {
    const response = await $fetch<{ data: AdminProblemOption[] }>(`/api/v1/admin/problems?page=1&limit=20&keyword=${encodeURIComponent(keyword)}`)
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
  try {
    const response = await $fetch<{ data: AdminContestDetail }>(`/api/v1/admin/contests/${contest.id}`)
    editingContest.value = response.data
    formOpen.value = true
  } catch (fetchError: unknown) {
    const detail = fetchError as { data?: { error?: string }; message?: string }
    toast.showToast('error', detail.data?.error || detail.message || '竞赛详情加载失败')
  }
}

async function saveContest(payload: ContestPayload) {
  saving.value = true
  formError.value = ''
  try {
    if (editingContest.value) {
      await $fetch(`/api/v1/admin/contests/${editingContest.value.id}`, { method: 'PUT', body: payload })
    } else {
      await $fetch('/api/v1/admin/contests', { method: 'POST', body: payload })
    }
    toast.showToast('success', editingContest.value ? '竞赛已更新' : '竞赛已创建')
    formOpen.value = false
    reloadAfterContestMutation()
  } catch (saveError: unknown) {
    const detail = saveError as { data?: { error?: string }; message?: string }
    formError.value = detail.data?.error || detail.message || '竞赛保存失败'
  } finally {
    saving.value = false
  }
}

async function removeContest(contest: Contest) {
  const confirmed = await dialog.confirm(`确定删除竞赛“${contest.title}”吗？竞赛提交会保留，但将解除竞赛关联。`, { title: '删除竞赛', confirmText: '删除', danger: true })
  if (!confirmed) return
  try {
    await $fetch(`/api/v1/admin/contests/${contest.id}`, { method: 'DELETE' })
    toast.showToast('success', '竞赛已删除')
    reloadAfterContestMutation()
  } catch (deleteError: unknown) {
    const detail = deleteError as { data?: { error?: string }; message?: string }
    toast.showToast('error', detail.data?.error || detail.message || '删除失败')
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
    const response = await $fetch<{ data: Participant[] }>(`/api/v1/admin/contests/${participantContest.value.id}/participants`)
    participants.value = response.data
  } finally {
    participantLoading.value = false
  }
}

async function searchUsers() {
  if (userQuery.value.trim().length < 2) return
  searchingUsers.value = true
  try {
    const response = await $fetch<{ data: UserSearchResult[] }>(`/api/v1/users/search?q=${encodeURIComponent(userQuery.value.trim())}`)
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
  await $fetch(`/api/v1/admin/contests/${participantContest.value.id}/participants`, { method: 'POST', body: [user.id] })
  userResults.value = userResults.value.filter((item) => item.id !== user.id)
  await loadParticipants()
}

async function removeParticipant(participant: Participant) {
  if (!participantContest.value) return
  await $fetch(`/api/v1/admin/contests/${participantContest.value.id}/participants/${participant.user_id}`, { method: 'DELETE' })
  await loadParticipants()
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <PageHeader title="竞赛管理" description="创建竞赛、配置赛制并管理参赛者">
      <template #actions><button class="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-[13px] font-semibold text-white hover:bg-primary-dark" @click="openCreate"><Plus :size="16" />创建竞赛</button></template>
    </PageHeader>

    <AdminTable :columns="columns" :data="contests" :loading="loading" :error="loadError" empty-text="暂无竞赛">
      <template #cell-title="{ row }"><div><div class="font-semibold text-text">{{ row.title }}</div><div class="mt-1 text-xs text-text-muted">{{ row.is_public ? '公开' : '邀请制' }}<span v-if="row.has_password"> · 密码保护</span></div></div></template>
      <template #cell-status="{ row }"><span class="inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold" :class="statusClass(row.status)">{{ statusLabels[row.status] }}</span></template>
      <template #cell-participant_count="{ row }"><span>{{ row.participant_count }} 人</span></template>
      <template #cell-problem_count="{ row }"><span>{{ row.problem_count }} 题</span></template>
      <template #actions="{ row }"><div class="flex justify-center gap-1.5"><button class="flex size-[30px] items-center justify-center rounded border border-border text-text-secondary hover:bg-blue-50 hover:text-primary" title="参与者" @click="openParticipants(row)"><Users :size="15" /></button><button class="flex size-[30px] items-center justify-center rounded border border-border text-text-secondary hover:bg-gray-100 hover:text-text" title="编辑" @click="openEdit(row)"><Pencil :size="15" /></button><button class="flex size-[30px] items-center justify-center rounded border border-border text-text-secondary hover:border-red-200 hover:bg-red-50 hover:text-error-text" title="删除" @click="removeContest(row)"><Trash2 :size="15" /></button></div></template>
    </AdminTable>

    <PaginationNav :current-page="currentPage" :total-pages="totalPages" @page-change="loadContests" />
  </div>

  <ContestFormModal v-if="formOpen" :contest="editingContest" :problems="problems" :saving="saving" :error="formError" @save="saveContest" @search-problems="loadProblems" @cancel="formOpen = false" />

  <div v-if="participantContest" class="fixed inset-0 z-300 flex items-center justify-center bg-black/45 p-4" @click.self="participantContest = null">
    <div class="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-modal">
      <header class="flex items-center justify-between border-b border-border px-6 py-4"><div><h2 class="text-lg font-bold text-text">参与者管理</h2><p class="mt-1 text-xs text-text-muted">{{ participantContest.title }} · {{ participants.length }} 人</p></div><button class="rounded-lg p-2 text-text-secondary hover:bg-gray-100" @click="participantContest = null"><X :size="18" /></button></header>
      <div class="border-b border-border p-5"><div class="flex gap-2"><input v-model="userQuery" class="min-w-0 flex-1 rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary" placeholder="搜索用户名或邮箱" @keyup.enter="searchUsers"><button class="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark" :disabled="searchingUsers" @click="searchUsers"><UserPlus :size="15" />搜索</button></div><div v-if="userResults.length" class="mt-2 max-h-36 overflow-y-auto rounded-lg border border-border"><button v-for="user in userResults" :key="user.id" class="flex w-full items-center justify-between border-b border-border px-3 py-2 text-left text-xs last:border-0 hover:bg-primary-bg" @click="addParticipant(user)"><span><strong class="text-text">{{ user.username }}</strong><span class="ml-2 text-text-muted">{{ user.email }}</span></span><Plus :size="14" class="text-primary" /></button></div></div>
      <div class="flex-1 overflow-y-auto p-5"><div v-if="participantLoading" class="py-12 text-center text-sm text-text-muted">加载中...</div><div v-else-if="participants.length" class="divide-y divide-border rounded-xl border border-border"><div v-for="participant in participants" :key="participant.user_id" class="flex items-center gap-3 px-4 py-3"><div class="flex size-9 items-center justify-center rounded-full bg-primary-bg text-sm font-bold text-primary">{{ participant.username.slice(0, 1).toUpperCase() }}</div><div class="min-w-0 flex-1"><div class="truncate text-sm font-semibold text-text">{{ participant.username }}</div><div class="text-xs text-text-muted">{{ formatDateTime(participant.registered_at) }} 报名</div></div><button class="rounded-lg p-2 text-text-muted hover:bg-red-50 hover:text-error-text" title="移除" @click="removeParticipant(participant)"><Trash2 :size="15" /></button></div></div><p v-else class="py-12 text-center text-sm text-text-muted">暂无参与者</p></div>
    </div>
  </div>
</template>
