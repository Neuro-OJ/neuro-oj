<template>
    <div class="py-6">
        <div class="mx-auto w-full max-w-[1320px] border border-border rounded-xl shadow-card flex flex-col overflow-hidden">
            <div class="flex flex-col flex-1">
                <div class="flex flex-col lg:flex-row flex-1 min-h-[320px] bg-white">
                    <!-- Carousel -->
                    <div
                        class="flex-1 min-w-0 relative overflow-hidden"
                        role="region"
                        aria-roledescription="轮播图"
                        aria-label="公告轮播"
                        aria-live="off"
                        @mouseenter="stopAuto"
                        @mouseleave="() => { if (!paused) startAuto() }"
                    >
                        <Transition name="carousel-fade">
                            <div
                                v-if="announcements.length > 0"
                                :key="currentSlide"
                                class="absolute inset-0 bg-gradient-to-br p-8 lg:p-12 flex flex-col justify-center text-white"
                                :class="gradientFor(currentSlide)"
                            >
                                <h2 class="text-2xl lg:text-3xl font-bold mb-3 animate-[slideInUp_0.6s_cubic-bezier(0.16,1,0.3,1)_both]">{{ announcements[currentSlide].title }}</h2>
                                <p class="text-sm lg:text-base text-white/85 max-w-[480px] leading-relaxed animate-[slideInUp_0.6s_cubic-bezier(0.16,1,0.3,1)_150ms_both]">{{ announcements[currentSlide].excerpt }}</p>
                                <!-- 点击跳转公告详情（整卡可点，按钮层 z-10 在其上不受影响） -->
                                <NuxtLink
                                    :to="`/announcements/${announcements[currentSlide].id}`"
                                    class="absolute inset-0 z-[5]"
                                    :aria-label="`查看公告：${announcements[currentSlide].title}`"
                                />
                                <span class="relative z-[6] mt-4 inline-flex items-center gap-1 text-sm font-medium text-white/90 pointer-events-none animate-[slideInUp_0.6s_cubic-bezier(0.16,1,0.3,1)_300ms_both]">
                                    查看详情
                                    <UIcon name="i-lucide-arrow-right" class="size-4" />
                                </span>
                            </div>
                            <!-- 空态：无 active 公告时显示默认欢迎占位 -->
                            <div
                                v-else
                                class="absolute inset-0 bg-gradient-to-br from-blue-600 via-sky-500 to-cyan-400 p-8 lg:p-12 flex flex-col justify-center text-white"
                            >
                                <h2 class="text-2xl lg:text-3xl font-bold mb-3 animate-[slideInUp_0.6s_cubic-bezier(0.16,1,0.3,1)_both]">Neuro OJ 正式上线</h2>
                                <p class="text-sm lg:text-base text-white/85 max-w-[480px] leading-relaxed animate-[slideInUp_0.6s_cubic-bezier(0.16,1,0.3,1)_150ms_both]">面向 LMCC 的在线评测系统现已开放注册，提供高效的代码评测服务和智能化的能力评估。</p>
                            </div>
                        </Transition>
                        <!-- 暂停/继续（WCAG 2.2.2 自动更新内容可暂停） -->
                        <button
                            v-if="!paused"
                            type="button"
                            class="absolute bottom-4 right-4 z-10 p-2 rounded-full bg-black/30 text-white hover:bg-black/50 transition-colors"
                            aria-label="暂停轮播"
                            @click="togglePause"
                        >
                            <UIcon name="i-lucide-pause" class="size-4" />
                        </button>
                        <button
                            v-else
                            type="button"
                            class="absolute bottom-4 right-4 z-10 p-2 rounded-full bg-black/40 text-white hover:bg-black/60 transition-colors"
                            aria-label="继续轮播"
                            @click="togglePause"
                        >
                            <UIcon name="i-lucide-play" class="size-4" />
                        </button>
                        <div class="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1.5 z-10">
                            <button
                                v-for="(_, i) in announcements"
                                :key="i"
                                class="p-2 -m-2 rounded-full transition-opacity cursor-pointer group"
                                :aria-label="`切换到第 ${i + 1} 张`"
                                :aria-current="i === currentSlide"
                                @click="goToSlide(i)"
                            >
                                <span
                                    class="block size-2 rounded-full transition-all duration-300 bg-white"
                                    :class="i === currentSlide ? 'opacity-100 scale-125' : 'opacity-50 group-hover:opacity-100'"
                                />
                            </button>
                        </div>
                    </div>

                    <!-- Check-in -->
                    <div class="w-full lg:w-[300px] lg:aspect-square lg:self-start shrink-0 flex flex-col bg-gradient-to-br from-white to-gray-50/50">
                        <div class="flex flex-col items-center pt-5 text-xs text-text-muted leading-tight">
                            <span>{{ todayDateStr }}</span>
                            <ClientOnly>
                                <span class="tabular-nums mt-0.5">{{ todayTimeStr }}</span>
                            </ClientOnly>
                        </div>
                        <CheckInCard
                            :is-logged-in="isLoggedIn"
                            :username="user?.username ?? ''"
                            :checked-in="checkedIn"
                            :fade-white="fadeWhite"
                            :show-text="showText"
                            :streak-count="streakCount"
                            :show-streak="showStreak"
                            :check-in-loaded="checkInLoaded"
                            @checkin="handleCheckIn"
                        />
                    </div>
                </div>
                <div class="border-b border-border" />
                <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 p-4">
                    <RandomProblems />
                    <LatestSubmissions />
                    <FollowingFeed class="lg:col-span-full" />
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { useEventSource } from "~/composables/useEventSource"

const { user, isLoggedIn } = useAuth()
const { api } = useApi()

// ── Announcement Carousel（公告驱动，issue #231）──
interface CarouselAnnouncement {
    id: string
    title: string
    excerpt: string
    is_pinned: boolean
}

/** 轮播背景渐变预设色板（按下标循环，不依赖公告数据） */
const GRADIENTS = [
    "from-blue-600 via-sky-500 to-cyan-400",
    "from-purple-600 via-fuchsia-500 to-pink-400",
    "from-emerald-600 via-teal-500 to-cyan-400",
]

function gradientFor(i: number): string {
    return GRADIENTS[i % GRADIENTS.length]
}

const announcements = ref<CarouselAnnouncement[]>([])

async function fetchAnnouncements() {
    try {
        const res = await api.get<{ data: CarouselAnnouncement[] }>(
            "/api/v1/announcements?per_page=5",
            { silent: true },
        )
        announcements.value = res.data
        // 数据变化后修正轮播位置并（重新）启动自动轮播
        if (currentSlide.value >= announcements.value.length) {
            currentSlide.value = 0
        }
        if (announcements.value.length > 0) {
            stopAuto()
            startAuto()
        }
    } catch {
        // silent：轮播保持空态占位
    }
}

// SSE 实时刷新（端点需登录；未登录用户靠页面加载拉取）
useEventSource({
    url: "/api/v1/announcements/events",
    onEvent: {
        "announcement:updated": fetchAnnouncements,
    },
    fetchFn: fetchAnnouncements,
    fallbackIntervalMs: 60000,
    enabled: isLoggedIn,
})

const currentSlide = ref(0)
const paused = ref(false)
let autoTimer: ReturnType<typeof setInterval> | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null

function startAuto() {
    if (paused.value || announcements.value.length === 0) return
    stopAuto()
    autoTimer = setInterval(() => {
        currentSlide.value = (currentSlide.value + 1) % announcements.value.length
    }, 5000)
}

function stopAuto() {
    if (autoTimer) {
        clearInterval(autoTimer)
        autoTimer = null
    }
}

function togglePause() {
    paused.value = !paused.value
    if (paused.value) stopAuto()
    else startAuto()
}

function goToSlide(i: number) {
    if (i === currentSlide.value) return
    currentSlide.value = i
    resetIdle()
}

function resetIdle() {
    stopAuto()
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(startAuto, 60000)
}

onMounted(fetchAnnouncements)
onUnmounted(() => {
    stopAuto()
    if (idleTimer) clearTimeout(idleTimer)
})

// ── Check-in ──
const checkedIn = ref(false)
const checkInAnim = ref(false)
const fadeWhite = ref(false)
const showText = ref(false)
const streakCount = ref(0)
const showStreak = ref(false)
const checkInLoading = ref(false)
const checkInLoaded = ref(false)

// 签到动画时序（加载恢复 vs 手动签到，两套不同节奏）
const RESTORE_ANIM_DELAYS = { anim: 600, white: 200, text: 400, streak: 700 }
const CHECKIN_ANIM_DELAYS = { anim: 600, white: 1500, text: 2200, streak: 2500 }

function playCheckInAnim(delays: {
  anim: number
  white: number
  text: number
  streak: number
}) {
  checkInAnim.value = true
  setTimeout(() => { checkInAnim.value = false }, delays.anim)
  setTimeout(() => { fadeWhite.value = true }, delays.white)
  setTimeout(() => { showText.value = true }, delays.text)
  setTimeout(() => { showStreak.value = true }, delays.streak)
}

async function fetchTodayCheckIn() {
    if (!isLoggedIn.value) return
    try {
        const res = await api.get<{ data: { checked_in: boolean; streak: number } }>(
            "/api/v1/checkin/today",
            { silent: true },
        )
        if (res.data) {
            checkedIn.value = res.data.checked_in
            streakCount.value = res.data.streak
            if (res.data.checked_in) {
                playCheckInAnim(RESTORE_ANIM_DELAYS)
            }
        }
    } catch {
        // silent
    } finally {
        checkInLoaded.value = true
    }
}

async function handleCheckIn() {
    if (checkInLoading.value || checkedIn.value) return
    checkInLoading.value = true
    try {
        const res = await api.post<{ data: { checked_in: boolean; streak: number } }>(
            "/api/v1/checkin",
        )
        if (res.data) {
            checkedIn.value = res.data.checked_in
            streakCount.value = res.data.streak
            playCheckInAnim(CHECKIN_ANIM_DELAYS)
        }
    } catch {
        // silent
    } finally {
        checkInLoading.value = false
    }
}

const d = new Date()
const todayDateStr = d.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
}) + " " + d.toLocaleDateString("zh-CN", { weekday: "long" })

const now = ref(Date.now())
let clockTimer: ReturnType<typeof setInterval> | null = null

const todayTimeStr = computed(() => new Date(now.value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
}))

onMounted(() => {
    clockTimer = setInterval(() => { now.value = Date.now() }, 1000)
    if (isLoggedIn.value) {
        fetchTodayCheckIn()
    }
})

onUnmounted(() => {
    if (clockTimer) clearInterval(clockTimer)
})
</script>

<style scoped>
@keyframes slideInUp {
    from {
        opacity: 0;
        transform: translateY(20px);
    }
    to {
        opacity: 1;
        transform: translateY(0);
    }
}

.carousel-fade-enter-active,
.carousel-fade-leave-active {
    transition: opacity 700ms ease-in-out;
}

.carousel-fade-enter-from,
.carousel-fade-leave-to {
    opacity: 0;
}


</style>