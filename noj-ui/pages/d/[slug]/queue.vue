<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import { extractApiError } from '~/utils/apiError';
import { formatDateTime } from '~/utils/submissionFormat';
import { workspaceCacheKey } from '~/utils/workspace';
import type { QueueData, QueueScope } from '~/composables/useDomainQueue';

definePageMeta({
  layout: 'workspace',
  middleware: ['auth', 'workspace-context'],
  ssr: false,
});

const route = useRoute();
const router = useRouter();
const { slug } = useWorkspace();
const { user } = useAuth();
const queueApi = useDomainQueue();

const scope = computed<QueueScope>({
  get: () => (route.query.scope === 'instance' ? 'instance' : 'domain'),
  set: (val) => {
    void router.push({
      query: {
        ...route.query,
        scope: val === 'instance' ? 'instance' : undefined,
      },
    });
  },
});

const cacheKey = computed(() =>
  workspaceCacheKey(slug.value ?? '', user.value?.id ?? null, 'queue', scope.value)
);

const data = ref<QueueData | null>(null);
const loading = ref(true);
const refreshing = ref(false);
const error = ref<string | null>(null);
const lastUpdated = ref<number | null>(null);
const lastRefreshError = ref<string | null>(null);

// 实时时钟——确保 elapsed 时间每秒更新
const now = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  clockTimer = setInterval(() => {
    now.value = Date.now();
  }, 1000);
});
onUnmounted(() => {
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = null;
});

async function fetchQueue(isInitial = false) {
  const scopeKey = cacheKey.value;
  const currentSlug = slug.value ?? '';
  const currentScope = scope.value;

  if (isInitial) {
    loading.value = true;
    error.value = null;
  } else {
    refreshing.value = true;
  }
  lastRefreshError.value = null;

  try {
    const res = await queueApi.getQueue(currentSlug, currentScope);
    if (cacheKey.value !== scopeKey) return;
    data.value = res;
    lastUpdated.value = Date.now();
    error.value = null;
  } catch (e) {
    if (cacheKey.value !== scopeKey) return;
    const msg = extractApiError(e).message;
    if (!data.value) {
      error.value = msg;
    } else {
      // 刷新失败保留现有数据和更新时间
      lastRefreshError.value = msg;
    }
  } finally {
    if (cacheKey.value === scopeKey) {
      loading.value = false;
      refreshing.value = false;
    }
  }
}

// 切换域或 scope (cacheKey 变化) 时重新发起初始请求，清空上一视图
watch(cacheKey, () => {
  data.value = null;
  void fetchQueue(true);
}, { immediate: true });

// SSE 实时推送 + 轮询 fallback：收到 queue:changed 仅提示重读
// scope 切换时 useEventSource 会随 sseUrl / scopeKey 变化关闭旧订阅并重连
const sseUrl = computed(() => queueApi.sseUrl(slug.value ?? '', scope.value));

useEventSource({
  url: sseUrl,
  scopeKey: cacheKey,
  onEvent: {
    'queue:changed': async () => {
      await fetchQueue(false);
    },
  },
  fetchFn: async () => {
    await fetchQueue(false);
  },
  fallbackIntervalMs: 2000,
});

useSeoMeta({ title: '评测队列' });
</script>

<template>
  <div class="space-y-5">
    <AdminPageHeader title="评测队列" description="实时查看代码、自测及产物评测排队状态" icon="i-lucide-activity">
      <template #actions>
        <!-- 分段范围切换：当前域 vs 实例 -->
        <div class="inline-flex rounded border border-border bg-bg-sunken p-0.5">
          <button type="button"
            class="rounded px-3 py-1.5 text-xs font-medium transition-colors"
            :class="scope === 'domain' ? 'bg-bg-panel text-primary shadow-xs font-semibold' : 'text-text-secondary hover:text-text'"
            @click="scope = 'domain'">
            当前域
          </button>
          <button type="button"
            class="rounded px-3 py-1.5 text-xs font-medium transition-colors"
            :class="scope === 'instance' ? 'bg-bg-panel text-primary shadow-xs font-semibold' : 'text-text-secondary hover:text-text'"
            @click="scope = 'instance'">
            实例
          </button>
        </div>
        <UButton color="neutral" variant="ghost" icon="i-lucide-refresh-cw" aria-label="刷新队列"
          :loading="refreshing" @click="fetchQueue(false)" />
      </template>
    </AdminPageHeader>

    <!-- 实例范围说明：实例 stats 是全局数字，列表仅展示授权任务 -->
    <UAlert v-if="scope === 'instance'" color="info" icon="i-lucide-info" title="明细仅显示你有权查看的任务"
      description="当前为实例全局队列视图。上方统计数字包含全站任务总量，下方任务明细仅展示你获授权访问的任务。" />

    <!-- 刷新失败提示：保留现有数据与更新时间 -->
    <UAlert v-if="lastRefreshError" color="warning" icon="i-lucide-alert-triangle"
      :title="`刷新失败（${lastRefreshError}），已保留上次成功获取的数据`" />

    <AsyncContent :status="error ? 'error' : data ? 'data' : loading ? 'loading' : 'empty'"
      :error="error ?? undefined" empty-text="当前队列暂无任务" @retry="fetchQueue(true)">
      <div v-if="data" class="space-y-6">
        <!-- 统计摘要与更新时间 -->
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex flex-wrap items-center gap-3">
            <UBadge color="neutral" variant="subtle" class="gap-1.5 rounded px-3 py-1.5 text-xs font-semibold">
              <UIcon name="i-lucide-clock" class="size-3.5" />
              排队中 {{ data.stats.pending_count }}
              <span v-if="data.visible_counts && data.visible_counts.pending !== data.stats.pending_count" class="text-text-muted">
                (可见 {{ data.visible_counts.pending }})
              </span>
            </UBadge>
            <UBadge color="primary" variant="subtle" class="gap-1.5 rounded px-3 py-1.5 text-xs font-semibold">
              <UIcon name="i-lucide-play" class="size-3.5" />
              正在评测 {{ data.stats.judging_count }}
              <span v-if="data.visible_counts && data.visible_counts.judging !== data.stats.judging_count">
                (可见 {{ data.visible_counts.judging }})
              </span>
            </UBadge>
            <UBadge color="success" variant="subtle" class="gap-1.5 rounded px-3 py-1.5 text-xs font-semibold">
              <UIcon name="i-lucide-check-circle" class="size-3.5" />
              今日完成 {{ data.stats.completed_today }}
            </UBadge>
            <span class="text-xs text-text-muted">
              {{ scope === 'domain' ? '（当前域任务统计）' : '（实例全局统计）' }}
            </span>
          </div>

          <span v-if="lastUpdated" class="text-xs tabular-nums text-text-muted">
            更新时间: {{ formatDateTime(new Date(lastUpdated).toISOString()) }}
          </span>
        </div>

        <!-- 实例共享资源池统计 -->
        <div v-if="data.stats.pools" class="space-y-2">
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-semibold text-text">共享资源池（实例资源）</h3>
            <span class="text-xs text-text-muted">共享池为全实例共享的评测计算资源</span>
          </div>
          <div class="grid gap-3 sm:grid-cols-3">
            <UCard v-for="(pool, name) in data.stats.pools" :key="name">
              <p class="text-sm font-semibold text-text">{{ name === 'ai' ? 'AI 评测池' : name === 'oi-wasm' ? 'WASM 评测池' : name === 'oi-native' ? '原生评测池' : name }}</p>
              <p class="mt-2 text-xs tabular-nums text-text-secondary">排队 {{ pool.pending }} · 已领取 {{ pool.processing }}</p>
              <p v-if="pool.task_capacity !== undefined" class="mt-1 text-xs tabular-nums text-text-secondary">活跃提交 {{ pool.active ?? 0 }} / {{ pool.task_capacity }}</p>
              <p v-if="name === 'oi-wasm' && pool.run_capacity !== undefined" class="mt-1 text-xs tabular-nums text-text-secondary">编译 {{ pool.compiling ?? 0 }} · 运行测试点 {{ pool.running ?? 0 }} / {{ pool.run_capacity }}</p>
            </UCard>
          </div>
          <p v-if="data.stats.resource_memory?.budget_mb" class="text-xs tabular-nums text-text-muted">
            资源组预留内存 {{ data.stats.resource_memory.reserved_mb }} / {{ data.stats.resource_memory.budget_mb }} MiB
          </p>
        </div>

        <!-- 正在评测 -->
        <section class="overflow-x-auto rounded border border-border bg-bg-panel shadow-card">
          <h2 class="m-0 flex items-center gap-2 border-b border-border px-4 py-3 text-sm font-bold text-primary">
            <UIcon name="i-lucide-play" class="size-4" />
            正在评测（{{ data.judging.length }}）
          </h2>
          <div v-if="data.judging.length === 0" class="p-6 text-center text-xs text-text-muted">
            暂无正在评测的任务
          </div>
          <QueueRow v-for="item in data.judging" :key="item.id" :item="item" :now="now" show-elapsed />
        </section>

        <!-- 排队中 -->
        <section class="overflow-x-auto rounded border border-border bg-bg-panel shadow-card">
          <h2 class="m-0 flex items-center gap-2 border-b border-border px-4 py-3 text-sm font-bold text-text-secondary">
            <UIcon name="i-lucide-clock" class="size-4" />
            排队中（{{ data.pending.length }}）
          </h2>
          <div v-if="data.pending.length === 0" class="p-6 text-center text-xs text-text-muted">
            暂无排队中的任务
          </div>
          <QueueRow v-for="item in data.pending" :key="item.id" :item="item" :now="now" />
        </section>

        <!-- 最近完成 -->
        <section class="overflow-x-auto rounded border border-border bg-bg-panel shadow-card">
          <h2 class="m-0 flex items-center gap-2 border-b border-border px-4 py-3 text-sm font-bold text-success-text">
            <UIcon name="i-lucide-check-circle" class="size-4" />
            最近完成（{{ data.recently_completed.length }}）
          </h2>
          <div v-if="data.recently_completed.length === 0" class="p-6 text-center text-xs text-text-muted">
            暂无最近完成的任务
          </div>
          <QueueRow v-for="item in data.recently_completed" :key="item.id" :item="item" :now="now" show-score />
        </section>
      </div>
    </AsyncContent>
  </div>
</template>
