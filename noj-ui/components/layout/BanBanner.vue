<script setup lang="ts">
import type { IpBanInfo, UserBanInfo } from '~/composables/useBanStatus';

const props = defineProps<{
    type: 'ip' | 'user';
    ipInfo?: IpBanInfo | null;
    userInfo?: UserBanInfo | null;
}>();

const auth = useAuth();

function formatExpiry(iso: string | null): string {
    if (!iso) return '永久';
    try {
        const d = new Date(iso);
        return d.toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            timeZoneName: 'short',
        });
    } catch {
        return iso;
    }
}

function handleLogout() {
    auth.logout();
    window.location.href = '/login';
}
</script>

<template>
    <div
        v-if="type === 'ip'"
        class="fixed top-16 left-0 right-0 z-[999] bg-warning-bg border-b border-warning-border px-4 py-3 shadow-sm"
    >
        <div class="max-w-4xl mx-auto flex items-center justify-between gap-4">
            <div class="flex items-center gap-2 text-warning-text text-sm">
                <span
                    class="font-semibold flex items-center gap-1"><UIcon name="i-lucide-triangle-alert" class="size-4" />IP 限制访问</span>
                <span class="text-warning-text">·</span>
                <span v-if="ipInfo">
          您的 IP（{{ ipInfo.matched_cidr }}）已被限制访问。
          {{ ipInfo.reason ? `原因：${ipInfo.reason}。` : '' }}
          到期：{{ formatExpiry(ipInfo.expires_at) }}。
        </span>
                <span v-else>您的 IP 已被限制访问。请联系管理员。</span>
            </div>
        </div>
    </div>

    <div
        v-if="type === 'user'"
        class="fixed top-16 left-0 right-0 z-[999] bg-error-text/5 border-b border-error-text/20 px-4 py-3 shadow-sm"
    >
        <div class="max-w-4xl mx-auto flex items-center justify-between gap-4">
            <div class="flex items-center gap-2 text-error-text text-sm">
                <span
                    class="font-semibold flex items-center gap-1"><UIcon name="i-lucide-ban" class="size-4" />账号被封禁</span>
                <span class="text-error-text">·</span>
                <span v-if="userInfo">
          您的账号已被{{ userInfo.until ? `封禁至 ${formatExpiry(userInfo.until)}` : '永久封禁' }}。
          {{ userInfo.reason ? `原因：${userInfo.reason}。` : '' }}
          请联系管理员。
        </span>
                <span v-else>您的账号已被封禁。请联系管理员。</span>
            </div>
            <UButton
                type="button"
                color="error"
                variant="soft"
                size="xs"
                icon="i-lucide-log-out"
                class="shrink-0 gap-1.5 font-semibold"
                @click="handleLogout"
            >
        登出
      </UButton>
        </div>
    </div>
</template>
