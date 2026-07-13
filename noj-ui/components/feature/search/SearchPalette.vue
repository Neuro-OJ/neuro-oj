<template>
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="state.open"
        class="fixed inset-0 z-[200] bg-black/30 flex items-start justify-center pt-[15vh]"
        @click.self="close"
      >
        <div
          class="w-full max-w-2xl bg-white rounded-lg shadow-modal overflow-hidden"
          @keydown="onKeydown"
        >
          <!-- 搜索输入 -->
          <div class="flex items-center gap-3 px-4 h-14 border-b border-border">
            <SearchIcon class="w-5 h-5 text-text-muted" />
            <input
              ref="inputRef"
              v-model="query"
              type="text"
              :placeholder="placeholder"
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
            v-else-if="query.length >= 2 && state.results.problems.length === 0 && state.results.users.length === 0 && !state.loading"
            class="px-4 py-8 text-center text-text-muted text-sm"
          >
            没有匹配结果
          </div>

          <div v-else-if="query.length < 2" class="px-4 py-8 text-center text-text-muted text-sm">
            请输入至少 2 个字符
          </div>

          <div v-else class="max-h-[50vh] overflow-y-auto">
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
import { Search as SearchIcon } from "@lucide/vue";
import { useSearch } from "~/composables/useSearch";

const { state, close, search } = useSearch();
const query = ref("");
const selectedIndex = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);

const placeholder = computed(() => "搜索题目、用户...");

const flatItems = computed(() => [
  ...state.value.results.problems,
  ...state.value.results.users,
]);

watch(query, async (q) => {
  selectedIndex.value = 0;
  await search(q);
});

watch(
  () => state.value.open,
  async (open) => {
    if (open) {
      query.value = state.value.query;
      selectedIndex.value = 0;
      await nextTick();
      inputRef.value?.focus();
    }
  },
);

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    close();
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
    const item = flatItems.value[selectedIndex.value];
    if (item) {
      const kind = selectedIndex.value < state.value.results.problems.length
        ? "problem"
        : "user";
      const href = kind === "problem"
        ? `/problems/${(item as any).display_id || (item as any).id}`
        : `/users/${(item as any).id}`;
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
