<script setup lang="ts">
import type { Contest, ContestStatus, ContestType } from '~/composables/useContests'
import { publicUrl } from '~/utils/publicIdentifiers'

useHead({ title: '竞赛大厅 - Neuro OJ' })

const { typeLabels, statusLabels, formatDateTime, formatDuration, statusClass } = useContests()
const selectedType = ref<ContestType | undefined>(undefined)
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
    <div class="mx-auto max-w-[960px] space-y-7 px-4 sm:px-7">
      <section class="relative overflow-hidden rounded-2xl bg-bg-dark px-8 py-9 text-white shadow-card">
        <div class="absolute -right-20 -top-20 size-64 rounded-full bg-signal/30 blur-3xl" />
        <div class="relative max-w-2xl">
          <div class="mb-3 inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs">
            <UIcon name="i-lucide-trophy" class="size-3.5" />
            NOJ Contest
          </div>
          <h1 class="text-3xl font-bold">竞赛大厅</h1>
          <p class="mt-3 text-sm leading-6 text-slate-300">参加 ICPC、IOI 与 OI 赛制竞赛，在限定时间内挑战题目并实时查看排名。</p>
        </div>
      </section>

      <section class="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-white p-4">
        <USelect v-model="selectedType" :items="[{ label: 'ICPC', value: 'icpc' }, { label: 'IOI', value: 'ioi' }, { label: 'OI', value: 'oi' }]" placeholder="全部赛制" class="min-w-[120px]" />
        <USelect v-model="selectedStatus" :items="[{ label: '未开始', value: 'pending' }, { label: '进行中', value: 'running' }, { label: '已结束', value: 'ended' }]" placeholder="全部状态" class="min-w-[120px]" />
        <span class="ml-auto text-xs text-text-muted">共 {{ filteredContests.length }} 场竞赛</span>
      </section>

      <AsyncContent
        :status="pending ? 'loading' : error ? 'error' : pagedContests.length ? 'data' : 'empty'"
        error="竞赛列表加载失败"
        empty-text="暂无符合条件的竞赛"
        @retry="refresh"
      >
        <div class="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          <NuxtLink
            v-for="contest in pagedContests"
            :key="contest.id"
            :to="publicUrl('contest', contest.public_id || contest.id)"
            class="group flex min-h-64 flex-col rounded-xl border border-border bg-white p-5 text-text no-underline shadow-sm transition-all hover:-translate-y-1 hover:border-signal/40 hover:shadow-card"
          >
            <div class="flex items-start justify-between gap-3">
              <span class="rounded-md bg-primary-bg px-2.5 py-1 text-xs font-semibold text-primary-text">{{ typeLabels[contest.type] }}</span>
              <span class="rounded-full border px-2.5 py-1 text-xs font-semibold" :class="statusClass(contest.status)">{{ statusLabels[contest.status] }}</span>
            </div>
            <h2 class="mt-5 line-clamp-2 text-lg font-bold transition-colors group-hover:text-primary">{{ contest.title }}</h2>
            <p class="mt-2 line-clamp-2 text-sm leading-6 text-text-secondary">{{ contest.description || '暂无竞赛简介' }}</p>
            <div class="mt-auto space-y-2 border-t border-border pt-4 text-xs text-text-secondary">
              <div class="flex items-center gap-2"><UIcon name="i-lucide-calendar-clock" class="size-3.5" />{{ formatDateTime(contest.start_time) }} · {{ formatDuration(contest.start_time, contest.end_time) }}</div>
              <div class="flex items-center gap-4">
                <span class="flex items-center gap-1.5"><UIcon name="i-lucide-users" class="size-3.5" />{{ contest.participant_count }} 人</span>
                <span>{{ contest.problem_count }} 题</span>
                <span v-if="contest.has_password" class="ml-auto flex items-center gap-1 text-warning-text"><UIcon name="i-lucide-lock-keyhole" class="size-3" />密码</span>
              </div>
            </div>
          </NuxtLink>
        </div>
      </AsyncContent>

      <PaginationNav :current-page="currentPage" :total-pages="totalPages" @page-change="currentPage = $event" />
    </div>
  </div>
</template>
