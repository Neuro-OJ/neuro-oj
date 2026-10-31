<script setup lang="ts">
import { workspacePath } from '~/utils/workspace';

/**
 * 赛后「官方题解」入口（赛题页内联版）。
 *
 * 数据源与赛题列表共用 `useOfficialSolutions`：一次拉取本域官方题解再按题分组，
 * 只认 `is_official === true`（普通题解不冒充官方）。授权完全交给域社区读取路径，
 * 跨域引用、其他比赛保密、社区关闭与隐藏帖子都由后端既有规则决定。
 *
 * 展示规则：
 * - 1 篇 → 直接跳转；
 * - 多篇 → 下拉选择（同一题可能按版本各写一篇）；
 * - 0 篇 → 显示"暂无"，不给死链。
 */
const props = defineProps<{
  slug: string;
  problemId: string;
  /** 社区功能在本域是否开启；关闭时不渲染入口。 */
  enabled?: boolean;
}>();

const enabled = computed(() => props.enabled !== false);
const { user } = useAuth();
const slugRef = computed(() => props.slug);
const official = await useOfficialSolutions(slugRef, enabled);
const rows = computed(() => official.forProblem(props.problemId));
const only = computed(() => rows.value.length === 1 ? rows.value[0]! : null);
const href = (row: (typeof rows.value)[number]) =>
  workspacePath(props.slug, `community/posts/${row.post.public_id || row.post.id}`);
</script>

<template>
  <div v-if="enabled" class="flex flex-wrap items-center gap-2 text-sm">
    <span class="flex items-center gap-1.5 text-text-secondary">
      <UIcon name="i-lucide-book-open-check" class="size-4 text-text-muted" />
      官方题解
    </span>
    <span v-if="official.loading.value" class="text-text-muted" role="status">正在读取…</span>
    <template v-else-if="only">
      <UButton :to="href(only)" size="xs" variant="outline" trailing-icon="i-lucide-arrow-up-right">
        {{ only.post.title || '查看官方题解' }}
      </UButton>
    </template>
    <template v-else-if="rows.length > 1">
      <USelect
        :items="rows.map((row) => ({ label: row.post.title || '官方题解', value: row.post.id }))"
        placeholder="选择题解"
        size="xs"
        aria-label="选择官方题解"
        @update:model-value="(value: unknown) => {
          const target = rows.find((row) => row.post.id === value);
          if (target) void navigateTo(href(target));
        }"
      />
      <span class="text-xs text-text-muted">共 {{ rows.length }} 篇</span>
    </template>
    <span v-else class="text-text-muted">暂无</span>
    <UButton
      v-if="user && rows.length > 0"
      :to="{ path: workspacePath(slug, 'community'), query: { type: 'solution', problem_id: problemId } }"
      size="xs"
      variant="ghost"
      icon="i-lucide-list"
    >
      全部题解
    </UButton>
  </div>
</template>
