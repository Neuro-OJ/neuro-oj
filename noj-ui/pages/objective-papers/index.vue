<script setup lang="ts">
import type { ObjectivePaper } from '~/composables/useObjective'

definePageMeta({ ssr: false })

useHead({ title: '客观题 - Neuro OJ' })

const { listPapers } = useObjective()
const { user } = useAuth()
const currentPage = ref(1)
const perPage = 10

const { data, pending, error, refresh } = await useAsyncData(
  'objective-papers',
  () => listPapers(currentPage.value, perPage),
  { watch: [currentPage] },
)

const papers = computed<ObjectivePaper[]>(() => data.value?.data ?? [])
const total = computed(() => data.value?.total ?? 0)
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / perPage)))

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false })
}
</script>

<template>
  <div class="min-h-[calc(100vh-64px)] bg-bg-page p-4 lg:p-6">
    <div class="mx-auto max-w-[960px] space-y-4">
      <header class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 class="text-xl font-bold text-text">客观题</h1>
          <p class="mt-1 text-sm text-text-secondary">
            客观题卷（单选 / 多选 / 判断），提交后即时判定
          </p>
        </div>
        <UButton
          v-if="user"
          icon="i-lucide-plus"
          color="primary"
          :to="'/objective-papers/new'"
        >
          新建套卷
        </UButton>
      </header>

      <AsyncContent
        :status="pending ? 'loading' : error ? 'error' : papers.length ? 'data' : 'empty'"
        error="套卷列表加载失败"
        empty-text="暂无客观题套卷"
        @retry="refresh"
      >
        <div v-if="papers.length" class="flex flex-col gap-3">
          <NuxtLink
            v-for="paper in papers"
            :key="paper.id"
            :to="`/objective-papers/${paper.id}`"
            class="group rounded-xl border border-border bg-white p-4 no-underline transition-shadow hover:shadow-md"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <span
                    class="inline-flex items-center rounded bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                  >
                    {{ paper.display_id }}
                  </span>
                  <h2 class="truncate font-semibold text-text group-hover:text-primary">
                    {{ paper.title }}
                  </h2>
                </div>
                <p class="mt-1 line-clamp-2 text-sm text-text-secondary">
                  {{ paper.description }}
                </p>
              </div>
              <span class="shrink-0 text-xs text-text-muted">
                {{ formatDate(paper.created_at) }}
              </span>
            </div>
          </NuxtLink>
        </div>
      </AsyncContent>

      <div v-if="totalPages > 1" class="flex justify-center pt-2">
        <PaginationNav :current-page="currentPage" :total-pages="totalPages" @page-change="currentPage = $event" />
      </div>
    </div>
  </div>
</template>
