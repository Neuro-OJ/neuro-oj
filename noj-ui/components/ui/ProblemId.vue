<script setup lang="ts">
import { defaultProblemLabel } from '~/utils/default-workspace';
interface Props {
  displayId: string;
  type: string;
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
