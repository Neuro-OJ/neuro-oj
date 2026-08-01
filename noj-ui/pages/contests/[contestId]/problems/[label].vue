<script setup lang="ts">
import type { Contest, ContestProblem } from '~/composables/useContests'

definePageMeta({ middleware: 'auth', ssr: false })

const route = useRoute()
const contestId = route.params.contestId as string
const label = route.params.label as string
const toast = useToast()
const code = ref('')
const language = ref('python3')
const submitting = ref(false)
const submitError = ref('')

const { data: contestData } = await useFetch<{ data: Contest }>(`/api/v1/contests/${contestId}`, { server: false })
const { data, pending, error, refresh } = await useFetch<{ data: ContestProblem }>(
  `/api/v1/contests/${contestId}/problems/${label}`,
  { server: false },
)
const problem = computed(() => data.value?.data ?? null)
const contest = computed(() => contestData.value?.data ?? null)

interface SubmissionItem {
  id: string
  status: string
  created_at: string
  result: { status: string; score: number } | null
}

const submissions = ref<SubmissionItem[]>([])

async function loadSubmissions() {
  try {
    const response = await $fetch<{ data: SubmissionItem[] }>(`/api/v1/contests/${contestId}/my-submissions?per_page=100`)
    submissions.value = response.data.filter((item) => !problem.value || (item as SubmissionItem & { problem_id?: string }).problem_id === problem.value.problem_id)
  } catch {
    submissions.value = []
  }
}

watch(problem, () => void loadSubmissions(), { immediate: true })

async function submit() {
  if (!problem.value || !code.value.trim()) {
    submitError.value = '请先编写代码'
    return
  }
  submitting.value = true
  submitError.value = ''
  try {
    const response = await $fetch<{ data: { id: string } }>(`/api/v1/contests/${contestId}/submit`, {
      method: 'POST',
      body: {
        problem_id: problem.value.problem_id,
        language: language.value,
        code: code.value,
      },
    })
    toast.showToast('success', `提交成功：${response.data.id.slice(0, 8)}`)
    await loadSubmissions()
  } catch (submitFailure: unknown) {
    const detail = submitFailure as { data?: { error?: string }; message?: string }
    submitError.value = detail.data?.error || detail.message || '提交失败'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="min-h-[calc(100vh-64px)] bg-bg-page p-4 lg:p-6">
    <AsyncContent :status="pending ? 'loading' : error ? 'error' : problem ? 'data' : 'empty'" error="竞赛题目加载失败" @retry="refresh">
      <div v-if="problem" class="mx-auto flex max-w-[1500px] flex-col gap-4">
        <header class="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-white px-4 py-3">
          <NuxtLink :to="`/contests/${contestId}`" class="inline-flex items-center gap-1.5 text-sm text-text-secondary no-underline hover:text-primary"><UIcon name="i-lucide-arrow-left" class="size-4" />返回竞赛</NuxtLink>
          <span class="h-5 w-px bg-border" />
          <span class="flex size-8 items-center justify-center rounded-lg bg-bg-dark font-mono text-sm font-bold text-white">{{ problem.label }}</span>
          <div class="min-w-0 flex-1"><h1 class="truncate text-base font-bold text-text">{{ problem.title }}</h1><p class="text-xs text-text-muted">{{ contest?.title }}</p></div>
          <UButton color="primary" variant="outline" class="gap-1.5 px-3 py-1.5 text-xs" :to="`/contests/${contestId}/ranking`"><UIcon name="i-lucide-trophy" class="size-3.5" />排名</UButton>
          <select v-model="language" class="rounded-lg border border-border bg-white px-3 py-2 text-xs text-text outline-none focus:border-primary"><option value="python3">Python 3</option><option value="cpp">C++</option><option value="c">C</option><option value="javascript">JavaScript</option></select>
          <UButton color="primary" class="gap-1.5 px-4 py-2 text-xs disabled:opacity-50" :disabled="submitting || contest?.status !== 'running'" @click="submit"><UIcon name="i-lucide-send" class="size-3.5" />{{ submitting ? '提交中...' : '提交代码' }}</UButton>
        </header>

        <div class="grid min-h-[680px] gap-4 lg:grid-cols-[minmax(360px,42%)_1fr]">
          <section class="overflow-y-auto rounded-xl border border-border bg-white p-6">
            <div class="mb-5 flex items-center justify-between border-b border-border pb-4">
              <div><span class="text-xs font-semibold text-primary">{{ problem.display_id }}</span><h2 class="mt-1 text-xl font-bold text-text">{{ problem.title }}</h2></div>
              <DifficultyBadge :difficulty="problem.difficulty" />
            </div>
            <MarkdownRenderer :content="problem.description" />

            <div class="mt-8 border-t border-border pt-5">
              <h3 class="mb-3 text-sm font-bold text-text">我的提交</h3>
              <div v-if="submissions.length" class="space-y-2">
                <NuxtLink v-for="submission in submissions.slice(0, 8)" :key="submission.id" :to="`/submissions/${submission.id}`" class="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-xs text-text no-underline hover:bg-bg-page">
                  <span class="font-mono">{{ submission.id.slice(0, 8) }}</span>
                  <span :class="submission.result?.status === 'Accepted' ? 'text-success-text' : 'text-text-secondary'">{{ submission.result?.status || submission.status }}</span>
                </NuxtLink>
              </div>
              <p v-else class="text-xs text-text-muted">尚无提交</p>
            </div>
          </section>

          <section class="flex min-h-[680px] flex-col overflow-hidden rounded-xl border border-border bg-bg-dark shadow-card">
            <div class="flex items-center justify-between border-b border-dark-3 px-4 py-2.5 text-xs text-slate-400"><span class="font-mono">submission.py</span><span>{{ code.length }} 字符</span></div>
            <div class="min-h-0 flex-1">
              <ClientOnly>
                <MonacoEditor v-model="code" :language="language" theme="vs-dark" :disabled="submitting || contest?.status !== 'running'" :min-height="640" />
                <template #fallback><div class="flex h-full items-center justify-center text-sm text-slate-400">编辑器加载中...</div></template>
              </ClientOnly>
            </div>
            <div v-if="submitError" class="flex items-center gap-2 border-t border-red-900 bg-red-950/70 px-4 py-2 text-xs text-red-300"><UIcon name="i-lucide-alert-circle" class="size-3.5" />{{ submitError }}</div>
          </section>
        </div>
      </div>
    </AsyncContent>
  </div>
</template>
