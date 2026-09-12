<template>
  <component
    :is="href ? resolveComponent('NuxtLink') : 'div'"
    :to="href"
    role="option"
    :aria-selected="selected"
    class="flex items-center gap-3 px-4 py-3 transition-colors rounded-md cursor-pointer"
    :class="{ 'bg-signal/20': selected, 'hover:bg-gray-50': !selected }"
  >
    <div
      class="flex-shrink-0 w-10 h-10 rounded-md flex items-center justify-center text-sm font-mono font-semibold"
      :class="iconClass(item.entity_type)"
    >
      <UserIdentity
        v-if="item.entity_type === 'user'"
        :user="{ id: item.entity_id, username: String(item.metadata.username ?? '') }"
        :show-username="false"
        :link="false"
        size="md"
      />
      <span v-else>{{ iconText(item.entity_type, item.metadata) }}</span>
    </div>

    <div class="flex-1 min-w-0">
      <div class="text-sm font-medium text-text truncate">
        <template v-for="(seg, i) in highlightedSegments" :key="i">
          <mark v-if="seg.highlight" class="bg-yellow-200 text-inherit">{{ seg.text }}</mark>
          <span v-else>{{ seg.text }}</span>
        </template>
      </div>
      <div class="text-xs text-text-secondary truncate">
        {{ metaLine(item) }}
      </div>
    </div>

    <div class="flex-shrink-0 text-xs text-text-muted">
      {{ typeLabel(item.entity_type) }}
    </div>
  </component>
</template>

<script setup lang="ts">
import { computed, resolveComponent } from "vue";
import type { SearchItem } from "~/composables/useSearch";
import {
  iconClass,
  iconText,
  itemHref,
  metaLine,
  typeLabel,
} from "~/utils/searchFormat";

const props = defineProps<{
  item: SearchItem;
  selected?: boolean;
}>();

const href = computed(() => itemHref(props.item));

const highlightedSegments = computed(() => {
  const raw = props.item.highlight ?? "";
  const segments: { text: string; highlight: boolean }[] = [];
  const parts = raw.split("[[HIGHLIGHT]]");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (i === 0) {
      if (part) segments.push({ text: part, highlight: false });
      continue;
    }
    const end = part.indexOf("[[/HIGHLIGHT]]");
    if (end === -1) {
      if (part) segments.push({ text: part, highlight: true });
      continue;
    }
    if (part.slice(0, end)) {
      segments.push({ text: part.slice(0, end), highlight: true });
    }
    if (part.slice(end + "[[/HIGHLIGHT]]".length)) {
      segments.push({
        text: part.slice(end + "[[/HIGHLIGHT]]".length),
        highlight: false,
      });
    }
  }
  return segments;
});
</script>
