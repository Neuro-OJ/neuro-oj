<template>
    <div class="bg-white border border-border rounded-xl shadow-card animate-[fadeInUp_0.5s_ease_0.15s_both] h-full flex flex-col">
        <div class="flex items-center gap-2 px-5 py-3.5 border-b border-border">
            <Code :size="16" class="text-primary shrink-0" />
            <h3 class="text-sm font-semibold text-text m-0 leading-none">随机题目</h3>
            <button
                class="ml-auto flex items-center justify-center w-7 h-7 rounded-lg text-text-muted transition-colors duration-150 hover:text-primary active:scale-95 disabled:opacity-50"
                title="换一批"
                :disabled="refreshing"
                @click="refresh"
            >
                <RefreshCw :size="15" :class="{ 'animate-spin-slow': refreshing }" />
            </button>
        </div>
        <div class="flex-1 flex flex-col">
            <div v-if="loading" class="flex items-center justify-center flex-1 gap-2 text-text-muted text-sm">
                <div class="size-4 border-2 border-border border-t-primary rounded-full animate-spin-slow" />
                <span>加载中...</span>
            </div>
            <div v-else-if="problems.length === 0" class="flex items-center justify-center flex-1 text-center text-sm text-text-muted">
                暂无题目
            </div>
            <div v-else class="flex flex-col gap-[10px] p-[10px] flex-1">
                <ProblemCard
                    v-for="(p, i) in problems"
                    :key="`${p.id}-${refreshKey}`"
                    :style="{ animationDelay: `${0.1 + i * 0.05}s` }"
                    class="animate-[fadeInUp_0.5s_ease_both]"
                    :id="p.id"
                    :display_id="p.display_id"
                    :type="p.type"
                    :title="p.title"
                    :difficulty="p.difficulty"
                    :time_limit_ms="p.time_limit_ms"
                    :memory_limit_mb="p.memory_limit_mb"
                    :categories="p.categories"
                />
            </div>
        </div>
        <NuxtLink
            to="/problems"
            class="flex items-center justify-center gap-1 px-5 py-2.5 text-xs font-semibold text-primary no-underline border-t border-border transition-colors duration-150 hover:bg-primary-bg group"
        >
            查看全部题目
            <ArrowRight :size="14" class="transition-transform duration-150 group-hover:translate-x-0.5" />
        </NuxtLink>
    </div>
</template>

<script setup lang="ts">
import { Code, ArrowRight, RefreshCw } from "@lucide/vue"

interface ProblemItem {
    id: string
    title: string
    display_id: string
    type: string
    difficulty: string
    time_limit_ms: number
    memory_limit_mb: number
    categories: { id: string; name: string; slug: string }[]
}

const problems = ref<ProblemItem[]>([])
const loading = ref(true)
const refreshing = ref(false)
const refreshKey = ref(0)

async function fetchAndShuffle() {
    try {
        const res = await $fetch<{ data: ProblemItem[] }>("/api/v1/problems", {
            query: { limit: 100 },
        })
        const list = res.data ?? []
        const shuffled = [...list].sort(() => Math.random() - 0.5)
        problems.value = shuffled.slice(0, 3)
    } catch {
        // silent
    }
}

async function refresh() {
    if (refreshing.value) return
    refreshing.value = true
    refreshKey.value++
    await fetchAndShuffle()
    refreshing.value = false
}

onMounted(async () => {
    loading.value = true
    await fetchAndShuffle()
    loading.value = false
})
</script>