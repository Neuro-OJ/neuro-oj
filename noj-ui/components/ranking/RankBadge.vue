<script setup lang="ts">
/** 榜单名次徽章：前三名金/银/铜，其余为中性编号。 */
defineProps<{ rank: number }>()
</script>

<template>
  <span
    v-if="rank === 1"
    class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold tabular-nums rank-badge-gold"
  >
    <UIcon name="i-lucide-crown" class="size-3.5 text-amber-500 shrink-0" />
    #1
  </span>
  <span
    v-else-if="rank === 2"
    class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold tabular-nums rank-badge-silver"
  >
    <UIcon name="i-lucide-medal" class="size-3.5 text-slate-400 shrink-0" />
    #2
  </span>
  <span
    v-else-if="rank === 3"
    class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold tabular-nums rank-badge-bronze"
  >
    <UIcon name="i-lucide-medal" class="size-3.5 text-orange-600 shrink-0" />
    #3
  </span>
  <span
    v-else
    class="inline-flex items-center justify-center min-w-[2rem] px-2 py-0.5 rounded text-xs font-medium tabular-nums bg-bg-sunken text-text-muted border border-border/60"
  >
    #{{ rank }}
  </span>
</template>
