<template>
    <div class="flex flex-col items-center justify-center flex-1 gap-2 px-6 lg:px-8 pb-6 lg:pb-8 text-center">
        <template v-if="isLoggedIn">
            <template v-if="checkInLoaded">
                <div>
                    <p class="text-lg font-semibold text-text">欢迎回来</p>
                    <p class="text-sm text-text-muted mt-1">{{ username }}</p>
                </div>
                <template v-if="!showText">
                    <button
                        class="inline-flex items-center px-4 py-2 rounded-md text-sm font-semibold transition-colors duration-[600ms] cursor-pointer"
                        :class="checkedIn
                            ? (fadeWhite ? 'bg-white text-signal-deep border border-white' : 'bg-signal/10 text-signal-deep border border-signal/20')
                            : 'bg-signal text-on-signal border border-signal hover:bg-signal/80 hover:border-signal/80'"
                        :disabled="checkedIn"
                        @click="$emit('checkin')"
                    >
                        <span
                            class="flex items-center gap-1.5 overflow-hidden transition-[max-width] duration-[1200ms] ease-[cubic-bezier(0.4,0,0.2,1)]"
                            :class="checkedIn ? 'max-w-[280px] min-w-[70px]' : 'max-w-[70px]'"
                        >
                            <UIcon name="i-lucide-check-circle-2" class="shrink-0 ml-0.5 size-4.5" v-if="checkedIn"/>
                            <span v-else class="size-[18px] rounded-full border-2 border-white/60 shrink-0 ml-0.5" />
                            <span class="whitespace-nowrap">
                                <span class="inline-block overflow-hidden align-top transition-[width,opacity] duration-[600ms]" :class="checkedIn ? 'opacity-0 w-0' : 'opacity-100'">签到</span>
                                <span class="inline-block overflow-hidden align-top transition-[width,opacity] duration-[600ms]" :class="checkedIn ? 'opacity-100' : 'opacity-0 w-0'">已签到</span>
                            </span>
                        </span>
                    </button>
                </template>
                <div v-else class="inline-flex flex-col items-center border border-transparent">
                    <span class="inline-flex items-center gap-1.5 text-signal font-semibold py-1.5 px-3.5 rounded-full bg-signal/10 border border-signal/20 text-sm">
                        <UIcon name="i-lucide-check-circle-2" class="shrink-0 size-4" />
                        已签到
                    </span>
                    <div class="overflow-hidden transition-[max-height,opacity] duration-500 mt-2" :class="showStreak ? 'max-h-7 opacity-100' : 'max-h-0 opacity-0'">
                        <span class="inline-flex items-center gap-1 text-xs text-text-secondary bg-white/90 px-2.5 py-1 rounded-full border border-border shadow-xs tabular-nums">
                            <UIcon name="i-lucide-flame" class="size-3.5 text-warning-text" />
                            已连续签到 <strong class="text-primary font-semibold">{{ streakCount }}</strong> 天
                        </span>
                    </div>
                </div>
                <p v-if="!checkedIn && streakCount > 0" class="inline-flex items-center gap-1 text-xs text-text-secondary mt-3 tabular-nums">
                    <UIcon name="i-lucide-flame" class="size-3.5 text-warning-text" />
                    已连续签到 {{ streakCount }} 天
                </p>
                <p class="text-xs text-text-muted mt-2">按 UTC 日期统计 · UTC 0 点刷新</p>
            </template>
        </template>
        <template v-else>
            <div>
                <p class="text-lg font-semibold text-text">登录以解锁</p>
                <p class="text-sm text-text-muted mt-1">签到、提交等完整功能</p>
            </div>
            <NuxtLink
                to="/login"
                class="inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-semibold bg-signal text-on-signal border border-signal no-underline transition-colors duration-200 hover:bg-signal/80 hover:border-signal/80"
            >
                <UIcon name="i-lucide-log-in" class="size-4" />
                登录
            </NuxtLink>
            <div class="overflow-hidden transition-[max-height,opacity] duration-500" :class="showRegister ? 'max-h-5 opacity-100' : 'max-h-0 opacity-0'">
                <NuxtLink
                    to="/register"
                    class="text-xs text-primary no-underline font-medium hover:underline block"
                >
                    没有账号？立即注册
                </NuxtLink>
            </div>
        </template>
    </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue"

interface Props {
    isLoggedIn: boolean
    username: string
    checkedIn: boolean
    fadeWhite: boolean
    showText: boolean
    streakCount: number
    showStreak: boolean
    checkInLoaded: boolean
}

defineProps<Props>()

defineEmits<{
    checkin: []
}>()

const showRegister = ref(false)
let registerTimer: ReturnType<typeof setTimeout> | null = null

onMounted(() => {
    registerTimer = setTimeout(() => { showRegister.value = true }, 500)
})

onUnmounted(() => {
    if (registerTimer) clearTimeout(registerTimer)
})
</script>
