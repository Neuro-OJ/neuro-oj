<template>
    <div class="px-3 sm:px-5 py-6">
        <div class="mx-auto w-full max-w-[1320px] border border-border rounded-xl shadow-card flex flex-col overflow-hidden">
            <div class="flex flex-col flex-1">
                <div class="flex flex-col lg:flex-row flex-1 min-h-[320px] bg-white">
                    <!-- Carousel（slides 驱动） -->
                    <!-- 手机模式下内容为 absolute 定位，容器需 min-h 保底，避免高度塌缩被签到区顶塌 -->
                    <Carousel />

                    <!-- Check-in -->
                    <div class="w-full lg:w-[300px] lg:aspect-square lg:self-start shrink-0 flex flex-col bg-gradient-to-br from-white to-bg-page/50">
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
                <AnnouncementSection />
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
const { user, isLoggedIn } = useAuth()
const { api } = useApi()

// 轮播与公告已解耦：轮播见 components/feature/Carousel.vue，
// 常驻公告区块见 components/feature/AnnouncementSection.vue。

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
            { silent: true, redirectOnUnauthorized: false },
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
