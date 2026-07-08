<template>
    <div class="flex flex-col items-center justify-center flex-1 gap-2 px-6 lg:px-8 pb-6 lg:pb-8 text-center">
        <template v-if="isLoggedIn">
            <template v-if="checkInLoaded">
                <div class="animate-[fadeInItem_0.45s_cubic-bezier(0.16,1,0.3,1)_both] [animation-delay:0.3s]">
                    <p class="text-lg font-semibold text-text">欢迎回来</p>
                    <p class="text-sm text-text-muted mt-1">{{ username }}</p>
                </div>
                <template v-if="!showText">
                    <button
                        class="inline-flex items-center px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-[600ms] cursor-pointer animate-[fadeInItem_0.45s_cubic-bezier(0.16,1,0.3,1)_both] [animation-delay:0.45s]"
                        :class="checkedIn
                            ? (fadeWhite ? 'bg-white text-green-700 border border-white' : 'bg-green-50 text-green-700 border border-green-200')
                            : 'bg-primary text-white border border-primary hover:bg-primary-dark hover:border-primary-dark'"
                        :disabled="checkedIn"
                        @click="$emit('checkin')"
                    >
                        <span
                            class="flex items-center gap-1.5 overflow-hidden transition-[max-width] duration-[1200ms] ease-[cubic-bezier(0.4,0,0.2,1)]"
                            :class="checkedIn ? 'max-w-[280px] min-w-[70px]' : 'max-w-[70px]'"
                        >
                            <CheckCircle2 v-if="checkedIn" :size="18" class="animate-[check-icon-pop_1.5s_cubic-bezier(0.16,1,0.3,1)] shrink-0 ml-0.5" />
                            <span v-else class="size-[18px] rounded-full border-2 border-white/60 shrink-0 ml-0.5" />
                            <span class="whitespace-nowrap">
                                <span class="inline-block overflow-hidden align-top transition-all duration-[600ms]" :class="checkedIn ? 'opacity-0 w-0' : 'opacity-100'">签到</span>
                                <span class="inline-block overflow-hidden align-top transition-all duration-[600ms]" :class="checkedIn ? 'opacity-100' : 'opacity-0 w-0'">已签到</span>
                            </span>
                        </span>
                    </button>
                </template>
                <div v-else class="inline-flex flex-col items-center animate-[moveUpCheckin_0.5s_ease_forwards] border border-transparent">
                    <span class="inline-flex items-center gap-1.5 text-green-700 text-sm font-semibold py-2 px-4">
                        <CheckCircle2 :size="18" class="shrink-0" />
                        已签到
                    </span>
                    <div class="overflow-hidden transition-all duration-500" :class="showStreak ? 'max-h-5 opacity-100' : 'max-h-0 opacity-0'">
                        <span class="text-xs text-green-800 block pb-0.5">你已经连续签到 {{ streakCount }} 天</span>
                    </div>
                </div>
                <p class="text-xs text-text-muted mt-3 animate-[fadeInItem_0.45s_cubic-bezier(0.16,1,0.3,1)_both] [animation-delay:0.6s]">按 UTC 日期统计 · UTC 0 点刷新</p>
            </template>
        </template>
        <template v-else>
            <div>
                <p class="text-lg font-semibold text-text animate-[fadeInUp_0.5s_ease_0.1s_both]">登录以解锁</p>
                <p class="text-sm text-text-muted mt-1 animate-[fadeInUp_0.5s_ease_0.15s_both]">签到、提交等完整功能</p>
            </div>
            <NuxtLink
                to="/login"
                class="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-primary text-white border border-primary no-underline transition-all duration-200 animate-[fadeInUp_0.5s_ease_0.2s_both] hover:bg-primary-dark hover:border-primary-dark"
            >
                <LogIn :size="16" />
                登录
            </NuxtLink>
            <div class="overflow-hidden transition-all duration-500" :class="showRegister ? 'max-h-5 opacity-100' : 'max-h-0 opacity-0'">
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
import { CheckCircle2, LogIn } from "@lucide/vue"

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

<style scoped>
@keyframes fadeInItem {
    from { opacity: 0; transform: translateY(12px) scale(0.97); }
    to { opacity: 1; transform: translateY(0) scale(1); }
}

@keyframes moveUpCheckin {
    from { transform: translateY(0); }
    to { transform: translateY(-4px); }
}

@keyframes check-icon-pop {
    0% { transform: scale(0) rotate(-30deg); opacity: 0; }
    60% { transform: scale(1.2) rotate(5deg); opacity: 1; }
    100% { transform: scale(1) rotate(0deg); opacity: 1; }
}
</style>
