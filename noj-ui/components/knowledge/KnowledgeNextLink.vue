<script setup lang="ts">
/**
 * 题目页「同类下一题」入口（P2）：该题主知识点阶梯中难度更高、用户未达标的下一题。
 *
 * 数据在组件内自行拉取，任何失败（未归类 / 无更高难度 / 功能关闭）都不渲染，
 * 不干扰题面主流程。
 */
import { ladderItemPath, type KnowledgeLadderItem } from '~/utils/knowledge';

const props = defineProps<{ problemId: string | null | undefined; userKey?: string | null }>();

const knowledge = useKnowledge();
const next = ref<KnowledgeLadderItem | null>(null);

watch(
  () => [props.problemId, props.userKey] as const,
  async ([problemId]) => {
    next.value = null;
    if (!problemId || knowledge.disabled.value) return;
    next.value = await knowledge.loadNextForProblem(problemId);
  },
  { immediate: true },
);

const to = computed(() => (next.value ? ladderItemPath(next.value) : null));
</script>

<template>
  <section
    v-if="to && next"
    aria-labelledby="knowledge-next-heading"
    class="rounded-xl border border-border bg-white p-5"
  >
    <h2 id="knowledge-next-heading" class="mb-3 flex items-center gap-1.5 text-sm font-semibold text-text">
      <UIcon name="i-lucide-arrow-up-right" class="size-4 text-primary" aria-hidden="true" />
      同类下一题
    </h2>
    <NuxtLink :to="to" class="group flex items-start gap-2 no-underline">
      <span class="min-w-0 flex-1">
        <span class="block truncate text-sm font-medium text-text group-hover:text-primary">{{ next.title }}</span>
        <span class="mt-1 block text-xs text-text-muted tabular-nums">
          <span v-if="next.number !== null">#{{ next.number }} · </span>难度 {{ next.difficulty }}
        </span>
      </span>
      <DifficultyBadge :difficulty="next.tier" />
    </NuxtLink>
  </section>
</template>
