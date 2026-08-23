<script setup lang="ts">
import type { BookmarkRow, PostType } from "~/composables/useCommunity"
import { stripMarkdown } from "~/utils/markdown"
import { extractApiError } from "~/utils/apiError"

definePageMeta({ middleware: "auth" })

const typeLabel: Record<PostType, string> = {
  discussion: "讨论",
  solution: "题解",
  moment: "动态",
}

const bookmarks = ref<BookmarkRow[]>([])
const loading = ref(true)
const loadingMore = ref(false)
const error = ref("")
const nextCursor = ref<string | null>(null)
const removingId = ref<string | null>(null)
const { toast } = useToast()
const { dialog } = useDialog()
const { api } = useApi()

async function loadBookmarks(reset = true, cursor?: string | null) {
  if (reset) {
    loading.value = true
    nextCursor.value = null
  } else {
    loadingMore.value = true
  }
  error.value = ""
  try {
    const result = await api.get<{ data: BookmarkRow[]; next_cursor: string | null }>(
      "/api/v1/community/bookmarks",
      { query: { cursor: cursor ?? undefined }, silent: true },
    )
    bookmarks.value = reset ? result.data : [...bookmarks.value, ...result.data]
    nextCursor.value = result.next_cursor ?? null
  } catch (err: unknown) {
    error.value = extractApiError(err).message
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}

async function loadMore() {
  if (loadingMore.value || !nextCursor.value) return
  await loadBookmarks(false, nextCursor.value)
}

async function removeBookmark(item: BookmarkRow) {
  const ok = await dialog.confirm("确定取消收藏这篇内容吗？", {
    title: "取消收藏",
    danger: true,
    confirmText: "取消收藏",
  })
  if (!ok || removingId.value) return
  removingId.value = item.post.id
  try {
    await api.post(`/api/v1/community/posts/${item.post.id}/bookmark`)
    toast.success("已取消收藏")
    bookmarks.value = bookmarks.value.filter((b) => b.post.id !== item.post.id)
  } finally {
    removingId.value = null
  }
}

await loadBookmarks()
</script>

<template>
  <main class="mx-auto w-full max-w-4xl px-6 py-10">
    <div class="mb-7 flex flex-wrap items-center justify-between gap-4">
      <div>
        <NuxtLink to="/community" class="inline-flex items-center gap-1.5 text-base text-text-secondary hover:text-primary"><UIcon name="i-lucide-arrow-left" class="size-4" />返回社区</NuxtLink>
        <h1 class="mt-3 text-3xl font-bold text-text">我的收藏</h1>
        <p class="mt-2 text-text-secondary">集中查看你收藏的社区内容。</p>
      </div>
      <UButton color="primary" variant="outline" type="button"  :disabled="loading" @click="loadBookmarks()">
        <UIcon name="i-lucide-refresh-cw" :class="{ 'animate-spin': loading }" class="size-4" />刷新
      </UButton>
    </div>

    <p v-if="error" class="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">{{ error }}</p>
    <div v-else-if="loading" class="py-12 text-center text-text-secondary">加载中…</div>
    <div v-else-if="bookmarks.length === 0" class="rounded-lg border border-dashed border-border p-10 text-text-secondary flex items-center justify-center gap-2">
      <UIcon name="i-lucide-bookmark" class="text-text-secondary size-[28px]" />
      还没有可展示的收藏内容。
    </div>
    <div v-else class="space-y-4">
      <article v-for="item in bookmarks" :key="item.post.id" class="rounded-lg border border-border bg-white p-5 shadow-card">
        <div class="mb-2 flex flex-wrap items-center gap-2">
          <span class="rounded bg-primary-bg px-2 py-0.5 text-xs text-primary">{{ typeLabel[item.post.type] }}</span>
          <span v-if="item.post.status === 'pending'" class="rounded bg-yellow-100 px-2 py-0.5 text-xs text-yellow-800">审核中</span>
          <span v-if="item.post.status === 'hidden'" class="rounded bg-red-50 px-2 py-0.5 text-xs text-red-700">已隐藏</span>
        </div>
        <NuxtLink :to="`/community/posts/${item.post.id}`" class="block no-underline">
          <h2 v-if="item.post.title" class="text-lg font-semibold text-text hover:text-primary">{{ item.post.title }}</h2>
          <p class="mt-2 line-clamp-3 text-sm leading-6 text-text-secondary">{{ stripMarkdown(item.post.content) }}</p>
        </NuxtLink>
        <div class="mt-4 flex flex-wrap items-center gap-4 text-xs text-text-secondary">
          <UserIdentity :user="item.author" size="sm" />
          <span>收藏于 <NuxtTime :datetime="item.bookmarked_at" relative locale="zh-CN" /></span>
          <span><UIcon name="i-lucide-heart" class="mr-1 inline size-3.5" />{{ item.likes }}</span>
          <span><UIcon name="i-lucide-message-square" class="mr-1 inline size-3.5" />{{ item.comments }}</span>
          <button class="inline-flex items-center gap-1 text-red-600 hover:text-red-700" :disabled="removingId !== null" @click="removeBookmark(item)"><UIcon name="i-lucide-trash-2" class="size-3" />{{ removingId === item.post.id ? '处理中…' : '取消收藏' }}</button>
        </div>
      </article>
      <div v-if="nextCursor" class="text-center">
        <UButton color="primary" variant="outline" :disabled="loadingMore" @click="loadMore">{{ loadingMore ? '加载中…' : '加载更多' }}</UButton>
      </div>
    </div>
  </main>
</template>
