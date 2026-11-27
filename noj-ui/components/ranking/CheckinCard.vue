<template>
  <div class="flex flex-col items-center justify-center flex-1 gap-1.5 px-3 py-2 text-center">
    <template v-if="isLoggedIn">
      <template v-if="checkInLoaded">
        <div>
          <p class="text-xs text-text-secondary">{{ username }}</p>
        </div>
        <template v-if="!showText">
          <button
            type="button"
            class="inline-flex items-center px-3 py-1 rounded-[4px] text-xs font-semibold transition-colors duration-200 cursor-pointer"
            :class="checkedIn
                            ? (fadeWhite ? 'bg-bg-panel text-signal-deep border border-border' : 'bg-verdict-accepted-bg text-signal-deep border border-signal/30')
                            : 'bg-signal text-on-signal border border-signal hover:bg-signal-deep hover:border-signal-deep'"
            :disabled="checkedIn"
            @click="$emit('checkin')"
          >
            <span class="flex items-center gap-1.5 whitespace-nowrap">
              <UIcon name="i-lucide-check-circle-2" class="shrink-0 size-4" v-if="checkedIn" />
              <span v-else class="size-3.5 rounded-full border-2 border-white/70 shrink-0" />
              <span>{{ checkedIn ? '已签到' : '每日签到' }}</span>
            </span>
          </button>
        </template>
        <div v-else class="inline-flex flex-col items-center gap-1.5">
          <span
            class="inline-flex items-center gap-1.5 text-signal-deep font-semibold py-1 px-3 rounded-sm bg-verdict-accepted-bg border border-signal/25 text-xs">
                        <UIcon name="i-lucide-check-circle-2" class="shrink-0 size-3.5" />
                        今日已签到
                    </span>
          <div v-if="showStreak"
            class="inline-flex items-center gap-1 text-xs text-text-secondary bg-bg-panel px-2.5 py-0.5 rounded-sm border border-border tabular-nums">
                        <UIcon name="i-lucide-flame" class="size-3.5 text-warning-text" />
                        已连续签到 <strong class="text-primary font-semibold">{{ streakCount }}</strong> 天
                    </div>
        </div>
        <p v-if="!checkedIn && streakCount > 0"
          class="inline-flex items-center gap-1 text-xs text-text-secondary tabular-nums">
                    <UIcon name="i-lucide-flame" class="size-3.5 text-warning-text" />
                    已连续签到 {{ streakCount }} 天
                </p>
        <p class="text-[11px] text-text-muted">按 UTC 日期统计 · UTC 0 点刷新</p>
      </template>
    </template>
    <template v-else>
      <div>
        <p class="text-sm font-semibold text-text">登录以解锁</p>
        <p class="text-xs text-text-muted mt-0.5">签到、提交评测与完整学习进度</p>
      </div>
      <div class="flex items-center gap-2 mt-1">
        <NuxtLink
          to="/login"
          class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-sm text-xs font-semibold bg-signal text-on-signal border border-signal no-underline transition-colors hover:bg-signal-deep hover:border-signal-deep"
        >
                    <UIcon name="i-lucide-log-in" class="size-3.5" />
                    登录
                </NuxtLink>
        <NuxtLink
          to="/register"
          class="inline-flex items-center px-3 py-1.5 rounded-sm text-xs font-medium text-primary border border-border bg-bg-panel no-underline transition-colors hover:border-primary/40 hover:bg-primary-bg"
        >
                    注册账号
                </NuxtLink>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
interface Props {
  isLoggedIn: boolean;
  username: string;
  checkedIn: boolean;
  fadeWhite: boolean;
  showText: boolean;
  streakCount: number;
  showStreak: boolean;
  checkInLoaded: boolean;
}

defineProps<Props>();

defineEmits<{
  checkin: [];
}>();
</script>
