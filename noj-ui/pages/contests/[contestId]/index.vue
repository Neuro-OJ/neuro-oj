<script setup lang="ts">
import type { Contest, ContestProblem } from '~/composables/useContests'

const route = useRoute()
const contestId = route.params.contestId as string
const { isLoggedIn } = useAuth()
const toast = useToast()
const { typeLabels, statusLabels, formatDateTime, formatDuration, statusClass } = useContests()
const password = ref('')
const registering = ref(false)
const registerError = ref('')
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined

const { data, pending, error, refresh } = await useFetch<{ data: Contest }>(
  `/api/v1/contests/${contestId}`,
  { server: false },
)
const contest = computed(() => data.value?.data ?? null)
const problems = ref<ContestProblem[]>([])
const problemsLoading = ref(false)
const problemsError = ref('')

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
    const response = await $fetch<{ data: ContestProblem[] }>(`/api/v1/contests/${contestId}/problems`)
    problems.value = response.data
  } catch (fetchError: unknown) {
    const detail = fetchError as { data?: { error?: string }; message?: string }
    problemsError.value = detail.data?.error || detail.message || '题目加载失败'
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
  registering.value = true
  registerError.value = ''
  try {
    await $fetch(`/api/v1/contests/${contestId}/register`, {
      method: 'POST',
      body: password.value ? { password: password.value } : undefined,
    })
    toast.showToast('success', '报名成功')
    await refresh()
    await loadProblems()
  } catch (registerFailure: unknown) {
    const detail = registerFailure as { data?: { error?: string }; message?: string }
    registerError.value = detail.data?.error || detail.message || '报名失败'
  } finally {
    registering.value = false
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
            <div class="grid gap-6 p-7 lg:grid-cols-[1fr_300px]">
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
                <UButton color="primary" variant="outline" class="w-full gap-2 py-2.5 text-sm" :to="`/contests/${contest.id}/ranking`"><UIcon name="i-lucide-trophy" class="size-4" />查看排名</UButton>
                <template v-if="!contest.is_registered && contest.status !== 'ended'">
                  <input v-if="contest.has_password" v-model="password" type="password" class="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary" placeholder="竞赛密码" @keyup.enter="register">
                  <UButton color="primary" class="w-full gap-2 py-2.5 text-sm disabled:opacity-50" :disabled="registering" @click="register"><UIcon name="i-lucide-key-round" class="size-4" />{{ registering ? '报名中...' : '报名参赛' }}</UButton>
                  <p v-if="registerError" class="text-xs text-error-text">{{ registerError }}</p>
                </template>
                <div v-else-if="contest.is_registered" class="rounded-lg bg-green-50 p-3 text-center text-sm font-semibold text-success-text">已报名参赛</div>
                <p class="text-xs leading-5 text-text-muted">{{ contest.affect_global_ranking ? '本竞赛成绩计入全局解题统计' : '本竞赛成绩不计入全局解题统计' }}</p>
              </aside>
            </div>
          </section>

          <section class="rounded-2xl border border-border bg-white p-6">
            <div class="mb-4 flex items-center justify-between">
              <h2 class="text-lg font-bold text-text">竞赛题目</h2>
              <span v-if="contest.status === 'pending'" class="text-xs text-text-muted">开赛后可见</span>
            </div>
            <div v-if="problemsLoading" class="py-12 text-center text-sm text-text-muted">题目加载中...</div>
            <div v-else-if="problemsError" class="py-8 text-center text-sm text-error-text">{{ problemsError }}</div>
            <div v-else-if="problems.length" class="divide-y divide-border overflow-hidden rounded-xl border border-border">
              <NuxtLink v-for="problem in problems" :key="problem.problem_id" :to="`/contests/${contest.id}/problems/${problem.label}`" class="flex items-center gap-4 px-5 py-4 text-text no-underline transition-colors hover:bg-primary-bg">
                <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-bg-dark font-mono text-sm font-bold text-white">{{ problem.label }}</span>
                <div class="min-w-0 flex-1"><div class="font-semibold">{{ problem.title }}</div><div class="mt-1 text-xs text-text-muted">{{ problem.display_id }} · {{ problem.difficulty }}</div></div>
                <StatusBadge :status="problem.user_status === 'untouched' ? 'not_started' : problem.user_status" />
              </NuxtLink>
            </div>
            <div v-else class="py-12 text-center text-sm text-text-muted">{{ contest.is_registered ? '暂无题目' : '报名后可查看竞赛题目' }}</div>
          </section>
        </div>
      </AsyncContent>
    </div>
  </div>
</template>
