<script setup lang="ts">
import { workspaceCacheKey } from '~/utils/workspace';
const slug = useNavigationDomain(), { user } = useAuth(), { api } = useApi();
const { isDismissed, dismiss } = useAnnouncementDismiss();
interface BannerPayload { id: string; public_id: string; banner_text: string; domain_id: string | null }
const { data, error, refresh } = await useAsyncData(
  () => workspaceCacheKey(slug.value, user.value?.id ?? null, 'announcement-banner'),
  () => api.get<{data: BannerPayload | null}>(`/api/v1/domains/${slug.value}/announcements/banner`, {silent:true, redirectOnUnauthorized:false}));
const banner = computed(() => error.value ? null : data.value?.data ?? null);
const visible = computed(() => !!banner.value && !isDismissed(banner.value.id));
function handleDismiss() { if (banner.value) dismiss(banner.value.id); }
usePolling({ intervalMs:60000, immediate:false, fetcher: () => refresh() });
</script>

<template>
  <div
    v-if="visible && banner"
    class="flex items-center gap-3 border-b border-border bg-primary-bg px-4 py-2 text-sm text-text"
    role="status"
  >
    <UIcon name="i-lucide-megaphone" class="size-4 shrink-0 text-primary" />
    <UBadge color="neutral" variant="subtle" size="sm" class="shrink-0">{{ banner.domain_id ? '本域' : '实例' }}</UBadge>
    <span class="min-w-0 flex-1 truncate">{{ banner.banner_text }}</span>
    <NuxtLink
      :to="`/d/${slug}/announcements/${banner.public_id || banner.id}`"
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
