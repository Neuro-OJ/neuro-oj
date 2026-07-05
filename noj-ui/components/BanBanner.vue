<script setup lang="ts">
import { LogOut } from "@lucide/vue"
import type { IpBanInfo, UserBanInfo } from "../composables/useBanStatus"

definePageMeta({
  ssr: false,
})

const props = defineProps<{
  type: "ip" | "user"
  ipInfo?: IpBanInfo | null
  userInfo?: UserBanInfo | null
}>()

const auth = useAuth()

function formatExpiry(iso: string | null): string {
  if (!iso) return "永久"
  try {
    const d = new Date(iso)
    return d.toLocaleString("zh-CN", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", timeZoneName: "short",
    })
  } catch {
    return iso
  }
}

function handleLogout() {
  auth.logout()
  window.location.href = "/login"
}
</script>

<template>
  <div
    v-if="type === 'ip'"
    class="fixed top-16 left-0 right-0 z-[999] bg-amber-50 border-b border-amber-200 px-4 py-3 shadow-sm"
  >
    <div class="max-w-4xl mx-auto flex items-center justify-between gap-4">
      <div class="flex items-center gap-2 text-amber-800 text-sm">
        <span class="font-semibold">⚠ IP 限制访问</span>
        <span class="text-amber-600">·</span>
        <span v-if="ipInfo">
          您的 IP（{{ ipInfo.matched_cidr }}）已被限制访问。
          {{ ipInfo.reason ? `原因：${ipInfo.reason}。` : "" }}
          到期：{{ formatExpiry(ipInfo.expires_at) }}。
        </span>
        <span v-else>您的 IP 已被限制访问。请联系管理员。</span>
      </div>
    </div>
  </div>

  <div
    v-if="type === 'user'"
    class="fixed top-16 left-0 right-0 z-[999] bg-red-50 border-b border-red-200 px-4 py-3 shadow-sm"
  >
    <div class="max-w-4xl mx-auto flex items-center justify-between gap-4">
      <div class="flex items-center gap-2 text-red-800 text-sm">
        <span class="font-semibold">🚫 账号被封禁</span>
        <span class="text-red-600">·</span>
        <span v-if="userInfo">
          您的账号已被封禁{{ userInfo.until ? `至 ${formatExpiry(userInfo.until)}` : "" }}。
          {{ userInfo.reason ? `原因：${userInfo.reason}。` : "" }}
          请联系管理员。
        </span>
        <span v-else>您的账号已被封禁。请联系管理员。</span>
      </div>
      <button
        class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-red-700 bg-red-100 border border-red-200 rounded-md hover:bg-red-200 transition-colors shrink-0"
        @click="handleLogout"
      >
        <LogOut :size="14" />
        登出
      </button>
    </div>
  </div>
</template>
