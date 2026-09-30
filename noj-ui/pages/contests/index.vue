<script setup lang="ts">
import type { Contest, ContestStatus, ContestType } from '~/composables/useContests'
import { publicUrl } from '~/utils/publicIdentifiers'

definePageMeta({ breadcrumbWidth: '960px' })

const { t } = useI18n()
useHead({ title: computed(() => `${t('contest.title')} - Neuro OJ`) })

const { typeLabels, statusLabels, formatDateTime, formatDuration, statusClass } = useContests()
const selectedType = ref<ContestType | undefined>(undefined)
// 赛制下拉必须来自**实现支持的赛制**（`ContestType`），而不是硬编码的
// ICPC/IOI/OI——那些赛制尚未开放（schema 的 CHECK 只允许 `kaggle`），
// 选中后永远筛出空列表（2026-09-22 评审发现的真实 UI 缺陷）。
const typeOptions = computed(() =>
  Object.entries(typeLabels.value).map(([value, label]) => ({ label, value }))
)
const selectedStatus = ref<ContestStatus | undefined>(undefined)
const currentPage = ref(1)
const perPage = 12

const { data, pending, error, refresh } = await useFetch<{
  data: Contest[]
}>('/api/v1/contests', {
  query: computed(() => ({
    page: 1,
    per_page: 100,
    type: selectedType.value || undefined,
  })),
})

const filteredContests = computed(() => {
  const contests = data.value?.data ?? []
  if (!selectedStatus.value) return contests
  return contests.filter((contest) => contest.status === selectedStatus.value)
})
const totalPages = computed(() => Math.ceil(filteredContests.value.length / perPage))
const pagedContests = computed(() => {
  const start = (currentPage.value - 1) * perPage
  return filteredContests.value.slice(start, start + perPage)
})

watch([selectedType, selectedStatus], () => {
  currentPage.value = 1
})
</script>

<template>
  <div class="min-h-full bg-bg-page py-10">
    <div class="mx-auto max-w-[960px] space-y-6 px-4 sm:px-7">
      <!-- 页面头部（开放式轻量页头，对齐题库与榜单） -->
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="flex size-10 items-center justify-center rounded-lg bg-primary-bg text-primary border border-primary/20 shadow-xs">
            <UIcon name="i-lucide-trophy" class="size-5" />
          </div>
          <div>
            <h1 class="text-2xl font-bold text-text leading-tight">{{ t('contest.title') }}</h1>
            <p class="text-xs text-text-muted mt-0.5">{{ t('contest.description') }}</p>
          </div>
        </div>
        <span class="text-xs text-text-muted px-2.5 py-1 rounded-md bg-bg-sunken border border-border tabular-nums font-mono">{{ t('contest.count', { count: filteredContests.length }) }}</span>
      </div>

      <section class="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-white p-4 shadow-card">
        <USelect v-model="selectedType" :items="typeOptions" :placeholder="t('contest.allTypes')" class="min-w-[120px]" />
        <USelect v-model="selectedStatus" :items="[{ label: t('contest.pending'), value: 'pending' }, { label: t('contest.running'), value: 'running' }, { label: t('contest.ended'), value: 'ended' }]" :placeholder="t('contest.allStatuses')" class="min-w-[120px]" />
        <span class="ml-auto text-xs text-text-muted">{{ t('contest.count', { count: filteredContests.length }) }}</span>
      </section>

      <AsyncContent
        :status="pending ? 'loading' : error ? 'error' : pagedContests.length ? 'data' : 'empty'"
        :error="t('contest.loadFailed')"
        :empty-text="t('contest.empty')"
        @retry="refresh"
      >
        <div class="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          <NuxtLink
            v-for="contest in pagedContests"
            :key="contest.id"
            :to="publicUrl('contest', contest.public_id || contest.id)"
            class="group flex min-h-64 flex-col rounded-lg border border-border bg-white p-5 text-text no-underline shadow-sm transition-all duration-200 hover:-translate-y-1 hover:border-primary/50 hover:shadow-dropdown"
          >
            <div class="flex items-start justify-between gap-3">
              <span class="rounded-md bg-primary-bg px-2.5 py-1 text-xs font-semibold text-primary-text border border-primary/20">{{ typeLabels[contest.type] }}</span>
              <span class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold" :class="statusClass(contest.status)">
                <span v-if="contest.status === 'running'" class="relative flex size-2">
                  <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-signal opacity-75"></span>
                  <span class="relative inline-flex size-2 rounded-full bg-signal"></span>
                </span>
                {{ statusLabels[contest.status] }}
              </span>
            </div>
            <h2 class="mt-5 line-clamp-2 text-lg font-bold transition-colors group-hover:text-primary">{{ contest.title }}</h2>
            <p class="mt-2 line-clamp-2 text-sm leading-6 text-text-secondary">{{ contest.description || t('contest.noDescription') }}</p>
            <div class="mt-auto space-y-2 border-t border-border pt-4 text-xs text-text-secondary">
              <div class="flex items-center gap-2"><UIcon name="i-lucide-calendar-clock" class="size-3.5" />{{ formatDateTime(contest.start_time) }} · {{ formatDuration(contest.start_time, contest.end_time) }}</div>
              <div class="flex items-center gap-4">
                <span class="flex items-center gap-1.5"><UIcon name="i-lucide-users" class="size-3.5" />{{ t('contest.participants', { count: contest.participant_count }) }}</span>
                <span>{{ t('contest.problems', { count: contest.problem_count }) }}</span>
                <span v-if="contest.has_password" class="ml-auto flex items-center gap-1 text-warning-text"><UIcon name="i-lucide-lock-keyhole" class="size-3" />{{ t('contest.password') }}</span>
              </div>
            </div>
          </NuxtLink>
        </div>
      </AsyncContent>

      <PaginationNav :current-page="currentPage" :total-pages="totalPages" @page-change="currentPage = $event" />
    </div>
  </div>
</template>