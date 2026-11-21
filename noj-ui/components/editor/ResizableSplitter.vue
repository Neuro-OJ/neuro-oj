<script setup lang="ts">
const props = defineProps<{
  modelValue: number
  min: number
  max: number
  side: 'left' | 'right'
}>()

const emit = defineEmits<{
  'update:modelValue': [value: number]
  'drag-end': [value: number]
}>()

let cleanupDrag: (() => void) | null = null

function onMouseDown(e: MouseEvent) {
  e.preventDefault()
  cleanupDrag?.()
  const startX = e.clientX
  const startWidth = props.modelValue
  let latest = startWidth

  function onMove(ev: MouseEvent) {
    const dx = ev.clientX - startX
    const next = Math.max(props.min, Math.min(props.max, startWidth + dx))
    latest = next
    emit('update:modelValue', next)
  }
  function onUp() {
    cleanupDrag?.()
    emit('drag-end', latest)
  }
  cleanupDrag = () => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    cleanupDrag = null
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

function onDoubleClick() {
  const resetWidth = Math.floor((props.min + props.max) / 2)
  emit('update:modelValue', resetWidth)
  emit('drag-end', resetWidth)
}

function onKeyDown(e: KeyboardEvent) {
  const step = e.shiftKey ? 32 : 16
  let next: number | null = null
  if (e.key === 'ArrowLeft') {
    next = Math.max(props.min, props.modelValue - step)
  } else if (e.key === 'ArrowRight') {
    next = Math.min(props.max, props.modelValue + step)
  } else if (e.key === 'Home') {
    next = props.min
  } else if (e.key === 'End') {
    next = props.max
  }
  if (next !== null && next !== props.modelValue) {
    e.preventDefault()
    emit('update:modelValue', next)
    emit('drag-end', next)
  }
}

onScopeDispose(() => {
  cleanupDrag?.()
})
</script>

<template>
  <div
    role="separator"
    aria-orientation="vertical"
    aria-label="调整工作区面板宽度"
    :aria-valuenow="modelValue"
    :aria-valuemin="min"
    :aria-valuemax="max"
    tabindex="0"
    class="w-1 cursor-col-resize bg-transparent hover:bg-signal/30 active:bg-signal/50 focus-visible:outline-none focus-visible:bg-signal/50 transition-colors hidden md:block flex-shrink-0"
    @mousedown="onMouseDown"
    @dblclick="onDoubleClick"
    @keydown="onKeyDown"
  />
</template>
