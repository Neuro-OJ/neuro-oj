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
          <!-- 搜索输入 -->
          <div class="flex items-center gap-3 px-4 h-14 border-b border-border">
            <UIcon name="i-lucide-search" class="w-5 h-5 text-text-muted size-4" />
            <input
              ref="inputRef"
              v-model="query"
              type="text"
              :placeholder="placeholder"
              :aria-label="placeholder"
              class="flex-1 h-full bg-transparent outline-none text-base text-text placeholder:text-text-muted"
              autocomplete="off"
              spellcheck="false"
            />
            <kbd class="hidden sm:inline-block px-2 py-1 text-xs bg-gray-100 border border-border rounded">ESC</kbd>
          </div>

          <!-- 结果列表 -->
          <div v-if="state.loading" class="px-4 py-8 text-center text-text-muted text-sm">
            搜索中...
          </div>

          <div
            v-else-if="query.length >= 2 && state.results.problems.length === 0 && state.results.users.length === 0 && state.results.community.length === 0 && !state.loading"
            class="px-4 py-8 text-center text-text-muted text-sm"
          >
            没有匹配结果
          </div>

          <div v-else-if="query.length < 2" class="px-4 py-8 text-center text-text-muted text-sm">
            请输入至少 2 个字符
          </div>

          <div v-else class="max-h-[50vh] overflow-y-auto" role="listbox" aria-label="搜索结果">
            <div v-if="state.results.problems.length > 0" class="px-4 pt-3 pb-1 text-xs text-text-muted font-medium">
              题目
            </div>
            <SearchResultItem
              v-for="(p, i) in state.results.problems"
              :key="`p-${p.id}`"
              :item="p"
              kind="problem"
              :selected="selectedIndex === i"
              @click="close"
            />

            <div v-if="state.results.users.length > 0" class="px-4 pt-3 pb-1 text-xs text-text-muted font-medium">
              用户
            </div>
            <SearchResultItem
              v-for="(u, j) in state.results.users"
              :key="`u-${u.id}`"
              :item="u"
              kind="user"
              :selected="selectedIndex === state.results.problems.length + j"
              @click="close"
            />

            <div v-if="state.results.community.length > 0" class="px-4 pt-3 pb-1 text-xs text-text-muted font-medium">
              帖子
            </div>
            <SearchResultItem
              v-for="(post, k) in state.results.community"
              :key="`c-${post.id}`"
              :item="post"
              kind="community"
              :selected="selectedIndex === state.results.problems.length + state.results.users.length + k"
              @click="close"
            />
          </div>

          <!-- 底部提示 -->
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

import {
  useSearch,
  type CommunitySearchResult,
  type ProblemSearchResult,
  type UserSearchResult,
} from "~/composables/useSearch";
import { problemUrl, publicUrl, userUrl } from "~/utils/publicIdentifiers";

const { state, close, search } = useSearch();
const query = ref("");
const selectedIndex = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);
let lastFocused: HTMLElement | null = null;

// 焦点陷阱：Tab/Shift+Tab 在对话框内循环（WCAG 2.1.2）
function getFocusable(): HTMLElement[] {
  if (!panelRef.value) return [];
  return Array.from(
    panelRef.value.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => el.offsetParent !== null || el === document.activeElement);
}

const placeholder = computed(() => "搜索题目、用户、帖子...");

type PaletteItem =
  | { kind: "problem"; item: ProblemSearchResult }
  | { kind: "user"; item: UserSearchResult }
  | { kind: "community"; item: CommunitySearchResult };

const flatItems = computed<PaletteItem[]>(() => [
  ...state.value.results.problems.map((item) => ({ kind: "problem" as const, item })),
  ...state.value.results.users.map((item) => ({ kind: "user" as const, item })),
  ...state.value.results.community.map((item) => ({ kind: "community" as const, item })),
]);

watch(query, async (q) => {
  selectedIndex.value = 0;
  await search(q);
});

watch(
  () => state.value.open,
  async (open) => {
    if (open) {
      lastFocused = document.activeElement as HTMLElement;
      query.value = state.value.query;
      selectedIndex.value = 0;
      await nextTick();
      inputRef.value?.focus();
    } else if (lastFocused) {
      lastFocused.focus();
      lastFocused = null;
    }
  },
);

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    close();
  } else if (e.key === "Tab") {
    // 焦点陷阱：首尾循环
    const items = getFocusable();
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    selectedIndex.value = Math.min(
      selectedIndex.value + 1,
      flatItems.value.length - 1,
    );
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    selectedIndex.value = Math.max(selectedIndex.value - 1, 0);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const selected = flatItems.value[selectedIndex.value];
    if (selected) {
      const href = selected.kind === "problem"
        ? problemUrl(selected.item.id, selected.item.display_id)
        : selected.kind === "community"
        ? publicUrl("post", selected.item.public_id || selected.item.id)
        : userUrl(selected.item.username);
      close();
      navigateTo(href);
    } else if (query.value.trim().length >= 2) {
      // 没选中：跳完整结果页
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
