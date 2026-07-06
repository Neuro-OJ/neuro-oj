<template>
    <span
        class="inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0 w-fit justify-self-end"
        :class="config[difficulty]?.class || 'bg-gray-100 text-text-muted'"
    >{{ config[difficulty]?.label || difficulty }}</span>
</template>

<script setup lang="ts">
interface Props {
    /**
     * 难度等级。已知值：easy / medium / hard。
     * 未知值会显示兜底灰底 + 原文。
     */
    difficulty: string
}

defineProps<Props>()

const config: Record<string, { label: string; class: string }> = {
    easy: { label: "简单", class: "bg-green-100 text-green-700" },
    medium: { label: "中等", class: "bg-yellow-100 text-yellow-700" },
    hard: { label: "困难", class: "bg-red-100 text-red-700" },
}
</script>