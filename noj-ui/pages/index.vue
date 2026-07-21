<template>
    <div class="py-6">
        <div class="mx-auto w-full max-w-[1320px] border border-border rounded-xl shadow-card flex flex-col overflow-hidden">
            <div class="flex flex-col flex-1">
                <div class="flex flex-col lg:flex-row flex-1 min-h-[320px] bg-white">
                    <!-- Carousel -->
                    <div class="flex-1 min-w-0 relative overflow-hidden">
                        <Transition name="carousel-fade">
                            <div
                                :key="currentSlide"
                                class="absolute inset-0 bg-gradient-to-br p-8 lg:p-12 flex flex-col justify-center text-white"
                                :class="announcements[currentSlide].gradient"
                            >
                                <h2 class="text-2xl lg:text-3xl font-bold mb-3 animate-[slideInUp_0.6s_cubic-bezier(0.16,1,0.3,1)_both]">{{ announcements[currentSlide].title }}</h2>
                                <p class="text-sm lg:text-base text-white/85 max-w-[480px] leading-relaxed animate-[slideInUp_0.6s_cubic-bezier(0.16,1,0.3,1)_150ms_both]">{{ announcements[currentSlide].description }}</p>
                            </div>
                        </Transition>
                        <div class="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1.5 z-10">
                            <button
                                v-for="(_, i) in announcements"
                                :key="i"
                                class="size-2 rounded-full transition-all duration-300 cursor-pointer bg-white"
                                :class="i === currentSlide ? 'opacity-100 scale-125' : 'opacity-50 hover:opacity-100'"
                                :aria-label="`切换到第 ${i + 1} 张`"
                                @click="goToSlide(i)"
                            />
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
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
const { user, isLoggedIn } = useAuth()

// ── Announcement Carousel ──
interface Announcement {
    title: string
    description: string
    gradient: string
}

const announcements: Announcement[] = [
    {
        title: "Neuro OJ 正式上线",
        description: "面向 LMCC 的在线评测系统现已开放注册，提供高效的代码评测服务和智能化的能力评估。",
        gradient: "from-blue-600 via-sky-500 to-cyan-400",
    },
    {
        title: "新题持续更新",
        description: "题库不断扩充中，涵盖算法、数据结构等各类编程题目，满足不同水平的训练需求。",
        gradient: "from-purple-600 via-fuchsia-500 to-pink-400",
    },
    {
        title: "社区共建计划",
        description: "欢迎为 Neuro OJ 贡献题目与代码，共同打造优秀的在线评测社区平台。",
        gradient: "from-emerald-600 via-teal-500 to-cyan-400",
    },
]

const currentSlide = ref(0)
let autoTimer: ReturnType<typeof setInterval> | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null

function startAuto() {
    stopAuto()
    autoTimer = setInterval(() => {
        currentSlide.value = (currentSlide.value + 1) % announcements.length
    }, 5000)
}

function stopAuto() {
    if (autoTimer) {
        clearInterval(autoTimer)
        autoTimer = null
    }
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

onMounted(startAuto)
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

async function fetchTodayCheckIn() {
    if (!isLoggedIn.value) return
    try {
        const res = await $fetch<{ data: { checked_in: boolean; streak: number } }>("/api/v1/checkin/today")
        if (res.data) {
            checkedIn.value = res.data.checked_in
            streakCount.value = res.data.streak
            if (res.data.checked_in) {
                checkInAnim.value = true
                setTimeout(() => { checkInAnim.value = false }, 600)
                setTimeout(() => { fadeWhite.value = true }, 200)
                setTimeout(() => { showText.value = true }, 400)
                setTimeout(() => { showStreak.value = true }, 700)
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
        const res = await $fetch<{ data: { checked_in: boolean; streak: number } }>("/api/v1/checkin", {
            method: "POST",
        })
        if (res.data) {
            checkedIn.value = res.data.checked_in
            streakCount.value = res.data.streak
            checkInAnim.value = true
            setTimeout(() => { checkInAnim.value = false }, 600)
            setTimeout(() => { fadeWhite.value = true }, 1500)
            setTimeout(() => { showText.value = true }, 2200)
            setTimeout(() => { showStreak.value = true }, 2500)
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
    clockTimer = setInterval(() => { now.value = Date.now() }, 100)
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