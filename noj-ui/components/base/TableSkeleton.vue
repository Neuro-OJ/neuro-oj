<script setup lang="ts">
withDefaults(
  defineProps<{
    rows?: number
    columns?: string[]
  }>(),
  {
    rows: 6,
    columns: () => ["w-16", "flex-1", "w-20", "w-24"],
  },
)
</script>

<template>
  <div class="bg-white border border-border rounded-xl overflow-hidden" aria-hidden="true">
    <!-- 表头骨架 -->
    <div class="flex items-center gap-6 border-b border-border bg-gray-50 px-4 py-3">
      <USkeleton v-for="(c, i) in columns" :key="i" class="h-3" :class="c" />
    </div>
    <!-- 数据行骨架 -->
    <div
      v-for="i in rows"
      :key="i"
      class="flex items-center gap-6 border-b border-border px-4 py-3.5 last:border-b-0"
    >
      <USkeleton v-for="(c, j) in columns" :key="j" class="h-3.5" :class="c" />
    </div>
  </div>
</template>
