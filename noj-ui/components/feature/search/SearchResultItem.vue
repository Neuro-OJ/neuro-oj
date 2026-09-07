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
      :class="iconClass"
    >
      <UserIdentity
        v-if="item.entity_type === 'user'"
        :user="{ id: item.entity_id, username: String(item.metadata.username ?? '') }"
        :show-username="false"
        size="md"
      />
      <span v-else>{{ iconText }}</span>
    </div>

    <div class="flex-1 min-w-0">
      <div class="text-sm font-medium text-text truncate">
        <template v-for="(seg, i) in highlightedSegments" :key="i">
          <mark v-if="seg.highlight" class="bg-yellow-200 text-inherit">{{ seg.text }}</mark>
          <span v-else>{{ seg.text }}</span>
        </template>
      </div>
      <div class="text-xs text-text-secondary truncate">
        {{ metaLine }}
      </div>
    </div>

    <div class="flex-shrink-0 text-xs text-text-muted">
      {{ typeLabel }}
    </div>
  </component>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { SearchItem } from "~/composables/useSearch";
import { problemUrl, publicUrl, userUrl } from "~/utils/publicIdentifiers";

const props = defineProps<{
  item: SearchItem;
  selected?: boolean;
}>();

const href = computed(() => {
  const item = props.item;
  switch (item.entity_type) {
    case "problem":
      return problemUrl(item.entity_id, String(item.metadata.display_id ?? ""));
    case "user":
      return userUrl(String(item.metadata.username ?? ""));
    case "community_post":
      return publicUrl("post", String(item.metadata.public_id ?? item.entity_id));
    case "community_comment":
      return publicUrl(
        "post",
        String(item.metadata.post_public_id ?? item.metadata.post_id ?? item.entity_id),
      );
    case "contest":
      return `/contests/${item.entity_id}`;
    case "submission":
      return `/submissions/${item.entity_id}`;
    case "message":
      return `/messages?conversation=${String(item.metadata.conversation_id ?? "")}`;
    case "announcement":
      return `/announcements/${item.entity_id}`;
    default:
      return "";
  }
});

const typeLabel = computed(() => {
  const map: Record<string, string> = {
    problem: "题目",
    user: "用户",
    community_post: "帖子",
    community_comment: "评论",
    contest: "竞赛",
    submission: "提交",
    message: "消息",
    announcement: "公告",
  };
  return map[props.item.entity_type] ?? props.item.entity_type;
});

const iconText = computed(() => {
  const map: Record<string, string> = {
    problem: String(props.item.metadata.display_id ?? "题"),
    user: "用",
    community_post: "帖",
    community_comment: "评",
    contest: "赛",
    submission: "交",
    message: "信",
    announcement: "告",
  };
  return map[props.item.entity_type] ?? "搜";
});

const iconClass = computed(() => {
  const base = "flex-shrink-0 w-10 h-10 rounded-md flex items-center justify-center text-sm font-mono font-semibold";
  const map: Record<string, string> = {
    problem: "bg-primary-bg text-primary",
    user: "bg-blue-50 text-info-text",
    community_post: "bg-amber-50 text-amber-700",
    community_comment: "bg-amber-50 text-amber-700",
    contest: "bg-purple-50 text-purple-700",
    submission: "bg-gray-100 text-gray-700",
    message: "bg-green-50 text-green-700",
    announcement: "bg-red-50 text-red-700",
  };
  return `${base} ${map[props.item.entity_type] ?? "bg-gray-100 text-gray-700"}`;
});

const metaLine = computed(() => {
  const item = props.item;
  const m = item.metadata as Record<string, unknown>;
  switch (item.entity_type) {
    case "problem":
      return `${String(m.difficulty ?? "")} · 相关度 ${(item.rank * 100).toFixed(0)}`;
    case "user":
      return String(m.email ?? "");
    case "community_post":
      return `${String(m.post_type ?? "")} · ${String(m.author_username ?? "")}`;
    case "community_comment":
      return `评论 · ${String(m.author_username ?? "")}`;
    case "contest":
      return `${String(m.kind ?? "")} · ${String(m.is_public ? "公开" : "邀请")}`;
    case "submission":
      return `${String(m.language ?? "")} · ${String(m.status ?? "")}`;
    case "message":
      return `私信 · ${String(m.sent_at ?? "")}`;
    case "announcement":
      return "公告";
    default:
      return "";
  }
});

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
