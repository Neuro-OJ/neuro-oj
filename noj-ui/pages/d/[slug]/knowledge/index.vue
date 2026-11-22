<script setup lang="ts">
/**
 * 域内「我的学习」（知识图谱 P3）：接下来学什么 + 掌握度。
 *
 * - 推荐理由由 `recommendationReasonText` 按 `reason.code` 拼中文（未知 code 回退通用文案）；
 * - 掌握状态徽标：已掌握=成功绿、学习中=品牌主色、未开始=中性灰（语义色映射设计 token）；
 * - 总开关关闭（`KNOWLEDGE_DISABLED`）时整块隐藏、不报错；未登录提示登录，不发请求。
 */
import { extractApiError } from '~/utils/server/apiError';
import {
  type KnowledgeRecommendation,
  ladderItemPath,
  masteryPercent,
  type MasteryState,
  masteryStateColor,
  masteryStateLabel,
  type MyMasteryView,
  type RecommendationReason,
  recommendationReasonText,
} from '~/utils/domain/education/knowledge';

definePageMeta({ layout: 'workspace', middleware: 'workspace-context', workspaceWidth: 'library' });

const { slug } = useWorkspace();
const { isLoggedIn, user } = useAuth();
const knowledge = useKnowledge();

const mastery = ref<MyMasteryView | null>(null);
const recommendations = ref<KnowledgeRecommendation[]>([]);
const loading = ref(true);
const failure = ref('');

/** 功能关闭：整块隐藏，不报错。 */
const hidden = computed(() => knowledge.disabled.value);

async function load() {
  const domain = slug.value;
  if (!domain) return;
  if (!isLoggedIn.value) {
    loading.value = false;
    mastery.value = null;
    recommendations.value = [];
    return;
  }
  loading.value = true;
  failure.value = '';
  try {
    const [loadedMastery, loadedRecommendations] = await Promise.all([
      knowledge.loadMyMastery(domain),
      knowledge.loadRecommendations(domain, 5),
    ]);
    if (knowledge.disabled.value) return;
    mastery.value = loadedMastery;
    recommendations.value = loadedRecommendations?.items ?? [];
  } catch (error) {
    if (knowledge.disabled.value) return;
    failure.value = extractApiError(error).message;
  } finally {
    loading.value = false;
  }
}

watch([() => slug.value, () => user.value?.id], () => {
  void load();
}, { immediate: true });

function nodePath(id: string): string {
  return `/d/${encodeURIComponent(slug.value ?? '')}/knowledge/${encodeURIComponent(id)}`;
}

function recommendationReason(reason: RecommendationReason): string {
  return recommendationReasonText(reason);
}

/** 推荐题链接（复用阶梯项路径）。 */
function recommendationProblemPath(item: KnowledgeRecommendation): string | null {
  return item.next ? ladderItemPath(item.next) : null;
}

function stateLabel(state: MasteryState): string {
  return masteryStateLabel(state);
}

function stateColor(state: MasteryState): 'success' | 'primary' | 'neutral' {
  return masteryStateColor(state);
}

const items = computed(() => mastery.value?.items ?? []);
const showEmptyRecommendations = computed(() => !loading.value && !failure.value && recommendations.value.length === 0);

useBreadcrumbParams({});
useSeoMeta({ title: '我的学习' });
</script>

<template>
  <div v-if="!hidden" class="space-y-6">
    <header class="space-y-1">
      <h1 class="text-2xl font-bold text-text">我的学习</h1>
      <p class="text-sm text-text-secondary">按知识图谱的掌握状态安排下一步：先补齐前置，再攻克新知识点。</p>
    </header>

    <UAlert
      v-if="!isLoggedIn"
      color="neutral"
      variant="subtle"
      icon="i-lucide-log-in"
      title="登录后查看你的学习进度"
      description="登录后可看到掌握状态、推荐知识点与待巩固的前置。"
    />

    <AsyncContent
      v-else
      :status="failure ? 'error' : loading ? 'loading' : 'data'"
      :error="failure || undefined"
      @retry="load()"
    >
      <div class="space-y-6">
        <!-- 接下来学什么 -->
        <section aria-labelledby="knowledge-next" class="space-y-3">
          <h2 id="knowledge-next" class="text-lg font-semibold text-text">接下来学什么</h2>
          <p v-if="showEmptyRecommendations"
            class="noj-panel border border-border bg-white px-4 py-6 text-sm text-text-secondary">
            暂无推荐，去题库做几道题吧
          </p>
          <ul v-else class="grid gap-3 md:grid-cols-2">
            <li
              v-for="item in recommendations"
              :key="`${item.node.id}:${item.reason.code}`"
              class="noj-panel border border-border bg-white p-4"
              data-testid="recommendation-card"
            >
              <div class="flex items-start justify-between gap-2">
                <NuxtLink
                  :to="nodePath(item.node.id)"
                  class="break-words text-base font-semibold text-text no-underline hover:text-primary"
                >
                  {{ item.node.name }}
                </NuxtLink>
                <UBadge :color="stateColor(item.node.state)" variant="subtle" size="sm">
                  {{ stateLabel(item.node.state) }}
                </UBadge>
              </div>
              <p class="mt-1 text-sm text-text-secondary">
                {{ recommendationReason(item.reason) }}
              </p>
              <div v-if="item.next" class="mt-3 flex flex-wrap items-center gap-2 text-sm">
                <span class="text-xs text-text-muted">推荐题</span>
                <NuxtLink
                  v-if="recommendationProblemPath(item)"
                  :to="recommendationProblemPath(item)!"
                  class="break-words font-medium text-primary no-underline hover:underline"
                >
                  {{ item.next.number !== null ? `${item.next.number}. ` : '' }}{{ item.next.title }}
                </NuxtLink>
                <span v-else class="break-words font-medium text-text">{{ item.next.title }}</span>
                <ProblemDifficultyBadge :difficulty="item.next.tier" />
              </div>
            </li>
          </ul>
        </section>

        <!-- 掌握度（按当前域汇总） -->
        <section aria-labelledby="knowledge-mastery" class="space-y-3">
          <h2 id="knowledge-mastery" class="text-lg font-semibold text-text">掌握度</h2>
          <p v-if="!mastery || mastery.total === 0"
            class="noj-panel border border-border bg-white px-4 py-6 text-sm text-text-secondary">
            本领域暂无可学习知识点的题目
          </p>
          <div
            v-else
            class="overflow-hidden noj-panel border border-border bg-white"
            data-testid="mastery-summary"
          >
            <div
              class="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 py-3 text-sm">
              <span class="font-semibold text-text">已掌握</span>
              <span class="tabular-nums text-success">{{ mastery.mastered }}</span>
              <span class="text-text-secondary">学习中</span>
              <span class="tabular-nums text-primary">{{ mastery.learning }}</span>
              <span class="text-text-secondary">总数</span>
              <span class="tabular-nums text-text">{{ mastery.total }}</span>
              <span class="ml-auto text-xs text-text-muted tabular-nums">
                掌握率 {{ masteryPercent(mastery.mastered, mastery.total) }}%
              </span>
            </div>
            <div
              class="h-1.5 bg-bg-sunken"
              role="progressbar"
              :aria-valuenow="masteryPercent(mastery.mastered, mastery.total)"
              aria-valuemin="0"
              aria-valuemax="100"
              aria-label="掌握率"
            >
              <div
                class="h-full bg-success transition-[width]"
                :style="{ width: `${masteryPercent(mastery.mastered, mastery.total)}%` }"
              />
            </div>
            <ul class="divide-y divide-border">
              <li
                v-for="item in items"
                :key="item.node_id"
                class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5"
                data-testid="mastery-node"
              >
                <NuxtLink
                  :to="nodePath(item.node_id)"
                  class="min-w-0 flex-1 break-words text-sm font-medium text-text no-underline hover:text-primary"
                >
                  {{ item.name }}
                </NuxtLink>
                <span class="text-xs text-text-muted tabular-nums">题 {{ item.problem_count }}</span>
                <UBadge :color="stateColor(item.state)" variant="subtle" size="sm">
                  {{ stateLabel(item.state) }}
                </UBadge>
              </li>
            </ul>
          </div>
        </section>
      </div>
    </AsyncContent>
  </div>
  <p v-else class="py-12 text-center text-sm text-text-muted" data-testid="knowledge-disabled">
    本实例未开启知识图谱。
  </p>
</template>
