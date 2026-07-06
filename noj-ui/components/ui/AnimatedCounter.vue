<template>
    <span class="tabular-nums">{{ display }}</span>
</template>

<script setup lang="ts">
const props = defineProps<{ value: number }>()
const display = ref(props.value)
let prevValue = props.value
let animId: number | null = null

const duration = 1500

watch(() => props.value, (newVal) => {
    if (animId) cancelAnimationFrame(animId)
    const startVal = prevValue
    display.value = startVal
    const start = performance.now()
    function tick(now: number) {
        const progress = Math.min((now - start) / duration, 1)
        display.value = Math.round(startVal + progress * (newVal - startVal))
        if (progress < 1) {
            animId = requestAnimationFrame(tick)
        } else {
            prevValue = newVal
        }
    }
    animId = requestAnimationFrame(tick)
}, { immediate: true })

onUnmounted(() => {
    if (animId) cancelAnimationFrame(animId)
})
</script>
