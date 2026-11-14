<script setup lang="ts">
/**
 * 域内知识点页（P2）：简介 + 考纲标签 + 前置/后续知识点 + 讲解 markdown + 题目阶梯。
 *
 * - 讲解复用 `MarkdownRenderer`（markdown-it + KaTeX + 现有净化），不另起渲染管线；
 * - 阶梯按校准难度升序，`next`（推荐下一题）高亮；
 * - 总开关关闭（`KNOWLEDGE_DISABLED`）时整块隐藏、不报错；节点不存在 → 404。
 */
import { extractApiError } from '~/utils/apiError';
import type { ProblemKnowledgeView } from '~/utils/knowledge';
import {
  ladderEntryItem,
  ladderItemPath,
  type KnowledgeLadder,
  type KnowledgeNodeView,
} from '~/utils/knowledge';

definePageMeta({ layout: 'workspace', middleware: 'workspace-context' });

const route = useRoute();
const { slug } = useWorkspace();
const { user } = useAuth();
const knowledge = useKnowledge();
const nodeId = computed(() => String(route.params.nodeId));

const node = ref<KnowledgeNodeView | null>(null);
const ladder = ref<KnowledgeLadder | null>(null);
const graph = ref<Awaited<ReturnType<typeof knowledge.loadGraph>>>(null);
const loading = ref(true);
const failure = ref('');
const notFound = ref(false);
/** 阶梯内题目所属域的知识点归类（用于跨域题目链接的知识点标签）。 */
const domainProblemViews = ref<Record<string, ProblemKnowledgeView | null>>({});

/** 功能关闭：整块隐藏，不报错。 */
const hidden = computed(() => knowledge.disabled.value);

async function load() {
  const id = nodeId.value;
  const currentSlug = slug.value;
  if (!currentSlug) return;
  loading.value = true;
  failure.value = '';
  notFound.value = false;
  try {
    const [loadedNode, loadedLadder, loadedGraph] = await Promise.all([
      knowledge.loadNode(id),
      knowledge.loadLadder(id, currentSlug),
      knowledge.loadGraph(),
    ]);
    if (knowledge.disabled.value) return;
    if (!loadedNode) {
      notFound.value = true;
      return;
    }
    node.value = loadedNode;
    ladder.value = loadedLadder;
    graph.value = loadedGraph;
    // 阶梯题目若不在当前域，按各自域补读归类（仅用于标签展示，失败静默）。
    const foreign = (loadedLadder?.items ?? []).filter((item) => item.domain !== currentSlug);
    const pairs = await Promise.all(foreign.map(async (item) => {
      try {
        return [item.problem_id, await knowledge.loadProblem(item.problem_id)] as const;
      } catch {
        return [item.problem_id, null] as const;
      }
    }));
    domainProblemViews.value = Object.fromEntries(pairs);
  } catch (error) {
    if (knowledge.disabled.value) return;
    failure.value = extractApiError(error).message;
  } finally {
    loading.value = false;
  }
}

watch([() => slug.value, () => user.value?.id, nodeId], () => {
  void load();
}, { immediate: true });

/** 节点名称：优先图谱（含未在当前域出现的兄弟节点），回退到 ID。 */
function nodeLabel(id: string): string {
  return graph.value?.nodes.find((item) => item.id === id)?.name ?? id;
}

function nodePath(id: string): string {
  return `/d/${encodeURIComponent(slug.value ?? '')}/knowledge/${encodeURIComponent(id)}`;
}

const areaName = computed(() => {
  const area = node.value?.area;
  if (!area) return null;
  return graph.value?.areas.find((item) => item.id === area)?.name ?? area;
});

const firstProblem = computed(() => {
  const item = ladderEntryItem(ladder.value);
  return item ? ladderItemPath(item) : null;
});

const nextId = computed(() => ladder.value?.next?.problem_id ?? null);
const items = computed(() => ladder.value?.items ?? []);

useBreadcrumbParams({ nodeId: () => node.value?.name });
useSeoMeta({ title: () => node.value?.name ?? '知识点' });
</script>

<template>
  <div v-if="!hidden" class="space-y-6">
    <UAlert v-if="notFound" color="error" title="知识点不存在或已被移除" />
    <AsyncContent
      v-else
      :status="failure ? 'error' : loading ? 'loading' : node ? 'data' : 'empty'"
      :error="failure || undefined"
      @retry="load()"
    >
      <div v-if="node" class="space-y-6">
        <header class="space-y-3">
          <NuxtLink
            :to="`/d/${slug}/problems`"
            class="inline-flex items-center gap-1 text-sm text-text-secondary no-underline hover:text-primary"
          >
            <UIcon name="i-lucide-arrow-left" class="size-4" />
            题库
          </NuxtLink>
          <h1 class="break-words text-2xl font-bold text-text">{{ node.name }}</h1>
          <div class="flex flex-wrap items-center gap-2 text-sm text-text-secondary">
            <UBadge color="neutral" variant="subtle" size="sm" icon="i-lucide-folder-tree">
              领域：{{ areaName ?? node.area }}
            </UBadge>
            <UBadge
              v-for="tag in node.syllabus"
              :key="tag"
              color="info"
              variant="subtle"
              size="sm"
              icon="i-lucide-book-marked"
            >
              {{ tag }}
            </UBadge>
          </div>
          <p v-if="node.summary" class="max-w-prose text-sm leading-relaxed text-text-secondary">
            {{ node.summary }}
          </p>
        </header>

        <section
          v-if="node.requires.length || node.dependents.length"
          aria-label="知识点关系"
          class="grid gap-4 sm:grid-cols-2"
        >
          <div v-if="node.requires.length" class="rounded-xl border border-border bg-white p-4">
            <h2 class="mb-2 text-sm font-semibold text-text">前置知识点</h2>
            <ul class="flex flex-wrap gap-2">
              <li v-for="id in node.requires" :key="id">
                <NuxtLink
                  :to="nodePath(id)"
                  class="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-0.5 text-xs font-medium text-text-secondary no-underline transition-colors hover:border-primary/40 hover:text-primary"
                >
                  {{ nodeLabel(id) }}
                </NuxtLink>
              </li>
            </ul>
          </div>
          <div v-if="node.dependents.length" class="rounded-xl border border-border bg-white p-4">
            <h2 class="mb-2 text-sm font-semibold text-text">后续知识点</h2>
            <ul class="flex flex-wrap gap-2">
              <li v-for="id in node.dependents" :key="id">
                <NuxtLink
                  :to="nodePath(id)"
                  class="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-0.5 text-xs font-medium text-text-secondary no-underline transition-colors hover:border-primary/40 hover:text-primary"
                >
                  {{ nodeLabel(id) }}
                </NuxtLink>
              </li>
            </ul>
          </div>
        </section>

        <!-- 讲解：仅内容包提供 doc 时显示；markdown + 公式走既有净化管线 -->
        <section v-if="node.doc" aria-labelledby="knowledge-doc" class="rounded-xl border border-border bg-white p-5 sm:p-6">
          <h2 id="knowledge-doc" class="mb-4 text-lg font-semibold text-text">讲解</h2>
          <MarkdownRenderer :content="node.doc" />
          <div v-if="firstProblem" class="mt-6 flex flex-wrap items-center gap-3 border-t border-border pt-4">
            <UButton :to="firstProblem" icon="i-lucide-play" label="去做第一题" />
            <span class="text-xs text-text-muted">按难度由易到难安排，先做一题检验理解。</span>
          </div>
        </section>

        <section aria-labelledby="knowledge-ladder" class="overflow-hidden rounded-xl border border-border bg-white">
          <div class="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
            <h2 id="knowledge-ladder" class="font-semibold text-text">题目阶梯</h2>
            <span class="text-xs text-text-muted tabular-nums">
              共 {{ items.length }} 题 · 按难度升序
            </span>
          </div>
          <p v-if="items.length === 0" class="px-4 py-6 text-sm text-text-secondary">
            本空间暂无该知识点的题目
          </p>
          <ol v-else class="divide-y divide-border">
            <li
              v-for="item in items"
              :key="item.problem_id"
              :class="{ 'bg-primary/5': item.problem_id === nextId }"
              class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3"
            >
              <span class="w-8 shrink-0 text-xs text-text-muted tabular-nums">{{ item.number ?? '—' }}</span>
              <DifficultyBadge :difficulty="item.tier" />
              <span class="min-w-0 flex-1">
                <NuxtLink
                  v-if="ladderItemPath(item)"
                  :to="ladderItemPath(item)!"
                  class="break-words text-sm font-medium text-text no-underline hover:text-primary"
                >
                  {{ item.title }}
                </NuxtLink>
                <span v-else class="break-words text-sm font-medium text-text">{{ item.title }}</span>
                <span class="ml-2 text-xs text-text-muted tabular-nums">{{ item.difficulty }}</span>
                <KnowledgeTags
                  v-if="item.domain !== slug"
                  :view="domainProblemViews[item.problem_id] ?? null"
                  :domain="item.domain"
                  class="mt-2"
                />
              </span>
              <UBadge
                v-if="item.passed === true"
                color="success"
                variant="subtle"
                size="sm"
                icon="i-lucide-check"
                aria-label="已达标"
              >
                已达标
              </UBadge>
              <UBadge
                v-if="item.problem_id === nextId"
                color="primary"
                variant="solid"
                size="sm"
                icon="i-lucide-flag"
                aria-label="推荐下一题"
              >
                推荐下一题
              </UBadge>
            </li>
          </ol>
        </section>
      </div>
    </AsyncContent>
  </div>
</template>
