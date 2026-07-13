<script setup lang="ts">
const props = defineProps<{
  modelValue: number
  min: number
  max: number
  side: 'left' | 'right'
}>()

const emit = defineEmits<{
  'update:modelValue': [value: number]
}>()

function onMouseDown(e: MouseEvent) {
  e.preventDefault()
  const startX = e.clientX
  const startWidth = props.modelValue

  function onMove(ev: MouseEvent) {
    const dx = ev.clientX - startX
    const next = Math.max(props.min, Math.min(props.max, startWidth + dx))
    emit('update:modelValue', next)
  }
  function onUp() {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

function onDoubleClick() {
  emit('update:modelValue', Math.floor((props.min + props.max) / 2))
}
</script>

<template>
  <div
<<<<<<< HEAD
    class="w-1 cursor-col-resize bg-transparent hover:bg-primary/30 active:bg-primary/50 transition-colors hidden md:block flex-shrink-0"
    @mousedown="onMouseDown"
    @dblclick="onDoubleClick"
  />
</template>
=======
    class="w-1.5 cursor-col-resize hover:bg-primary/30 active:bg-primary/50 transition-colors hidden md:block flex-shrink-0"
    :class="side === 'left' ? 'border-l border-border' : 'border-r border-border'"
    @mousedown="onMouseDown"
    @dblclick="onDoubleClick"
  />
</template>
>>>>>>> 0748b48 (feat(ui): ResizableSplitter — 可拖拽分隔条 + useResizableSplit composable)
