<script setup lang="ts">
/**
 * 统一状态徽标。`status` 为字符串，`label` 缺省时直接显示 status。
 */
const props = defineProps<{
  status: string
  label?: string
}>()

const STATUS_COLORS: Record<string, string> = {
  published: "bg-green-100 text-green-800",
  active: "bg-green-100 text-green-800",
  enabled: "bg-green-100 text-green-800",
  public: "bg-green-100 text-green-800",
  resolved: "bg-green-100 text-green-800",
  approved: "bg-green-100 text-green-800",
  pending: "bg-yellow-100 text-yellow-800",
  pending_review: "bg-yellow-100 text-yellow-800",
  hidden: "bg-gray-100 text-gray-600",
  disabled: "bg-gray-100 text-gray-600",
  dismissed: "bg-gray-100 text-gray-600",
  rejected: "bg-red-100 text-red-800",
  deleted: "bg-red-100 text-red-800",
  error: "bg-red-100 text-red-800",
  private: "bg-gray-100 text-gray-600",
  invite: "bg-blue-100 text-blue-800",
  judging: "bg-blue-100 text-blue-800",
  reviewed: "bg-blue-100 text-blue-800",
}

const colorClass = computed(() => STATUS_COLORS[props.status] ?? "bg-gray-100 text-gray-600")
</script>

<template>
  <span :class="['inline-block px-2 py-0.5 rounded text-xs font-semibold whitespace-nowrap', colorClass]">
    {{ label ?? status }}
  </span>
</template>
