<script setup lang="ts">
import type { Contest, ContestProblem } from '~/composables/useContests'

/**
 * 竞赛题目详情页：仅展示题目陈述，做题跳转独立编辑器页
 * （/contests/:id/problems/:label/editor）。
 */
definePageMeta({ middleware: 'auth', ssr: false })

const route = useRoute()
const contestId = route.params.contestId as string
const label = route.params.label as string

const { data: contestData } = await useFetch<{ data: Contest }>(
  `/api/v1/contests/${contestId}`,
  { server: false },
)
const { data, pending, error, refresh } = await useFetch<{ data: ContestProblem }>(
  `/api/v1/contests/${contestId}/problems/${label}`,
  { server: false },
)
const problem = computed(() => data.value?.data ?? null)
const contest = computed(() => contestData.value?.data ?? null)

const difficultyLabel: Record<string, string> = {
  easy: '简单',
  medium: '中等',
  hard: '困难',
}
const badgeColors: Record<string, string> = {
  easy: 'bg-green-100 text-green-700',
  medium: 'bg-yellow-100 text-yellow-700',
  hard: 'bg-red-100 text-red-800',
}
</script>

<template>
  <div class="min-h-[calc(100vh-64px)] bg-bg-page p-4 lg:p-6">
    <AsyncContent
      :status="pending ? 'loading' : error ? 'error' : problem ? 'data' : 'empty'"
      error="竞赛题目加载失败"
      @retry="refresh"
    >
      <div v-if="problem" class="mx-auto flex max-w-[960px] flex-col gap-4">
        <header class="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-white px-4 py-3">
          <NuxtLink
            :to="`/contests/${contestId}`"
            class="inline-flex items-center gap-1.5 text-sm text-text-secondary no-underline hover:text-primary"
          >
            <UIcon name="i-lucide-arrow-left" class="size-4" />返回竞赛
          </NuxtLink>
          <span class="h-5 w-px bg-border" />
          <span class="flex size-8 items-center justify-center rounded-lg bg-bg-dark font-mono text-sm font-bold text-white">{{ problem.label }}</span>
          <div class="min-w-0 flex-1">
            <h1 class="truncate text-base font-bold text-text">{{ problem.title }}</h1>
            <p class="text-xs text-text-muted">{{ contest?.title }} · {{ problem.display_id }}</p>
          </div>
          <span
            class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold"
            :class="badgeColors[problem.difficulty] || ''"
          >
            {{ difficultyLabel[problem.difficulty] || problem.difficulty }}
          </span>
          <UButton
            color="primary"
            class="gap-1.5 px-4 py-2 text-xs"
            :to="`/contests/${contestId}/problems/${label}/editor`"
          >
            <UIcon name="i-lucide-pencil-ruler" class="size-3.5" />去做题
          </UButton>
        </header>

        <section class="rounded-xl border border-border bg-white p-6 lg:p-8">
          <MarkdownRenderer :content="problem.description" />
        </section>
      </div>
    </AsyncContent>
  </div>
</template>
