<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { educationCacheKey, formatTeachingTime, helpRequestTitle } from '~/utils/education';
import { extractApiError } from '~/utils/apiError';
import { workspacePath } from '~/utils/workspace';
import MarkdownEditor from '~/components/shared/MarkdownEditor.vue';

const props = defineProps<{
  slug: string;
  assignmentId: string;
  isStudent: boolean;
  canHelp: boolean;
  writable: boolean;
  items?: Array<{ id: string; displayRef: string; qualifiedRef?: string; title?: string | null }>;
  askItemId?: string | null;
  askSignal?: number;
}>();

const emit = defineEmits<{ 'pending-help': [count: number] }>();

const education = useEducationApi();
const capture = useWorkspaceActionScope();
const actor = useState<{ id: string } | null>('auth:user', () => null);

const page = ref(1);
const stateFilter = ref<'all' | 'open' | 'resolved'>('all');
const itemFilter = ref<string>('all');
const questionOpen = ref(false);
const question = ref('');
const questionItem = ref(props.askItemId ?? '');
const questionKey = ref(crypto.randomUUID());
const saving = ref(false);
const mutationError = ref('');

useUnsavedChanges(() => !!question.value.trim());

const readable = computed(() => props.isStudent || props.canHelp);
const base = computed(() => educationCacheKey(props.slug, actor.value?.id ?? null, props.assignmentId));

const help = await useAsyncData(
  () => `${base.value}:help-issues:${page.value}:${stateFilter.value}:${readable.value}`,
  () =>
    readable.value
      ? education.help(
        props.slug,
        props.assignmentId,
        page.value,
        stateFilter.value === 'all' ? undefined : stateFilter.value,
      )
      : Promise.resolve(null),
);

const allRequests = computed(() => help.data.value?.data.data ?? []);
const visibleRequests = computed(() => {
  if (itemFilter.value === 'all') return allRequests.value;
  if (itemFilter.value === '__none__') return allRequests.value.filter((item) => !item.item_id);
  return allRequests.value.filter((item) => item.item_id === itemFilter.value);
});
const helpTotal = computed(() => help.data.value?.data.total ?? 0);
const openCount = computed(() => allRequests.value.filter((item) => item.state === 'open').length);

watch([openCount, stateFilter, readable], ([count, filter, visible]) => {
  if (!visible) {
    emit('pending-help', 0);
    return;
  }
  if (filter === 'all' || filter === 'open') emit('pending-help', count);
}, { immediate: true });

watch([question, questionItem], () => {
  questionKey.value = crypto.randomUUID();
});

watch(() => props.askSignal, () => {
  questionItem.value = props.askItemId ?? '';
  questionOpen.value = true;
});

watch(stateFilter, () => {
  page.value = 1;
});

watch([() => props.slug, () => props.assignmentId, () => actor.value?.id], () => {
  page.value = 1;
  stateFilter.value = 'all';
  itemFilter.value = 'all';
  questionOpen.value = false;
  question.value = '';
  mutationError.value = '';
});

function itemLabel(itemId: string | null | undefined) {
  if (!itemId) return null;
  const item = props.items?.find((entry) => entry.id === itemId);
  if (!item) return '关联题目已移除';
  return item.title ? `${item.displayRef} · ${item.title}` : `题目 ${item.displayRef}`;
}

const itemFilterOptions = computed(() => [
  { label: '全部题目', value: 'all' },
  { label: '未关联题目', value: '__none__' },
  ...(props.items ?? []).map((item) => ({
    label: item.title ? `${item.displayRef} · ${item.title}` : `题目 ${item.displayRef}`,
    value: item.id,
  })),
]);

const questionItemOptions = computed(() => [
  { label: '不指定题目', value: '' },
  ...(props.items ?? []).map((item) => ({
    label: item.title ? `${item.displayRef} · ${item.title}` : `题目 ${item.displayRef}`,
    value: item.id,
  })),
]);

function statusMeta(request: { state: 'open' | 'resolved'; answered_by_coach?: boolean }) {
  if (request.state === 'resolved') {
    return {
      icon: 'i-lucide-circle-check-big',
      iconClass: 'text-signal-deep',
      label: '已处理',
      badgeColor: 'success' as const,
    };
  }
  if (request.answered_by_coach) {
    return {
      icon: 'i-lucide-message-square-check',
      iconClass: 'text-primary',
      label: '教练已回答',
      badgeColor: 'primary' as const,
    };
  }
  return {
    icon: 'i-lucide-circle-dot',
    iconClass: 'text-warning-text',
    label: '待回答',
    badgeColor: 'warning' as const,
  };
}

function detailHref(helpId: string) {
  return workspacePath(props.slug, `assignments/${props.assignmentId}/help/${helpId}`);
}

async function submitQuestion() {
  if (saving.value || !props.isStudent || !props.writable || !question.value.trim()) return;
  const scope = capture();
  saving.value = true;
  mutationError.value = '';
  try {
    const res = await education.ask(
      scope.slug,
      props.assignmentId,
      question.value,
      questionKey.value,
      questionItem.value || null,
    );
    if (!scope.isCurrent()) return;
    question.value = '';
    questionItem.value = '';
    questionOpen.value = false;
    const createdId = res?.data?.id;
    if (createdId) {
      await navigateTo(detailHref(createdId));
    } else {
      await help.refresh();
    }
  } catch (e) {
    if (scope.isCurrent()) mutationError.value = extractApiError(e).message;
  } finally {
    if (scope.isCurrent()) saving.value = false;
  }
}

defineExpose({ refresh: () => help.refresh() });
</script>

<template>
  <section
    :aria-label="isStudent ? '我的求助' : '学生求助'"
    class="overflow-hidden rounded-md border border-border bg-bg-panel"
  >
    <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-bg-sunken/50 px-4 py-3 sm:px-5">
      <div class="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="求助状态筛选" class="inline-flex rounded border border-border bg-bg-panel p-0.5 text-xs">
          <button
            v-for="opt in [
              { value: 'all', label: '全部' },
              { value: 'open', label: '待处理' },
              { value: 'resolved', label: '已处理' },
            ]"
            :key="opt.value"
            type="button"
            role="tab"
            :aria-selected="stateFilter === opt.value"
            class="rounded-sm px-2.5 py-1 transition-colors"
            :class="stateFilter === opt.value ? 'bg-primary font-medium text-white' : 'text-text-secondary hover:text-text'"
            @click="stateFilter = opt.value as 'all' | 'open' | 'resolved'"
          >
            {{ opt.label }}
          </button>
        </div>

        <USelect
          v-if="(items?.length ?? 0) > 0"
          v-model="itemFilter"
          size="xs"
          :items="itemFilterOptions"
          aria-label="按题目筛选求助"
          class="w-44 sm:w-52"
        />

        <span class="text-xs text-text-muted tabular-nums">
          共 {{ helpTotal }} 条<template v-if="stateFilter === 'all' && openCount"> · {{ openCount }} 条待处理</template>
        </span>
      </div>

      <UButton
        v-if="isStudent && writable"
        size="sm"
        :color="questionOpen ? 'neutral' : 'primary'"
        :variant="questionOpen ? 'outline' : 'solid'"
        :icon="questionOpen ? 'i-lucide-x' : 'i-lucide-plus'"
        @click="questionOpen = !questionOpen"
      >
        {{ questionOpen ? '收起提问' : '发起求助' }}
      </UButton>
    </div>

    <div v-if="mutationError || help.error.value" class="px-4 pt-3 sm:px-5 space-y-2">
      <UAlert v-if="mutationError" color="error" variant="subtle" :title="mutationError" />
      <UAlert v-if="help.error.value" color="error" variant="subtle" :title="extractApiError(help.error.value).message" />
    </div>

    <form
      v-if="questionOpen && isStudent && writable"
      class="border-b border-border bg-bg-sunken/30 px-4 py-4 space-y-3 sm:px-5"
      @submit.prevent="submitQuestion"
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="text-sm font-medium text-text">新建求助</p>
        <USelect
          v-if="(items?.length ?? 0) > 0"
          v-model="questionItem"
          size="sm"
          :items="questionItemOptions"
          aria-label="问题涉及的题目"
          class="w-full sm:w-64"
        />
      </div>
      <MarkdownEditor
        v-model="question"
        compact
        height="140px"
        :maxlength="30000"
        aria-label="求助正文"
        placeholder="第一行建议概括问题（将作为列表标题），下方可补充代码、报错或已尝试的方法（支持 Markdown）"
      />
      <div class="flex items-center justify-end gap-2">
        <UButton type="button" variant="ghost" color="neutral" size="sm" @click="questionOpen = false">取消</UButton>
        <UButton type="submit" size="sm" :loading="saving" :disabled="!question.trim()">提交求助</UButton>
      </div>
    </form>

    <div v-if="visibleRequests.length" class="divide-y divide-border">
      <NuxtLink
        v-for="request in visibleRequests"
        :key="request.id"
        :to="detailHref(request.id)"
        class="group flex items-start justify-between gap-4 px-4 py-3.5 transition-colors hover:bg-bg-sunken/50 sm:px-5"
      >
        <div class="flex min-w-0 items-start gap-3">
          <UIcon
            :name="statusMeta(request).icon"
            :aria-label="statusMeta(request).label"
            :title="statusMeta(request).label"
            class="mt-0.5 size-4.5 shrink-0"
            :class="statusMeta(request).iconClass"
          />
          <div class="min-w-0 space-y-1">
            <div class="flex flex-wrap items-center gap-2">
              <span class="break-words text-sm font-medium text-text group-hover:text-primary">
                {{ helpRequestTitle(request.body) }}
              </span>
              <UBadge :color="statusMeta(request).badgeColor" variant="subtle" size="xs">
                {{ statusMeta(request).label }}
              </UBadge>
              <UBadge v-if="itemLabel(request.item_id)" color="neutral" variant="outline" size="xs">
                {{ itemLabel(request.item_id) }}
              </UBadge>
            </div>
            <p class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-text-muted">
              <span v-if="request.author_name">{{ request.author_name }}</span>
              <span v-if="request.author_name && (request.updated_at || request.created_at)" aria-hidden="true">·</span>
              <span v-if="request.updated_at || request.created_at" class="tabular-nums">
                更新于 {{ formatTeachingTime(request.updated_at || request.created_at) }}
              </span>
              <span v-if="!request.item_id">· 未关联题目</span>
            </p>
          </div>
        </div>

        <div class="flex shrink-0 items-center gap-3 pt-0.5 text-xs text-text-muted">
          <span
            v-if="(request.reply_count ?? 0) > 0"
            class="inline-flex items-center gap-1 tabular-nums"
            :aria-label="`${request.reply_count} 条回复`"
          >
            <UIcon name="i-lucide-message-square" class="size-3.5" aria-hidden="true" />
            {{ request.reply_count }}
          </span>
          <UIcon
            name="i-lucide-chevron-right"
            class="size-4 text-text-muted/60 transition-transform group-hover:translate-x-0.5 group-hover:text-primary"
            aria-hidden="true"
          />
        </div>
      </NuxtLink>
    </div>

    <div v-else-if="help.data.value" class="flex flex-col items-center px-4 py-12 text-center">
      <UIcon name="i-lucide-message-circle-question" class="size-8 text-text-muted" aria-hidden="true" />
      <p class="mt-3 text-sm font-medium text-text">暂无符合条件的求助记录</p>
      <p class="mt-1 text-xs text-text-muted">
        {{ isStudent && writable ? '做题遇到卡点时，可以点击右上角「发起求助」与教练交流。' : '当前筛选范围内没有学生求助。' }}
      </p>
    </div>

    <div v-if="helpTotal > 50" class="flex items-center justify-between gap-2 border-t border-border px-4 py-3 sm:px-5">
      <UButton :disabled="page <= 1" variant="outline" color="neutral" size="sm" icon="i-lucide-chevron-left" @click="page--">
        上一页
      </UButton>
      <span class="text-xs text-text-muted tabular-nums">第 {{ page }} 页</span>
      <UButton
        :disabled="page * 50 >= helpTotal"
        variant="outline"
        color="neutral"
        size="sm"
        trailing-icon="i-lucide-chevron-right"
        @click="page++"
      >
        下一页
      </UButton>
    </div>
  </section>
</template>
