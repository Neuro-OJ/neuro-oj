<script setup lang="ts">
import { formatDateTime } from "~/utils/submissionFormat"

interface AnnouncementSummary {
  id: string
  title: string
  excerpt: string
  is_pinned: boolean
  created_at: string
  updated_at: string
}

interface AnnouncementListData {
  data: AnnouncementSummary[]
  meta: {
    page: number
    per_page: number
    total: number
    total_pages: number
  }
}

const { api } = useApi()

const data = ref<AnnouncementListData | null>(null)
const currentPage = ref(1)
const perPage = 20

async function load(page = currentPage.value) {
  try {
    const res = await api.get<AnnouncementListData>(
      `/api/v1/announcements?page=${page}&per_page=${perPage}`,
      { silent: true },
    )
    data.value = res
    currentPage.value = res.meta.page
  } catch {
    // silent：保持空态
  }
}

onMounted(() => load(1))
</script>

<template>
  <div class="max-w-[900px] mx-auto px-4 py-6 pb-16">
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-bold">公告</h1>
    </div>

    <div v-if="!data" class="flex items-center justify-center gap-2 py-16 text-text-muted">
      <UIcon name="i-lucide-loader-2" class="size-6" />
      <span>加载中...</span>
    </div>

    <template v-else>
      <div v-if="data.data.length === 0" class="bg-white border border-border rounded-xl p-8 text-center text-text-muted">
        暂无公告
      </div>

      <div v-else class="bg-white border border-border rounded-xl divide-y divide-border overflow-hidden">
        <NuxtLink
          v-for="item in data.data"
          :key="item.id"
          :to="`/announcements/${item.id}`"
          class="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 px-5 py-4 hover:bg-gray-50 transition-colors"
        >
          <div class="flex items-center gap-2 min-w-0 flex-1">
            <span
              v-if="item.is_pinned"
              class="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-700"
            >
              <UIcon name="i-lucide-pin" class="size-3" />
              置顶
            </span>
            <span class="font-medium text-15px truncate">{{ item.title }}</span>
          </div>
          <span v-if="item.excerpt" class="text-13px text-text-muted truncate max-w-[320px] hidden md:block">
            {{ item.excerpt }}
          </span>
          <span class="shrink-0 text-13px text-text-muted">{{ formatDateTime(item.created_at) }}</span>
        </NuxtLink>
      </div>

      <PaginationNav
        v-if="data.meta.total_pages > 1"
        :current-page="data.meta.page"
        :total-pages="data.meta.total_pages"
        class="mt-6"
        @page-change="load($event)"
      />
    </template>
  </div>
</template>
