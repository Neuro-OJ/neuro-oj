<template>
    <div class="bg-white border border-border rounded-xl shadow-card animate-[fadeInUp_0.5s_ease_0.15s_both] h-full flex flex-col">
        <div class="flex items-center gap-2 px-5 py-3.5 border-b border-border shrink-0">
            <Clock :size="16" class="text-primary shrink-0" />
            <h3 class="text-sm font-semibold text-text m-0">最新评测</h3>
            <StatsToggle :today-stats="todayStats" :total-stats="totalStats" />
        </div>
        <div class="flex-1 flex flex-col">
            <template v-if="loading">
                <div class="flex items-center justify-center flex-1 gap-2 text-text-muted text-sm">
                    <div class="size-4 border-2 border-border border-t-primary rounded-full animate-spin-slow" />
                    <span>加载中...</span>
                </div>
            </template>
            <template v-else-if="submissions.length === 0">
                <div class="flex items-center justify-center flex-1 text-center text-sm text-text-muted">暂无评测记录</div>
            </template>
            <TransitionGroup v-else appear name="list" tag="div" class="flex flex-col gap-[10px] p-[10px] flex-1">
                <SubmissionCard
                    v-for="(s, i) in displayList"
                    :key="s.id"
                    :submission="s"
                    :now="now"
                    :style="{ '--i': i }"
                    :class="{ 'animate-pin': pinSet.has(s.id) }"
                />
            </TransitionGroup>
        </div>
        <NuxtLink
            to="/submissions"
            class="flex items-center justify-center gap-1 px-5 py-2.5 text-xs font-semibold text-primary no-underline border-t border-border transition-colors duration-150 hover:bg-primary-bg group"
        >
            查看全部提交
            <ArrowRight :size="14" class="transition-transform duration-150 group-hover:translate-x-0.5" />
        </NuxtLink>
    </div>
</template>

<script setup lang="ts">
import { Clock, ArrowRight } from "@lucide/vue"
import { useEventSource } from "~/composables/useEventSource"

interface SubmissionItem {
    id: string
    problem_id: string
    problem: { title: string; memory_limit_mb: number | null }
    status: string
    created_at: string
    judge_started_at: string | null
    judge_finished_at: string | null
    queue_position: number | null
    queue_length: number | null
    result: { status: string; score: number; time_ms: number; memory_kb: number } | null
}

interface TodayStats {
    total: number
    full_score: number
    not_full_score: number
}

const { isLoggedIn } = useAuth()

const submissions = ref<SubmissionItem[]>([])
const loading = ref(true)
const prevStatuses = ref<Map<string, string>>(new Map())
const pinSet = ref<Set<string>>(new Set())
const todayStats = ref<TodayStats | null>(null)
const totalStats = ref<TodayStats | null>(null)

const now = ref(Date.now())
let clockTimer: ReturnType<typeof setInterval> | null = null
let pinTimer: ReturnType<typeof setTimeout> | null = null

// SSE 事件处理：统计数据变更时从事件数据中获取最新值
function onStatsUpdated(data: unknown) {
    const d = data as { total?: TodayStats; today?: TodayStats }
    if (d.total) totalStats.value = d.total
    if (d.today) todayStats.value = d.today
}

async function fetchStatsFallback() {
    try {
        const [totalRes, todayRes] = await Promise.all([
            $fetch<{ data: TodayStats }>("/api/v1/submissions/total-stats"),
            $fetch<{ data: TodayStats }>("/api/v1/submissions/today-stats"),
        ])
        if (totalRes.data) totalStats.value = totalRes.data
        if (todayRes.data) todayStats.value = todayRes.data
    } catch {
        // silent
    }
}

const displayList = computed(() => {
    const list = [...submissions.value]
    list.sort((a, b) => {
        const aPinned = pinSet.value.has(a.id)
        const bPinned = pinSet.value.has(b.id)
        if (aPinned && !bPinned) return -1
        if (!aPinned && bPinned) return 1
        return b.created_at.localeCompare(a.created_at)
    })
    return list.slice(0, 5)
})

async function fetchSubmissions() {
    try {
        // 未登录调用公开端点（全站最近评测），登录调用私有端点（我的提交）
        const url = isLoggedIn.value ? "/api/v1/submissions" : "/api/v1/submissions/public/recent"
        const res = await $fetch<{ data: SubmissionItem[] }>(url, {
            query: { per_page: 10 },
        })
        const list = res.data ?? []
        const newPrev = new Map<string, string>()
        const newPin = new Set<string>()
        let hasNewFinish = false
        for (const s of list) {
            const old = prevStatuses.value.get(s.id)
            if (old && old !== "finished" && s.status === "finished") {
                newPin.add(s.id)
                hasNewFinish = true
            }
            newPrev.set(s.id, s.status)
        }
        submissions.value = list
        prevStatuses.value = newPrev
        // 保持已有 pin 持续生效
        for (const id of pinSet.value) {
            newPin.add(id)
        }
        pinSet.value = newPin
        if (hasNewFinish) {
            if (pinTimer) clearTimeout(pinTimer)
            pinTimer = setTimeout(() => { pinSet.value = new Set() }, 3500)
        }
    } catch {
        // silent
    } finally {
        loading.value = false
    }
}

onMounted(() => {
    clockTimer = setInterval(() => { now.value = Date.now() }, 100)

    // 首次加载
    fetchSubmissions()
    fetchStatsFallback()

    // 通过 SSE 接收实时变更通知（stats + 新评测结果）
    // 每次收到 stats:updated，说明有新评测完成，刷新列表和统计
    useEventSource({
        url: "/api/v1/submissions/stats/events",
        onEvent: {
            "stats:updated": (data) => {
                onStatsUpdated(data)
                fetchSubmissions()
            },
        },
        fetchFn: () => {
            fetchSubmissions()
            fetchStatsFallback()
        },
        fallbackIntervalMs: 10000,
    })
})

onUnmounted(() => {
    if (clockTimer) clearInterval(clockTimer)
    if (pinTimer) clearTimeout(pinTimer)
})
</script>

<style>
.list-enter-active {
    transition: all 0.7s cubic-bezier(0.16, 1, 0.3, 1);
    transition-delay: calc(0.1s + var(--i, 0) * 0.05s);
}
.list-leave-active {
    transition: all 0.5s ease-in;
    position: absolute;
    left: 0;
    right: 0;
    width: 100%;
}
.list-enter-from {
    opacity: 0;
    transform: translateY(-12px) scale(0.97);
}
.list-leave-to {
    opacity: 0;
    transform: translateY(-8px) scale(0.97);
}
.list-move {
    transition: transform 0.6s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes pin-pop {
    0% {
        box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.3);
    }
    30% {
        box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.15);
    }
    100% {
        box-shadow: 0 0 0 0 rgba(59, 130, 246, 0);
    }
}

.animate-pin {
    animation: pin-pop 1s cubic-bezier(0.16, 1, 0.3, 1);
}
</style>