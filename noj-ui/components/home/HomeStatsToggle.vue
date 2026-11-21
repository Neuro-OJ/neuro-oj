<template>
    <div v-if="stats" class="ml-auto flex items-center gap-2 text-xs tracking-tighter overflow-hidden whitespace-nowrap">
        <span class="flex items-center gap-0.5 font-semibold text-text">
            <UIcon name="i-lucide-bar-chart-3" class="shrink-0 size-[11px] size-4" />
            <span class="inline-flex items-center">
                <span class="grid grid-cols-1 grid-rows-1 overflow-hidden">
                    <span class="row-span-full col-span-full transition-all duration-350"
                        :class="mode === 'today' ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-full'"
                    >今天</span>
                    <span class="row-span-full col-span-full transition-all duration-350"
                        :class="mode === 'total' ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-full'"
                    >总共</span>
                </span>评测
            </span><AnimatedCounter :value="stats.total" class="font-bold text-text" />
        </span>
        <span class="text-text-muted">=</span>
        <span class="flex items-center gap-0.5 font-semibold text-green-600">
            <UIcon name="i-lucide-check-circle-2" class="shrink-0 size-[11px] size-4" />
            正确<AnimatedCounter :value="stats.full_score" class="font-bold text-green-600" />
        </span>
        <span class="text-text-muted">+</span>
        <span class="flex items-center gap-0.5 font-semibold text-red-500">
            <UIcon name="i-lucide-x-circle" class="shrink-0 size-[11px] size-4" />
            错误<AnimatedCounter :value="stats.not_full_score" class="font-bold text-red-500" />
        </span>
    </div>
</template>

<script setup lang="ts">
interface TodayStats {
    total: number
    full_score: number
    not_full_score: number
}

const props = defineProps<{
    todayStats: TodayStats | null
    totalStats: TodayStats | null
}>()

const mode = ref<'today' | 'total'>('today')

const stats = computed(() => mode.value === 'today' ? props.todayStats : props.totalStats)

let modeTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
    modeTimer = setInterval(() => {
        mode.value = mode.value === 'today' ? 'total' : 'today'
    }, 5000)
})

onUnmounted(() => {
    if (modeTimer) clearInterval(modeTimer)
})
</script>
