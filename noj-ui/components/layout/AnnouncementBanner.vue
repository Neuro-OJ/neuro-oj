<script setup lang="ts">
/**
 * 导航栏下方可关闭公告横幅。
 *
 * - 数据源：`GET /api/v1/announcements/banner`（最新一条带 `banner_text` 的 active 公告）。
 * - 关闭：纯前端 localStorage，绑公告 id（已关闭则不渲染）；发新公告会再出现。
 * - 末尾固定「点击查看详情」超链接到公告详情。
 */

import { publicUrl } from '~/utils/publicIdentifiers';

interface BannerPayload {
  id: string;
  public_id: string;
  banner_text: string;
}

const { api } = useApi();
const { isDismissed, dismiss } = useAnnouncementDismiss();

const banner = ref<BannerPayload | null>(null);

async function load(silent = true) {
  try {
    const res = await api.get<{ data: BannerPayload | null }>(
      '/api/v1/announcements/banner',
      { silent },
    );
    banner.value = res.data;
  } catch {
    // silent：不显示横幅
  }
}

useEventSource({
  url: '/api/v1/announcements/events',
  onEvent: { 'announcement:updated': () => load() },
  fetchFn: () => load(),
  fallbackIntervalMs: 60000,
  enabled: useAuth().isLoggedIn,
});

onMounted(() => load());

/** 当前公告是否应展示（存在且未被关闭）。 */
const visible = computed(() =>
  banner.value !== null && !isDismissed(banner.value.id)
);

function handleDismiss() {
  if (banner.value) dismiss(banner.value.id);
}
</script>

<template>
  <div
    v-if="visible && banner"
    class="flex items-center gap-3 border-b border-border bg-primary-bg px-4 py-2 text-sm text-text"
    role="status"
  >
    <UIcon name="i-lucide-megaphone" class="size-4 shrink-0 text-primary" />
    <span class="min-w-0 flex-1 truncate">{{ banner.banner_text }}</span>
    <NuxtLink
      :to="publicUrl('announcement', banner.public_id || banner.id)"
      class="shrink-0 text-primary no-underline hover:underline"
    >点击查看详情</NuxtLink>
    <button
      type="button"
      class="shrink-0 rounded p-1 text-text-muted hover:bg-black/5 hover:text-text"
      aria-label="关闭公告横幅"
      @click="handleDismiss"
    >
      <UIcon name="i-lucide-x" class="size-4" />
    </button>
  </div>
</template>
