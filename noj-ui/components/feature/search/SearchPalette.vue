<template>
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="state.open"
        class="fixed inset-0 z-[200] bg-black/30 flex items-start justify-center pt-[15vh]"
        @click.self="close"
      >
        <div
          ref="panelRef"
          role="dialog"
          aria-modal="true"
          aria-label="搜索"
          class="w-full max-w-2xl bg-white rounded-lg shadow-modal overflow-hidden"
          @keydown="onKeydown"
        >
          <div class="flex items-center gap-3 px-4 h-14 border-b border-border">
            <UIcon name="i-lucide-search" class="w-5 h-5 text-text-muted size-4" />
            <input
              ref="inputRef"
              v-model="query"
              type="text"
              :aria-label="t('nav.search')"
              :placeholder="t('nav.searchFull')"
              class="flex-1 h-full bg-transparent outline-none text-base text-text placeholder:text-text-muted"
              autocomplete="off"
              spellcheck="false"
            />
            <kbd class="hidden sm:inline-block px-2 py-1 text-xs bg-gray-100 border border-border rounded">ESC</kbd>
          </div>

          <div v-if="state.loading" class="px-4 py-8 text-center text-text-muted text-sm">
            搜索中...
          </div>

          <div
            v-else-if="state.error"
            class="px-4 py-8 text-center text-error-text text-sm"
          >
            {{ state.error }}
          </div>

          <div
            v-else-if="query.length >= 2 && flatItems.length === 0 && !state.loading"
            class="px-4 py-8 text-center text-text-muted text-sm"
          >
            没有匹配结果
          </div>

          <div v-else-if="query.length < 2" class="px-4 py-8 text-center text-text-muted text-sm">
            请输入至少 2 个字符
          </div>

          <div v-else class="max-h-[50vh] overflow-y-auto" role="listbox" aria-label="搜索结果">
            <template v-for="(group, type) in state.groups" :key="type">
              <div v-if="group.items.length > 0" class="px-4 pt-3 pb-1 text-xs text-text-muted font-medium">
                {{ typeLabel(type) }}
              </div>
              <SearchResultItem
                v-for="(item, i) in group.items"
                :key="`${type}-${item.entity_id}`"
                :item="item"
                :selected="selectedIndex === flatIndex(type, i)"
                @click="close"
              />
            </template>
          </div>

          <div class="flex items-center justify-between px-4 h-10 border-t border-border bg-gray-50 text-xs text-text-muted">
            <div class="flex items-center gap-3">
              <span><kbd class="px-1.5 py-0.5 bg-white border border-border rounded">↑↓</kbd> 导航</span>
              <span><kbd class="px-1.5 py-0.5 bg-white border border-border rounded">↵</kbd> 选择</span>
            </div>
            <NuxtLink
              :to="`/search?q=${encodeURIComponent(query)}&type=all`"
              class="text-primary hover:underline"
              @click="close"
            >
              查看全部结果 →
            </NuxtLink>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from "vue";
import { useSearch, type SearchItem } from "~/composables/useSearch";
import { itemHref, typeLabel } from "~/utils/searchFormat";

const { t } = useI18n();
const { state, close, search } = useSearch();
const query = ref("");
const selectedIndex = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);
let lastFocused: HTMLElement | null = null;

const flatItems = computed<SearchItem[]>(() => {
  const items: SearchItem[] = [];
  for (const group of Object.values(state.value.groups)) {
    items.push(...group.items);
  }
  return items;
});

function flatIndex(type: string, index: number): number {
  let offset = 0;
  for (const [t, group] of Object.entries(state.value.groups)) {
    if (t === type) return offset + index;
    offset += group.items.length;
  }
  return 0;
}

watch(query, async (q) => {
  selectedIndex.value = 0;
  await search(q, { mode: "palette" });
});

watch(
  () => state.value.open,
  async (open) => {
    if (open) {
      lastFocused = document.activeElement as HTMLElement;
      query.value = state.value.query;
      selectedIndex.value = 0;
      if (query.value.trim().length >= 2) {
        void search(query.value, { mode: "palette" });
      }
      await nextTick();
      inputRef.value?.focus();
    } else if (lastFocused) {
      lastFocused.focus();
      lastFocused = null;
    }
  },
);

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusableElements(): HTMLElement[] {
  if (!panelRef.value) return [];
  return Array.from(
    panelRef.value.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((el) => el.offsetParent !== null || el === document.activeElement);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Tab") {
    const focusables = getFocusableElements();
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = document.activeElement as HTMLElement | null;
    const index = active ? focusables.indexOf(active) : -1;
    if (e.shiftKey) {
      if (index <= 0) {
        e.preventDefault();
        last.focus();
      }
    } else if (index === -1 || index === focusables.length - 1) {
      e.preventDefault();
      first.focus();
    }
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    close();
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    selectedIndex.value = flatItems.value.length === 0
      ? 0
      : Math.min(selectedIndex.value + 1, flatItems.value.length - 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    selectedIndex.value = Math.max(selectedIndex.value - 1, 0);
  } else if (e.key === "Enter") {
    const target = e.target as HTMLElement | null;
    if (target?.closest('a[href]')) return;
    e.preventDefault();
    const selected = flatItems.value[selectedIndex.value];
    if (selected) {
      const href = itemHref(selected) || "/search";
      close();
      navigateTo(href);
    } else if (query.value.trim().length >= 2) {
      close();
      navigateTo(`/search?q=${encodeURIComponent(query.value)}&type=all`);
    }
  }
}

</script>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
