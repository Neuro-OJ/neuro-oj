<template>
  <component
    :is="href ? resolveComponent('NuxtLink') : 'div'"
    :to="href"
    class="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors rounded-md cursor-pointer"
    :class="{ 'bg-primary-bg/10': selected }"
  >
    <!-- 题号 / 用户头像占位 -->
    <div
      class="flex-shrink-0 w-10 h-10 rounded-md flex items-center justify-center text-sm font-mono font-semibold"
      :class="kind === 'problem' ? 'bg-primary-bg text-primary' : 'bg-info-bg text-info-text'"
    >
      <span v-if="kind === 'problem'">{{ displayId || item.display_id }}</span>
      <span v-else>{{ usernameInitial }}</span>
    </div>

    <!-- 主信息 -->
    <div class="flex-1 min-w-0">
      <div class="text-sm font-medium text-text truncate" v-html="highlightedTitle" />
      <div class="text-xs text-text-secondary truncate">
        <span v-if="kind === 'problem'">
          {{ difficultyLabel }} · {{ rankText }}
        </span>
        <span v-else>
          {{ roleLabel }}
        </span>
      </div>
    </div>

    <!-- 类型徽章 -->
    <div class="flex-shrink-0 text-xs text-text-muted">
      {{ kind === "problem" ? "题目" : "用户" }}
    </div>
  </component>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { ProblemSearchResult, UserSearchResult } from "~/composables/useSearch";

const props = defineProps<{
  item: ProblemSearchResult | UserSearchResult;
  kind: "problem" | "user";
  selected?: boolean;
  displayId?: string;
  rank?: number;
}>();

const href = computed(() => {
  if (props.kind === "problem") {
    const p = props.item as ProblemSearchResult;
    return `/problems/${p.display_id || p.id}`;
  }
  const u = props.item as UserSearchResult;
  return `/users/${u.id}`;
});

const usernameInitial = computed(() => {
  const u = props.item as UserSearchResult;
  return u.username?.[0]?.toUpperCase() ?? "?";
});

const difficultyLabel = computed(() => {
  const p = props.item as ProblemSearchResult;
  return { easy: "简单", medium: "中等", hard: "困难" }[p.difficulty] ?? p.difficulty;
});

const roleLabel = computed(() => {
  const u = props.item as UserSearchResult;
  return u.role === "admin" ? "管理员" : "用户";
});

const rankText = computed(() => {
  return props.rank !== undefined ? `相关度 ${(props.rank * 100).toFixed(0)}` : "";
});

// 将 [[HIGHLIGHT]]...[[/HIGHLIGHT]] 转为 <mark>（受控渲染，marker 来自服务端 ts_headline）
const highlightedTitle = computed(() => {
  const item = props.item as ProblemSearchResult | UserSearchResult;
  const raw = props.kind === "problem"
    ? (item as ProblemSearchResult).highlight
    : (item as UserSearchResult).highlight;
  return raw
    .replaceAll("[[HIGHLIGHT]]", '<mark class="bg-yellow-200">')
    .replaceAll("[[/HIGHLIGHT]]", "</mark>");
});
</script>
