<template>
  <div
    v-if="available"
    class="flex h-full flex-col bg-white shadow-card animate-[fadeInUp_0.5s_ease_0.15s_both] border border-border rounded-xl"
  >
    <div class="flex items-center gap-2 px-5 py-3.5 border-b border-border">
      <UIcon name="i-lucide-users" class="text-primary shrink-0 size-4" />
      <h3 class="text-sm font-semibold text-text m-0 leading-none">关注动态</h3>
      <button
        class="flex items-center justify-center w-7 h-7 ml-auto rounded-lg text-text-muted transition-colors duration-150 hover:text-primary active:scale-95 disabled:opacity-50"
        title="换一批"
        :disabled="refreshing"
        @click="refresh"
      >
        <UIcon name="i-lucide-refresh-cw" :class="{ 'animate-spin-slow': refreshing }" class="size-3.5" />
      </button>
    </div>
    <div class="flex-1 flex flex-col">
      <div v-if="loading" class="flex items-center justify-center flex-1 gap-2 text-sm text-text-muted">
        <div class="size-4 border-2 border-border border-t-primary rounded-full animate-spin-slow" />
        <span>加载中...</span>
      </div>
      <div v-else-if="error" class="flex items-center justify-center flex-1 px-4 text-center text-sm text-text-muted">
        {{ error }}
      </div>
      <div v-else-if="items.length === 0" class="flex items-center justify-center flex-1 px-4 text-center text-sm leading-relaxed text-text-muted">
        还没有关注动态<br>去用户主页关注感兴趣的人吧
      </div>
      <div v-else class="flex flex-col gap-[10px] p-[10px] flex-1">
        <NuxtLink
          v-for="(item, i) in items"
          :key="itemKey(item)"
          :to="itemHref(item)"
          :style="{ animationDelay: `${0.1 + i * 0.05}s` }"
          class="flex flex-col gap-1 rounded-lg border border-border p-3 no-underline animate-[fadeInUp_0.5s_ease_both] transition-colors duration-150 hover:bg-primary-bg"
        >
          <div class="flex items-center gap-2 text-xs">
            <span class="truncate font-medium text-text">{{ item.author.username }}</span>
            <span v-if="item.kind === 'activity'" class="shrink-0 rounded bg-primary-bg px-1.5 py-0.5 text-primary">
              {{ activityLabel(item.activity!) }}
            </span>
            <NuxtTime
              :datetime="itemTime(item)"
              relative
              locale="zh-CN"
              class="ml-auto shrink-0 text-text-muted"
            />
          </div>
          <p v-if="item.kind === 'moment'" class="line-clamp-2 text-sm leading-relaxed text-text-secondary">
            {{ stripMarkdown(item.post!.content) }}
          </p>
          <p v-else class="text-sm text-primary">查看 →</p>
        </NuxtLink>
      </div>
    </div>
    <NuxtLink
      to="/community"
      class="flex items-center justify-center gap-1 px-5 py-2.5 text-xs font-semibold text-primary no-underline border-t border-border transition-colors duration-150 hover:bg-primary-bg group"
    >
      进入社区
      <UIcon name="i-lucide-arrow-right" class="transition-transform duration-150 group-hover:translate-x-0.5 size-3.5" />
    </NuxtLink>
  </div>
</template>

<script setup lang="ts">
import type { FeedActivity, FeedItem } from "~/composables/useCommunity"
import { stripMarkdown } from "~/utils/markdown"

const { isLoggedIn } = useAuth()
const { config, loadConfig } = useCommunity()

const items = ref<FeedItem[]>([])
const loading = ref(true)
const refreshing = ref(false)
const error = ref("")

/** 卡片可用：已登录 + 关注功能开启 + 有内容模块（动态/活动）支撑 */
const available = computed(
  () => isLoggedIn.value && config.value?.follows_enabled === true &&
    (config.value?.moments_enabled === true ||
      config.value?.activities_enabled === true),
)

const ACTIVITY_LABEL: Record<FeedActivity["type"], string> = {
  first_accepted: "通过了题目",
  solution_published: "发布了题解",
  contest_joined: "参加了竞赛",
}

function activityLabel(a: FeedActivity): string {
  return ACTIVITY_LABEL[a.type] ?? "产生了新动态"
}

function activityHref(a: FeedActivity): string {
  if (a.subject_type === "post") return `/community/posts/${a.subject_id}`
  if (a.subject_type === "problem") return `/problems/${a.subject_id}`
  if (a.subject_type === "contest") return `/contests/${a.subject_id}`
  return "/community"
}

function itemHref(item: FeedItem): string {
  if (item.kind === "moment" && item.post) return `/community/posts/${item.post.id}`
  if (item.kind === "activity" && item.activity) return activityHref(item.activity)
  return "/community"
}

function itemTime(item: FeedItem): string {
  return item.kind === "moment"
    ? item.post!.created_at
    : item.activity!.created_at
}

function itemKey(item: FeedItem): string {
  return `${item.kind}-${item.post?.id ?? item.activity?.id}`
}

async function fetchFeed() {
  if (!available.value) {
    loading.value = false
    return
  }
  loading.value = true
  try {
    const res = await $fetch<{ data: FeedItem[] }>("/api/v1/community/feed", {
      query: { view: "following", limit: 5 },
    })
    items.value = res.data ?? []
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : "加载失败"
  } finally {
    loading.value = false
  }
}

async function refresh() {
  if (refreshing.value) return
  refreshing.value = true
  await fetchFeed()
  refreshing.value = false
}

onMounted(async () => {
  await loadConfig()
  await fetchFeed()
})
</script>
