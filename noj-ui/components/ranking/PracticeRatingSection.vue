<script setup lang="ts">
/**
 * 个人主页「练习能力值（Best 30）」卡片与 Top-N 构成明细（issue #810）。
 * 遵循 Precision Instrument 视觉规范：高密度、等宽遥测数字、克制色阶。
 */
import type { UserPracticeRating } from '~/utils/generated/api-contracts';
import {
  formatEffectiveDifficulty,
  formatPracticeEntryScore,
  formatPracticeProgressHint,
  formatPracticeScoreRatio,
  getPracticeRatingTierMeta,
} from '~/utils/domain/ranking/practiceRatingFormat';
import { difficultyBadgeColors, difficultyLabels } from '~/utils/domain/submission/submissionFormat';
import { workspaceProblemUrl } from '~/utils/publicIdentifiers';

const props = defineProps<{
  rating: UserPracticeRating | null;
  pending: boolean;
  failed: boolean;
}>();

const emit = defineEmits<{
  retry: [];
}>();

const COLLAPSED_LIMIT = 10;
const expanded = ref(false);

const tierMeta = computed(() => getPracticeRatingTierMeta(props.rating?.tier ?? 'unrated'));
const entries = computed(() => props.rating?.entries ?? []);
const visibleEntries = computed(() => expanded.value ? entries.value : entries.value.slice(0, COLLAPSED_LIMIT));
const canExpand = computed(() => entries.value.length > COLLAPSED_LIMIT);
const progressHint = computed(() => {
  if (!props.rating) return '';
  return formatPracticeProgressHint(
    props.rating.counted_problems,
    props.rating.top_n,
    props.rating.floor_rating,
  );
});
</script>

<template>
  <section class="rounded-xl border border-border bg-bg-panel overflow-hidden">
    <div class="px-6 py-4 border-b border-border bg-bg-page flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <UIcon name="i-lucide-gauge" class="text-primary size-4.5" />
        <h2 class="text-base font-semibold text-text">
          练习能力值（Best {{ rating?.top_n ?? 30 }}）
        </h2>
        <span class="rounded px-1.5 py-0.5 text-[11px] font-medium bg-bg-sunken text-text-muted border border-border">
          与竞赛 Rating 独立
        </span>
      </div>
      <NuxtLink
        to="/leaderboard?board=practice-rating"
        class="text-xs text-primary no-underline hover:underline"
      >
        查看能力值榜
      </NuxtLink>
    </div>

    <div class="p-6">
      <div v-if="pending" class="text-sm text-text-muted">加载中...</div>

      <div v-else-if="failed" class="flex items-center justify-between gap-3">
        <span class="text-sm text-text-secondary">练习能力值加载失败</span>
        <UButton size="xs" color="primary" variant="outline" @click="emit('retry')">
          <UIcon name="i-lucide-rotate-cw" class="size-3.5" />重试
        </UButton>
      </div>

      <div v-else-if="!rating" class="text-sm text-text-muted">暂无练习能力值数据</div>

      <template v-else>
        <!-- 顶部概览遥测条 -->
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-4">
          <div class="rounded-lg border border-border bg-bg-page px-4 py-3 flex flex-col gap-1">
            <span class="text-xs text-text-muted">练习能力值</span>
            <div class="flex items-baseline gap-2">
              <span class="font-mono text-3xl font-bold tabular-nums" :class="tierMeta.scoreClass">
                {{ rating.rating }}
              </span>
              <span
                class="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium"
                :class="tierMeta.badgeClass"
              >
                {{ tierMeta.label }}
              </span>
            </div>
          </div>

          <div class="rounded-lg border border-border bg-bg-page px-4 py-3 flex flex-col gap-1">
            <span class="text-xs text-text-muted">能力值排名</span>
            <NuxtLink
              v-if="rating.rank !== null"
              to="/leaderboard?board=practice-rating"
              class="font-mono text-2xl font-bold text-text no-underline hover:text-primary tabular-nums"
            >
              #{{ rating.rank }}
            </NuxtLink>
            <span v-else class="font-mono text-xl font-semibold text-text-muted tabular-nums">未上榜</span>
          </div>

          <div class="rounded-lg border border-border bg-bg-page px-4 py-3 flex flex-col gap-1">
            <span class="text-xs text-text-muted">B{{ rating.top_n }} 收录题数</span>
            <p class="font-mono text-2xl font-bold text-text tabular-nums">
              {{ rating.counted_problems }}
              <span class="text-sm font-normal text-text-muted">/ {{ rating.top_n }}</span>
            </p>
            <span class="text-[11px] text-text-muted tabular-nums">
              共 {{ rating.total_scored_problems }} 道有效得分题
            </span>
          </div>

          <div class="rounded-lg border border-border bg-bg-page px-4 py-3 flex flex-col gap-1">
            <span class="text-xs text-text-muted">B{{ rating.top_n }} 门槛分</span>
            <p class="font-mono text-2xl font-bold text-text tabular-nums">
              {{ rating.floor_rating !== null ? rating.floor_rating : '--' }}
            </p>
            <span class="text-[11px] text-text-muted">
              {{ rating.floor_rating !== null ? '超过此分即可推高总分' : '凑满 30 题后启用门槛' }}
            </span>
          </div>
        </div>

        <!-- 推分引导与口径说明 -->
        <div class="mt-3 flex flex-col gap-1 text-xs text-text-muted">
          <p class="text-text-secondary">{{ progressHint }}</p>
          <p>
            仅统计官方主域公开题库有效最高分；随题目难度校准动态更新；不包含进行中保密赛、私有域自建题与社区互动。
          </p>
        </div>

        <!-- Top-N 构成明细表 -->
        <div v-if="entries.length > 0" class="mt-4">
          <div class="overflow-x-auto rounded-lg border border-border">
            <table class="w-full border-collapse text-[13px]">
              <thead>
                <tr class="bg-bg-sunken/60 border-b border-border text-xs font-medium text-text-muted">
                  <th scope="col" class="w-12 px-3 py-2 text-left">#</th>
                  <th scope="col" class="px-3 py-2 text-left">题目</th>
                  <th scope="col" class="w-36 px-3 py-2 text-left hidden sm:table-cell">难度口径</th>
                  <th scope="col" class="w-40 px-3 py-2 text-right">最高分 / 得分率</th>
                  <th scope="col" class="w-24 px-3 py-2 text-right">单题分</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-border">
                <tr v-for="entry in visibleEntries" :key="entry.problem_id" class="hover:bg-bg-sunken/40">
                  <td class="px-3 py-2 font-mono text-xs text-text-muted tabular-nums">
                    {{ entry.rank }}
                  </td>
                  <td class="px-3 py-2 min-w-0">
                    <div class="flex items-center gap-2 min-w-0">
                      <ProblemIdBadge :display-id="entry.display_id" />
                      <NuxtLink
                        :to="workspaceProblemUrl(entry.display_id)"
                        class="text-primary no-underline hover:underline truncate"
                      >
                        {{ entry.title }}
                      </NuxtLink>
                    </div>
                  </td>
                  <td class="px-3 py-2 hidden sm:table-cell">
                    <div class="flex items-center gap-1.5">
                      <span
                        class="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium"
                        :class="difficultyBadgeColors[entry.difficulty] || ''"
                      >
                        {{ difficultyLabels[entry.difficulty] || entry.difficulty }}
                      </span>
                      <span class="font-mono text-[11px] text-text-muted tabular-nums">
                        {{ formatEffectiveDifficulty(entry.effective_difficulty, entry.is_calibrated) }}
                      </span>
                    </div>
                  </td>
                  <td class="px-3 py-2 text-right">
                    <div class="flex flex-col items-end gap-1">
                      <span class="font-mono text-xs text-text tabular-nums">
                        {{ formatPracticeEntryScore(entry.best_score, entry.full_score) }}
                        <span class="text-text-muted">
                          ({{ formatPracticeScoreRatio(entry.score_ratio) }})
                        </span>
                      </span>
                      <div class="h-1 w-24 rounded-full bg-bg-sunken overflow-hidden">
                        <div
                          class="h-full rounded-full bg-primary transition-all"
                          :style="{ width: `${Math.min(100, Math.max(0, entry.score_ratio * 100))}%` }"
                        />
                      </div>
                    </div>
                  </td>
                  <td class="px-3 py-2 text-right font-mono font-semibold text-primary tabular-nums">
                    +{{ entry.problem_rating }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div v-if="canExpand" class="mt-3 flex justify-center">
            <UButton
              size="xs"
              color="neutral"
              variant="outline"
              @click="expanded = !expanded"
            >
              {{ expanded ? '收起明细' : `展开全部 ${entries.length} 题构成明细` }}
            </UButton>
          </div>
        </div>
      </template>
    </div>
  </section>
</template>
