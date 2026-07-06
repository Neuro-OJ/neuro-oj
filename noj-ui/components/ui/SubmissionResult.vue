<template>
    <span
        v-if="result"
        class="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded font-medium w-fit justify-self-end"
        :style="{
            background: color + '18',
            color: color,
        }"
    >{{ label }}</span>
    <span
        v-else-if="queue_position != null"
        class="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded font-medium w-fit justify-self-end bg-gray-400/10 text-gray-400"
    >等待评测</span>
    <span
        v-else
        class="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded font-medium w-fit justify-self-end bg-green-500/10 text-green-500"
    >评测中</span>
</template>

<script setup lang="ts">
import { computed } from "vue"
import { getStatusColor, getStatusLabel } from "~/composables/use-submissions"

interface Props {
    /** 提交流 state（pending / judging / error） */
    status: string
    /** 评测结果（null 表示正在评测中） */
    result: { status: string } | null
    /** 排队位置（null 表示不在等待队列中） */
    queue_position?: number | null
}

const props = defineProps<Props>()

const color = computed(() =>
    getStatusColor(props.status, props.result?.status),
)
const label = computed(() =>
    getStatusLabel(props.status, props.result?.status),
)
</script>
