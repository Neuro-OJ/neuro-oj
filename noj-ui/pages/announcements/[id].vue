<script setup lang="ts">
import { formatDateTime } from "~/utils/submissionFormat"

interface AnnouncementDetail {
  id: string
  title: string
  content: string
  is_pinned: boolean
  created_at: string
  updated_at: string
  created_by: string
}

const route = useRoute()
const { api } = useApi()

const detail = ref<AnnouncementDetail | null>(null)
const notFound = ref(false)
const loading = ref(true)

async function load() {
  loading.value = true
  notFound.value = false
  try {
    const res = await api.get<AnnouncementDetail>(
      `/api/v1/announcements/${route.params.id}`,
      { silent: true },
    )
    detail.value = res
  } catch {
    // 非 active 或不存在 → 404 占位
    notFound.value = true
  } finally {
    loading.value = false
  }
}

onMounted(load)

// 详情页标题（浏览器标签）
useHead(() => ({
  title: detail.value ? `${detail.value.title} - 公告` : "公告",
}))
</script>

<template>
  <div class="max-w-[900px] mx-auto px-4 py-6 pb-16">
    <div v-if="loading" class="flex items-center justify-center gap-2 py-16 text-text-muted">
      <UIcon name="i-lucide-loader-2" class="size-6" />
      <span>加载中...</span>
    </div>

    <div v-else-if="notFound || !detail" class="bg-white border border-border rounded-xl p-12 text-center">
      <UIcon name="i-lucide-megaphone-off" class="size-10 text-text-muted mb-3" />
      <p class="text-text-muted">公告不存在或已下架</p>
      <NuxtLink to="/announcements" class="inline-block mt-4 text-sm text-blue-600 hover:underline">
        返回公告列表
      </NuxtLink>
    </div>

    <article v-else class="bg-white border border-border rounded-xl overflow-hidden">
      <header class="px-6 pt-6 pb-4 border-b border-border">
        <div class="flex items-center gap-2 mb-2">
          <span
            v-if="detail.is_pinned"
            class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-700"
          >
            <UIcon name="i-lucide-pin" class="size-3" />
            置顶
          </span>
        </div>
        <h1 class="text-2xl font-bold">{{ detail.title }}</h1>
        <p class="mt-2 text-13px text-text-muted">发布于 {{ formatDateTime(detail.created_at) }}</p>
      </header>
      <div class="px-6 py-6">
        <MarkdownRenderer :content="detail.content" />
      </div>
    </article>
  </div>
</template>
