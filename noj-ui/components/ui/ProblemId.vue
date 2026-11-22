<script setup lang="ts">
import { defaultProblemLabel } from '~/utils/default-workspace';
interface Props {
  /** 域内题目引用：`{domain}:{number}` 或纯数字。 */
  displayId: string;
}

defineProps<Props>();
</script>

<template>
  <span
    class="font-mono text-xs font-semibold px-1.5 py-0.5 rounded bg-primary/10 text-primary"
  >
    {{ defaultProblemLabel(displayId) }}
  </span>
</template>
