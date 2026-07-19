<template>
    <NuxtLink
        :to="`/submissions/${submission.id}`"
        class="relative block px-2.5 py-1.5 border-2 border-border rounded-md bg-white no-underline transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-primary hover:shadow-dropdown group"
    >
        <div class="grid grid-cols-[auto_1fr] gap-x-2">
            <!-- 左列：icon + #id（跨两行） -->
            <div class="row-span-2 self-start flex items-center gap-1">
                <FileText class="size-3.5 text-text-muted" />
                <span class="text-[10px] font-mono font-bold text-text-secondary">#{{ submission.id.slice(0, 8) }}</span>
            </div>

            <div class="grid grid-cols-[minmax(0,75%)_minmax(0,1fr)] gap-x-2 items-start min-w-0">
                <!-- 左上：题目名 -->
                <MarqueeTitle
                    class="self-start"
                    :text="submission.problem.title"
                    text-class="text-[14px] leading-[15px] text-text group-hover:text-primary transition-colors duration-150"
                />
                <!-- 右上：评测结果 -->
                <SubmissionResult
                    class="self-start"
                    :status="submission.status"
                    :result="submission.result"
                    :queue-position="submission.queue_position"
                />

                <!-- row 2: 跨两列同行（time 左，stats 右） -->
                <template v-if="submission.result">
                    <div class="col-span-2 self-center flex items-center justify-between gap-2 text-[11px]">
                        <span class="text-text-muted">{{ formatTime(submission.created_at) }}</span>
                        <div class="flex items-center gap-px font-mono tabular-nums">
                            <span :class="getUsageColor(submission.result.time_ms, submission.problem.runtime_config.evaluator.time_limit_ms)">
                                {{ formatTimeMs(submission.result.time_ms) }}
                            </span>
                            <span class="text-text-muted">/</span>
                            <span class="font-bold text-text-muted">{{ formatTimeMs(submission.problem.runtime_config.evaluator.time_limit_ms) }}</span>
                            <span class="text-text-muted mx-px">-</span>
                            <span :class="getUsageColor(submission.result.memory_kb, memoryLimitKb)">
                                {{ formatMemory(submission.result.memory_kb) }}
                            </span>
                            <span class="text-text-muted">/</span>
                            <span class="font-bold text-text-muted">{{ formatMemoryLimit(submission.problem.runtime_config.evaluator.memory_limit_mb) }}</span>
                        </div>
                    </div>
                </template>
                <template v-else-if="submission.queue_position != null">
                    <div class="col-span-2 self-center flex items-center justify-between gap-2 text-[11px]">
                        <span class="text-text-muted">{{ formatTime(submission.created_at) }}</span>
                        <span class="font-mono tabular-nums text-gray-400">排队中 <span class="font-bold">#{{ submission.queue_position }}</span></span>
                    </div>
                </template>
                <template v-else>
                    <div class="col-span-2 self-center flex items-center justify-between gap-2 text-[11px]">
                        <span class="text-text-muted">{{ formatTime(submission.created_at) }}</span>
                        <span class="font-mono tabular-nums text-blue-500">{{ liveElapsed(submission.judge_started_at ?? submission.created_at) }}</span>
                    </div>
                </template>
            </div>
        </div>
    </NuxtLink>
</template>

<script setup lang="ts">
import { FileText } from "@lucide/vue"
import { computed } from "vue"

interface Submission {
    id: string
    problem_id: string
    problem: {
        title: string
        runtime_config: { evaluator: { time_limit_ms: number; memory_limit_mb: number } }
    }
    status: string
    created_at: string
    judge_started_at: string | null
    judge_finished_at: string | null
    queue_position: number | null
    queue_length: number | null
    result: {
        status: string
        score: number
        time_ms: number | null
        memory_kb: number | null
    } | null
}

interface Props {
    submission: Submission
    /** 当前时间戳（毫秒），用于正在评测的实时秒数计算 */
    now: number
}

const props = defineProps<Props>()

/** 内存上限换算为 KB（用于百分比计算）；null/0 时返回 0（灰色） */
const memoryLimitKb = computed(() =>
    (props.submission.problem.runtime_config.evaluator.memory_limit_mb ?? 0) * 1024,
)

function formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    })
}

function formatTimeMs(ms: number | null | undefined): string {
    if (ms == null) return "?"
    if (ms < 1000) return ms + "ms"
    return (ms / 1000).toFixed(3) + "s"
}

function formatMemory(kb: number | null | undefined): string {
    if (kb == null) return "?"
    if (kb >= 1024) return (kb / 1024).toFixed(2) + " MB"
    return kb + " KB"
}

function formatMemoryLimit(mb: number | null | undefined): string {
    if (mb == null) return "? MB"
    return mb + " MB"
}

function liveElapsed(iso: string): string {
    const ms = Math.max(0, props.now - new Date(iso).getTime())
    return formatTimeMs(ms)
}

/**
 * 用量颜色：used/max 比例
 * - max 缺失或 ≤ 0 → 灰色（无限制信息）
 * - used ≥ max → 红色（超标）
 * - used/max ≥ 0.9 → 黄色（接近上限）
 * - 其他 → 灰色（正常）
 */
function getUsageColor(used: number | null | undefined, max: number | null | undefined): string {
    if (used == null || !max || max <= 0) return "text-text-muted"
    if (used >= max) return "text-red-500"
    if (used / max >= 0.9) return "text-yellow-500"
    return "text-text-muted"
}
</script>
