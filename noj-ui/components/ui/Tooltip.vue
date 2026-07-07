<script setup lang="ts">
import { ref } from "vue"

defineProps<{
  content: string
}>()

const visible = ref(false)
let enterTimer: ReturnType<typeof setTimeout> | undefined
let leaveTimer: ReturnType<typeof setTimeout> | undefined

function onEnter() {
  clearTimeout(leaveTimer)
  enterTimer = setTimeout(() => { visible.value = true }, 200)
}
function onLeave() {
  clearTimeout(enterTimer)
  visible.value = false
}
</script>

<template>
  <span
    class="relative inline-flex"
    @mouseenter="onEnter"
    @mouseleave="onLeave"
  >
    <slot />
    <Transition name="tooltip">
      <span
        v-if="visible"
        class="absolute z-50 px-2 py-1 rounded-md bg-gray-800 text-white text-[11px] whitespace-nowrap shadow-modal pointer-events-none"
        style="bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%)"
      >
        {{ content }}
        <span class="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-800" />
      </span>
    </Transition>
  </span>
</template>

<style scoped>
.tooltip-enter-active { transition: opacity 0.12s ease, transform 0.12s ease; }
.tooltip-leave-active { transition: opacity 0.08s ease; }
.tooltip-enter-from { opacity: 0; transform: translateX(-50%) scale(0.85) !important; }
.tooltip-leave-to { opacity: 0; }
</style>
