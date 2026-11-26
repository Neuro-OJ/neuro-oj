<script setup lang="ts">
/** 榜单名次：等宽数字，前三名仅加深字色，不加奖牌装饰。 */
defineProps<{ rank: number }>();
</script>

<template>
  <span class="font-mono text-xs tabular-nums" :class="rank <= 3 ? 'font-semibold text-text' : 'text-text-muted'">
    {{ rank }}
  </span>
</template>
