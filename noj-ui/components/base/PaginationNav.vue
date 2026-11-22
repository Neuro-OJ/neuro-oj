<script setup lang="ts">
const props = defineProps<{
  currentPage: number
  totalPages: number
}>()

const emit = defineEmits<{
  'page-change': [page: number]
}>()

function onPageChange(page: number) {
  if (page >= 1 && page <= props.totalPages && page !== props.currentPage) {
    emit('page-change', page)
  }
}
</script>

<template>
  <nav v-if="totalPages > 1" class="mt-5 flex items-center justify-center" aria-label="分页导航">
    <UPagination
      :page="currentPage"
      :total="totalPages"
      :items-per-page="1"
      :show-edges="true"
      size="sm"
      @update:page="onPageChange"
    >
      <template #prev>
        <span class="text-xs">上一页</span>
      </template>
      <template #next>
        <span class="text-xs">下一页</span>
      </template>
    </UPagination>
  </nav>
</template>
