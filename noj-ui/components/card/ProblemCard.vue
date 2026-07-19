<template>
    <NuxtLink
        :to="`/problems/${id}`"
        class="orbit-card relative block px-2.5 py-1.5 border-2 border-border rounded-md bg-white no-underline transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-primary hover:shadow-dropdown group"
    >
        <div class="grid grid-cols-[auto_1fr] gap-x-2">
            <span
                class="row-span-2 self-start font-mono text-xs font-semibold px-1.5 py-0.5 rounded transition-colors duration-200"
                :class="type === 'U'
                    ? 'bg-blue-100 text-blue-700 group-hover:bg-blue-200 group-hover:text-blue-800'
                    : 'bg-purple-100 text-purple-700 group-hover:bg-purple-200 group-hover:text-purple-800'"
            >{{ display_id }}</span>

            <div class="grid grid-cols-[minmax(0,75%)_auto] gap-x-2 items-start min-w-0">
                <!-- 左上：题目名（MarqueeTitle） -->
                <MarqueeTitle
                    class="self-center"
                    :text="title"
                    text-class="text-sm text-text group-hover:text-primary transition-colors duration-150"
                />
                <!-- 右上：难度徽章 -->
                <DifficultyBadge class="self-start" :difficulty="difficulty" />

                <!-- 左下：分类 -->
                <div class="flex items-center gap-1 h-[18px] overflow-hidden">
                    <span
                        v-for="cat in categories"
                        :key="cat.id"
                        class="text-[10px] px-1.5 rounded bg-blue-50 text-blue-700 border border-blue-200 box-border h-full inline-flex items-center leading-none"
                    >{{ cat.name }}</span>
                </div>
                <!-- 右下：时间·内存限制 -->
                <div class="flex items-center justify-end h-[18px]">
                    <span class="text-[10px] text-text-muted tabular-nums leading-none">{{ (runtime_config.evaluator.time_limit_ms / 1000).toFixed(0) }}s · {{ runtime_config.evaluator.memory_limit_mb }}MB</span>
                </div>
            </div>
        </div>
    </NuxtLink>
</template>

<script setup lang="ts">
interface Category {
    id: string
    name: string
    slug: string
}

interface Props {
    id: string
    display_id: string
    type: string
    title: string
    difficulty: string
    runtime_config: { evaluator: { time_limit_ms: number; memory_limit_mb: number } }
    categories?: Category[]
}

withDefaults(defineProps<Props>(), {
    categories: () => [],
})
</script>
