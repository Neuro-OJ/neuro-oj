<script setup lang="ts">
/**
 * 首页常驻公告区块（不可关闭）。
 *
 * 展示全部 active 公告（title + excerpt + 「点击查看详情」），
 * 与导航栏横幅（可关闭）双通道并存。数据源与轮播解耦。
 */

import { publicUrl } from '~/utils/publicIdentifiers';

interface AnnouncementListItem {
  id: string;
  public_id?: string;
  title: string;
  excerpt: string;
  is_pinned: boolean;
  created_at: string;
}

const { api } = useApi();
const items = ref<AnnouncementListItem[]>([]);
const loading = ref(true);

async function load(silent = true) {
  try {
    const res = await api.get<{ data: AnnouncementListItem[] }>(
      '/api/v1/announcements?per_page=10',
      { silent },
    );
    items.value = res.data;
  } catch {
    // silent：保持空态
  } finally {
    loading.value = false;
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
</script>

<template>
  <section
    v-if="items.length > 0"
    class="border-b border-border px-4 py-5 sm:px-6"
    aria-label="公告"
  >
    <h2 class="mb-3 text-lg font-semibold text-text">公告</h2>
    <ul class="flex flex-col gap-2">
      <li
        v-for="item in items"
        :key="item.id"
        class="rounded-lg border border-border px-4 py-3 transition-colors hover:border-primary"
      >
        <div class="flex items-start gap-2">
          <UBadge v-if="item.is_pinned" color="primary" variant="subtle" size="sm">置顶</UBadge>
          <div class="min-w-0 flex-1">
            <p class="font-medium text-text">{{ item.title }}</p>
            <p class="mt-0.5 line-clamp-2 text-sm text-text-secondary">{{ item.excerpt }}</p>
          </div>
          <NuxtLink
            :to="publicUrl('announcement', item.public_id || item.id)"
            class="shrink-0 self-center text-sm text-primary no-underline hover:underline"
          >点击查看详情</NuxtLink>
        </div>
      </li>
    </ul>
  </section>
</template>
