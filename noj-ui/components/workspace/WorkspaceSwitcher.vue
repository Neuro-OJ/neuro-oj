<script setup lang="ts">
import { computed } from 'vue';
import type { WorkspaceSummary } from '~/utils/workspace';
import { workspacePath } from '~/utils/workspace';
const props = defineProps<{ workspaces: WorkspaceSummary[]; currentSlug?: string | null; pending?: boolean }>();
const emit = defineEmits<{ select: [workspace: WorkspaceSummary] }>();
const current = computed(() => props.workspaces.find((workspace) => workspace.slug === props.currentSlug));
const items = computed(
  () => [
    props.workspaces.map((workspace) => ({
      label: workspace.name,
      icon: workspace.slug === props.currentSlug ? 'i-lucide-check' : 'i-lucide-building-2',
      onSelect: () => emit('select', workspace),
    })),
    [{ label: '浏览空间', to: '/workspaces', icon: 'i-lucide-grid-2x2' }],
  ],
);
</script>

<template>
  <UDropdownMenu v-if="!pending && workspaces.length > 1" :items="items">
    <UButton color="neutral" variant="outline" icon="i-lucide-building-2" trailing-icon="i-lucide-chevron-down"
      class="max-w-48" aria-label="切换空间">
      <span class="truncate">{{ current?.name ?? '选择空间' }}</span>
    </UButton>
  </UDropdownMenu>
  <NuxtLink v-else-if="!pending && current" :to="workspacePath(current.slug)"
    class="text-sm font-medium text-text no-underline" data-testid="single-workspace">{{ current.name }}</NuxtLink>
</template>
