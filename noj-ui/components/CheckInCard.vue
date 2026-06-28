<template>
    <div class="flex flex-col items-center justify-center flex-1 gap-2 px-6 lg:px-8 pb-6 lg:pb-8 text-center">
        <template v-if="isLoggedIn">
            <template v-if="checkInLoaded">
                <div class="animate-fade-item [animation-delay:0.3s]">
                    <p class="text-lg font-semibold text-text">欢迎回来</p>
                    <p class="text-sm text-text-muted mt-1">{{ username }}</p>
                </div>
                <template v-if="!showSettledState">
                    <button
                        class="inline-flex items-center px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-[600ms] cursor-pointer animate-fade-item [animation-delay:0.45s]"
                        :class="checkedIn
                            ? (fadeWhite ? 'bg-white text-green-700 border border-white' : 'bg-green-50 text-green-700 border border-green-200')
                            : 'bg-primary text-white border border-primary hover:bg-primary-dark hover:border-primary-dark'"
                        :disabled="checkedIn"
                        @click="onCheckInClick"
                    >
                        <span
                            class="flex items-center gap-1.5 overflow-hidden transition-[max-width] duration-[1200ms] ease-[cubic-bezier(0.4,0,0.2,1)]"
                            :class="checkedIn ? 'max-w-[280px] min-w-[70px]' : 'max-w-[70px]'"
                        >
                            <CheckCircle2 v-if="checkedIn" :size="18" class="animate-check-icon shrink-0 ml-0.5" />
                            <span v-else class="size-[18px] rounded-full border-2 border-white/60 shrink-0 ml-0.5" />
                            <span class="whitespace-nowrap">
                                <span class="inline-block overflow-hidden align-top transition-all duration-[600ms]" :class="checkedIn ? 'opacity-0 w-0' : 'opacity-100'">签到</span>
                                <span class="inline-block overflow-hidden align-top transition-all duration-[600ms]" :class="checkedIn ? 'opacity-100' : 'opacity-0 w-0'">已签到</span>
                            </span>
                        </span>
                    </button>
                </template>
                <div v-else class="inline-flex flex-col items-center animate-move-up border border-transparent">
                    <span class="inline-flex items-center gap-1.5 text-green-700 text-sm font-semibold py-2 px-4">
                        <CheckCircle2 :size="18" class="shrink-0" />
                        已签到
                    </span>
                    <div class="overflow-hidden transition-all duration-500" :class="showStreak ? 'max-h-5 opacity-100' : 'max-h-0 opacity-0'">
                        <span class="text-xs text-green-800 block pb-0.5">你已经连续签到 {{ streakCount }} 天</span>
                    </div>
                </div>
                <!-- 评审 M1：明确告知按 UTC 计时 -->
                <p class="text-xs text-text-muted mt-2 animate-fade-item [animation-delay:0.6s]">
                    按 UTC 日期统计 · UTC 0 点刷新
                </p>
            </template>
        </template>
        <template v-else>
            <div class="animate-fade-item [animation-delay:0.3s]">
                <p class="text-lg font-semibold text-text">登录以解锁</p>
                <p class="text-sm text-text-muted mt-1">签到、提交等完整功能</p>
            </div>
            <NuxtLink
                to="/login"
                class="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-primary text-white border border-primary no-underline transition-all duration-200 animate-fade-item [animation-delay:0.45s] hover:bg-primary-dark hover:border-primary-dark"
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
    streakCount: number
    checkInLoaded: boolean
}

// 评审 M5：动画中间状态内化，不再要求父组件传 fadeWhite/showText
const emit = defineEmits<{
    checkin: []
}>()

const props = defineProps<Props>()

// showSettledState：true 时显示"已签到" + 连续天数（替代原 showText）
// 在签到成功后由内部 setTimeout 切换
const showSettledState = ref(false)
const fadeWhite = ref(false)
const showStreak = ref(false)
const showRegister = ref(false)

let settledTimer: ReturnType<typeof setTimeout> | null = null
let streakTimer: ReturnType<typeof setTimeout> | null = null
let registerTimer: ReturnType<typeof setTimeout> | null = null

// 已签到时启动"从按钮形态过渡到已签到状态"动画
watch(() => props.checkedIn, (now) => {
    if (now) {
        // 1200ms 后切换到 settled 形态（按钮 max-width 动画完成）
        settledTimer = setTimeout(() => {
            showSettledState.value = true
            // 500ms 后展开连续天数
            streakTimer = setTimeout(() => { showStreak.value = true }, 500)
            // 600ms 后 fadeWhite 切换（按钮变白）
            setTimeout(() => { fadeWhite.value = true }, 600)
        }, 1200)
    } else {
        showSettledState.value = false
        showStreak.value = false
        fadeWhite.value = false
    }
}, { immediate: true })

onMounted(() => {
    registerTimer = setTimeout(() => { showRegister.value = true }, 500)
})

onUnmounted(() => {
    if (settledTimer) clearTimeout(settledTimer)
    if (streakTimer) clearTimeout(streakTimer)
    if (registerTimer) clearTimeout(registerTimer)
})

function onCheckInClick() {
    if (props.checkedIn) return
    emit("checkin")
}
</script>

<style scoped>
.animate-fade-item {
    animation: fadeInItem 0.45s cubic-bezier(0.16, 1, 0.3, 1) both;
}

@keyframes fadeInItem {
    from { opacity: 0; transform: translateY(12px) scale(0.97); }
    to { opacity: 1; transform: translateY(0) scale(1); }
}

.animate-move-up {
    animation: moveUpCheckin 0.5s ease forwards;
}

@keyframes moveUpCheckin {
    from { transform: translateY(0); }
    to { transform: translateY(-4px); }
}

.animate-check-icon {
    animation: check-icon-pop 1.5s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes check-icon-pop {
    0% { transform: scale(0) rotate(-30deg); opacity: 0; }
    60% { transform: scale(1.2) rotate(5deg); opacity: 1; }
    100% { transform: scale(1) rotate(0deg); opacity: 1; }
}
</style>