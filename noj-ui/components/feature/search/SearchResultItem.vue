<template>
  <component
    :is="href ? resolveComponent('NuxtLink') : 'div'"
    :to="href"
    role="option"
    :aria-selected="selected"
    class="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors rounded-md cursor-pointer"
    :class="{ 'bg-primary-bg/10': selected }"
  >
    <!-- 题号 / 用户头像占位 -->
    <div
      class="flex-shrink-0 w-10 h-10 rounded-md flex items-center justify-center text-sm font-mono font-semibold"
      :class="kind === 'problem' ? 'bg-primary-bg text-primary' : kind === 'community' ? 'bg-amber-50 text-amber-700' : 'bg-blue-50 text-info-text'"
    >
      <UserIdentity
        v-if="kind === 'user'"
        :user="item as UserSearchResult"
        :show-username="false"
        size="md"
      />
      <span v-else-if="kind === 'problem'">{{ displayId || (item as ProblemSearchResult).display_id }}</span>
      <span v-else>帖子</span>
    </div>

    <!-- 主信息 -->
    <div class="flex-1 min-w-0">
      <div class="text-sm font-medium text-text truncate">
        <template v-for="(seg, i) in highlightedSegments" :key="i">
          <mark v-if="seg.highlight" class="bg-yellow-200 text-inherit">{{ seg.text }}</mark>
          <span v-else>{{ seg.text }}</span>
        </template>
      </div>
      <div class="text-xs text-text-secondary truncate">
        <span v-if="kind === 'problem'">
          {{ difficultyLabel }} · {{ rankText }}
        </span>
        <span v-else-if="kind === 'community'">
          {{ (item as CommunitySearchResult).type === 'solution' ? '题解' : '讨论' }} · {{ (item as CommunitySearchResult).author_username }}
        </span>
        <span v-else>
          {{ roleLabel }}
        </span>
      </div>
    </div>

    <!-- 类型徽章 -->
    <div class="flex-shrink-0 text-xs text-text-muted">
      {{ kind === "problem" ? "题目" : kind === "community" ? "帖子" : "用户" }}
    </div>
  </component>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { CommunitySearchResult, ProblemSearchResult, UserSearchResult } from "~/composables/useSearch";

const props = defineProps<{
  item: ProblemSearchResult | UserSearchResult | CommunitySearchResult;
  kind: "problem" | "user" | "community";
  selected?: boolean;
  displayId?: string;
  rank?: number;
}>();

const href = computed(() => {
  if (props.kind === "problem") {
    const p = props.item as ProblemSearchResult;
    return `/problems/${p.display_id || p.id}`;
  }
  if (props.kind === "community") return `/community/posts/${props.item.id}`;
  const u = props.item as UserSearchResult;
  return `/users/${u.id}`;
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

// NOJ-248：不使用 v-html。将 marker 拆成纯文本 segment，由 Vue 文本插值自动转义，
// 仅受控输出 <mark> 标签，用户可控内容中的 HTML 只会显示为文本。
const highlightedSegments = computed(() => {
  const item = props.item as ProblemSearchResult | UserSearchResult | CommunitySearchResult;
  const raw = (props.kind === "problem"
    ? (item as ProblemSearchResult).highlight
    : props.kind === "community"
    ? (item as CommunitySearchResult).highlight
    : (item as UserSearchResult).highlight) ?? "";
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
