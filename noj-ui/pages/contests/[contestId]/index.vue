<script setup lang="ts">
import type { Contest, ContestProblem } from '~/composables/useContests'
import { extractApiError } from '~/utils/apiError'
import { runContestRegistration } from '~/utils/contestRegistration'
import { publicUrl } from '~/utils/publicIdentifiers'

const route = useRoute()
const router = useRouter()
const contestId = route.params.contestId as string
const { isLoggedIn } = useAuth()
const toast = useToast()
const { api } = useApi()
const { typeLabels, statusLabels, formatDateTime, formatDuration, statusClass } = useContests()
const password = ref('')
const registering = ref(false)
const registerError = ref('')
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined

const { data, pending, error, refresh } = await useFetch<{ data: Contest }>(
  `/api/v1/contests/${contestId}`,
)
const contest = computed(() => data.value?.data ?? null)

useSeoMeta({
  title: () => contest.value?.title ? `${contest.value.title} - Neuro OJ` : '竞赛 - Neuro OJ',
  description: () => contest.value?.description ? contest.value.description.slice(0, 160) : 'Neuro OJ 竞赛',
  ogTitle: () => contest.value?.title ?? 'Neuro OJ',
  ogDescription: () => contest.value?.description ? contest.value.description.slice(0, 160) : 'Neuro OJ 竞赛',
})

const problems = ref<ContestProblem[]>([])
const problemsLoading = ref(false)
const problemsError = ref('')

// ── Tabs（详情 / 题目 / 答疑 / 排名），状态同步到 ?tab= query ─────────
const TAB_NAMES = ['detail', 'problems', 'clarifications', 'ranking'] as const
type TabName = typeof TAB_NAMES[number]
const activeTab = ref<TabName>('detail')
const queryTab = route.query.tab
const queryTabIndex = typeof queryTab === 'string'
  ? TAB_NAMES.indexOf(queryTab as (typeof TAB_NAMES)[number])
  : -1
if (queryTabIndex >= 0) activeTab.value = TAB_NAMES[queryTabIndex]

// tab → URL：切换时写入 ?tab=（replace，不产生历史记录）
watch(activeTab, (value) => {
  if (route.query.tab !== value) {
    router.replace({ query: { ...route.query, tab: value } })
  }
})

// URL → tab：浏览器前进/后退或站内跳转带 tab 参数时同步
watch(() => route.query.tab, (value) => {
  if (typeof value === 'string' && TAB_NAMES.includes(value as TabName) && value !== activeTab.value) {
    activeTab.value = value as TabName
  }
})

const tabItems = [
  { value: 'detail', label: '详情', icon: 'i-lucide-info', slot: 'detail' },
  { value: 'problems', label: '题目', icon: 'i-lucide-list-checks', slot: 'problems' },
  { value: 'clarifications', label: '答疑', icon: 'i-lucide-message-circle-question', slot: 'clarifications' },
  { value: 'ranking', label: '排名', icon: 'i-lucide-trophy', slot: 'ranking' },
]

const countdown = computed(() => {
  if (!contest.value) return ''
  const target = contest.value.status === 'pending' ? contest.value.start_time : contest.value.end_time
  const diff = Math.max(0, Date.parse(target) - now.value)
  const days = Math.floor(diff / 86_400_000)
  const hours = Math.floor((diff % 86_400_000) / 3_600_000)
  const minutes = Math.floor((diff % 3_600_000) / 60_000)
  const seconds = Math.floor((diff % 60_000) / 1000)
  return `${days > 0 ? `${days}天 ` : ''}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
})

async function loadProblems() {
  if (!contest.value?.is_registered || contest.value.status === 'pending') return
  problemsLoading.value = true
  problemsError.value = ''
  try {
    const response = await api.get<{ data: ContestProblem[] }>(`/api/v1/contests/${contestId}/problems`, { silent: true })
    problems.value = response.data
  } catch (fetchError: unknown) {
    problemsError.value = extractApiError(fetchError).message
  } finally {
    problemsLoading.value = false
  }
}

watch(contest, () => void loadProblems(), { immediate: true })

async function register() {
  if (!isLoggedIn.value) {
    await navigateTo({ path: '/login', query: { redirect: route.fullPath } })
    return
  }
  registerError.value = ''
  try {
    await runContestRegistration({
      isRegistering: () => registering.value,
      setRegistering: (value) => {
        registering.value = value
      },
      register: async () => {
        await api.post(`/api/v1/contests/${contestId}/register`, password.value ? { password: password.value } : undefined)
      },
      onRegistered: () => {
        const currentContest = data.value?.data
        if (currentContest && !currentContest.is_registered) {
          data.value = {
            ...data.value,
            data: {
              ...currentContest,
              is_registered: true,
              participant_count: currentContest.participant_count + 1,
            },
          }
        }
        toast.showToast('success', '报名成功')
      },
      refresh: async () => {
        await refresh()
        await loadProblems()
      },
      onRefreshFailed: (refreshFailure) => {
        if (import.meta.dev) {
          console.warn('[contest-registration] 报名成功后的数据刷新失败', refreshFailure)
        }
      },
    })
  } catch (registerFailure: unknown) {
    registerError.value = extractApiError(registerFailure).message
  }
}

onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div class="min-h-full bg-bg-page py-8">
    <div class="mx-auto max-w-[960px] px-4 sm:px-7">
      <AsyncContent :status="pending ? 'loading' : error ? 'error' : contest ? 'data' : 'empty'" error="竞赛加载失败" @retry="refresh">
        <div v-if="contest" class="space-y-6">
          <section class="overflow-hidden rounded-2xl border border-border bg-white shadow-card">
            <div class="bg-bg-dark px-7 py-7 text-white">
              <div class="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div class="mb-3 flex items-center gap-2 text-xs text-slate-300">
                    <span class="rounded-md bg-white/10 px-2.5 py-1">{{ typeLabels[contest.type] }}</span>
                    <span class="rounded-full border px-2.5 py-1" :class="statusClass(contest.status)">{{ statusLabels[contest.status] }}</span>
                  </div>
                  <h1 class="text-2xl font-bold md:text-3xl">{{ contest.title }}</h1>
                </div>
                <div v-if="contest.status !== 'ended'" class="rounded-xl border border-white/15 bg-white/10 px-5 py-3 text-right">
                  <div class="text-xs text-slate-300">{{ contest.status === 'pending' ? '距离开始' : '距离结束' }}</div>
                  <div class="mt-1 font-mono text-xl font-bold tracking-wide">{{ countdown }}</div>
                </div>
              </div>
              <div class="mt-6 grid gap-3 text-sm text-slate-300 sm:grid-cols-2 lg:grid-cols-4">
                <span class="flex items-center gap-2"><UIcon name="i-lucide-calendar-clock" class="size-4" />{{ formatDateTime(contest.start_time) }}</span>
                <span class="flex items-center gap-2"><UIcon name="i-lucide-timer" class="size-4" />{{ formatDuration(contest.start_time, contest.end_time) }}</span>
                <span class="flex items-center gap-2"><UIcon name="i-lucide-list-checks" class="size-4" />{{ contest.problem_count }} 道题</span>
                <span class="flex items-center gap-2"><UIcon name="i-lucide-users" class="size-4" />{{ contest.participant_count }} 名参赛者</span>
              </div>
            </div>
          </section>

          <section class="overflow-hidden rounded-2xl border border-border bg-white p-4 shadow-card sm:p-6">
            <UTabs v-model="activeTab" :items="tabItems" class="w-full">
              <template #detail>
                <div class="grid gap-6 p-2 pt-5 sm:p-4 sm:pt-6 lg:grid-cols-[1fr_300px]">
                  <div class="space-y-6">
                    <div v-if="contest.announcement" class="rounded-lg border border-blue-200 bg-blue-50 p-4">
                      <h2 class="mb-2 text-sm font-bold text-info-text">竞赛公告</h2>
                      <MarkdownRenderer :content="contest.announcement" />
                    </div>
                    <div>
                      <h2 class="mb-3 text-lg font-bold text-text">竞赛说明</h2>
                      <MarkdownRenderer :content="contest.description || '暂无竞赛说明'" />
                    </div>
                  </div>
                  <aside class="space-y-3 rounded-xl border border-border bg-bg-page p-4">
                    <template v-if="!contest.is_registered && contest.status !== 'ended'">
                      <input v-if="contest.has_password" v-model="password" type="password" class="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-signal" placeholder="竞赛密码" @keyup.enter="register">
                      <UButton color="primary" class="w-full gap-2 py-2.5 text-sm disabled:opacity-50" :disabled="registering" @click="register"><UIcon name="i-lucide-key-round" class="size-4" />{{ registering ? '报名中...' : '报名参赛' }}</UButton>
                      <p v-if="registerError" class="text-xs text-error-text">{{ registerError }}</p>
                    </template>
                    <div v-else-if="contest.is_registered" class="rounded-lg bg-green-50 p-3 text-center text-sm font-semibold text-success-text">已报名参赛</div>
                    <p class="text-xs leading-5 text-text-muted">{{ contest.affect_global_ranking ? '本竞赛成绩计入全局解题统计' : '本竞赛成绩不计入全局解题统计' }}</p>
                  </aside>
                </div>
              </template>

              <template #problems>
                <div class="p-2 pt-5 sm:p-4 sm:pt-6">
                  <div class="mb-4 flex items-center justify-between">
                    <h2 class="text-lg font-bold text-text">竞赛题目</h2>
                    <span v-if="contest.status === 'pending'" class="text-xs text-text-muted">开赛后可见</span>
                  </div>
                  <div v-if="problemsLoading" class="py-12 text-center text-sm text-text-muted">题目加载中...</div>
                  <div v-else-if="problemsError" class="py-8 text-center text-sm text-error-text">{{ problemsError }}</div>
                  <div v-else-if="problems.length" class="divide-y divide-border overflow-hidden rounded-xl border border-border">
                    <div v-for="problem in problems" :key="problem.problem_id" class="flex items-center gap-4 px-5 py-4 transition-colors hover:bg-primary-bg">
                      <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-bg-dark font-mono text-sm font-bold text-white">{{ problem.label }}</span>
                      <NuxtLink :to="`${publicUrl('contest', contest.public_id || contest.id)}/problems/${problem.label}`" class="min-w-0 flex-1 text-text no-underline">
                        <div class="font-semibold">{{ problem.title }}</div>
                        <div class="mt-1 text-xs text-text-muted">{{ problem.display_id }} · {{ problem.difficulty }}</div>
                      </NuxtLink>
                      <StatusBadge :status="problem.user_status === 'untouched' ? 'not_started' : problem.user_status" />
                      <UButton
                        color="primary"
                        size="sm"
                        class="gap-1.5 px-3 py-1.5 text-xs"
                        :to="`/editor/${problem.display_id}?contest=${contest.public_id || contest.id}&label=${problem.label}`"
                      >
                        <UIcon name="i-lucide-pencil-ruler" class="size-3.5" />去做题
                      </UButton>
                    </div>
                  </div>
                  <div v-else class="py-12 text-center text-sm text-text-muted">{{ contest.is_registered ? '暂无题目' : '报名后可查看竞赛题目' }}</div>
                </div>
              </template>

              <template #clarifications>
                <div class="p-2 pt-5 sm:p-4 sm:pt-6">
                  <ClarificationsPanel :contest="contest" :problems="problems" />
                </div>
              </template>

              <template #ranking>
                <div class="p-2 pt-5 sm:p-4 sm:pt-6">
                  <ContestRanking :contest-id="contest.public_id || contest.id" />
                </div>
              </template>
            </UTabs>
          </section>
        </div>
      </AsyncContent>
    </div>
  </div>
</template>
