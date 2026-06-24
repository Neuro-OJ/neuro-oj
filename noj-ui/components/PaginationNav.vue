<script setup lang="ts">
interface Props {
  currentPage: number
  totalPages: number
}

const props = defineProps<Props>()

const emit = defineEmits<{
  'page-change': [page: number]
}>()

const pages = computed(() => {
  const total = props.totalPages
  const current = props.currentPage
  const range: ({ type: 'page'; value: number } | { type: 'ellipsis' })[] = []
  const start = Math.max(1, current - 2)
  const end = Math.min(total, current + 2)

  if (start > 1) {
    range.push({ type: 'page', value: 1 })
    if (start > 2) range.push({ type: 'ellipsis', value: -1 })
  }
  for (let i = start; i <= end; i++) {
    range.push({ type: 'page', value: i })
  }
  if (end < total) {
    if (end < total - 1) range.push({ type: 'ellipsis', value: -2 })
    range.push({ type: 'page', value: total })
  }
  return range
})

function goTo(page: number) {
  if (page >= 1 && page <= props.totalPages && page !== props.currentPage) {
    emit('page-change', page)
  }
}
</script>

<template>
  <nav v-if="totalPages > 1" class="flex items-center justify-center gap-1.5 mt-5" aria-label="分页导航">
    <button
      class="btn btn-outline px-3 py-1.5 text-xs disabled:opacity-40 disabled:cursor-not-allowed"
      :disabled="currentPage <= 1"
      aria-label="上一页"
      @click="goTo(currentPage - 1)"
    >
      上一页
    </button>

    <template v-for="(p, idx) in pages" :key="`${p.type}-${p.value}-${idx}`">
      <span v-if="p.type === 'ellipsis'" class="px-1 text-xs text-text-muted" aria-hidden="true">…</span>
      <button
        v-else
        class="min-w-[32px] px-2 py-1.5 text-xs font-medium rounded-md transition-colors duration-150"
        :class="p.value === currentPage
          ? 'bg-primary text-white'
          : 'text-text-secondary hover:bg-gray-100'"
        :aria-current="p.value === currentPage ? 'page' : undefined"
        :aria-label="`第 ${p.value} 页`"
        @click="goTo(p.value)"
      >
        {{ p.value }}
      </button>
    </template>

    <button
      class="btn btn-outline px-3 py-1.5 text-xs disabled:opacity-40 disabled:cursor-not-allowed"
      :disabled="currentPage >= totalPages"
      aria-label="下一页"
      @click="goTo(currentPage + 1)"
    >
      下一页
    </button>
  </nav>
</template>
