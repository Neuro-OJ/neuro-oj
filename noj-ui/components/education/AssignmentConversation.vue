<script setup lang="ts">
import { educationCacheKey } from '~/utils/education';
import { extractApiError } from '~/utils/apiError';
import { workspaceProblemPath } from '~/utils/workspace';
const props = defineProps<
  {
    slug: string;
    assignmentId: string;
    isStudent: boolean;
    canFeedback: boolean;
    canHelp: boolean;
    writable: boolean;
    targetUserId?: string | null;
    targetUserName?: string;
    helpId?: string;
    feedbackId?: string;
    feedbackSignal?: number;
    items?: Array<{ id: string; displayRef: string; qualifiedRef?: string; title?: string | null }>;
    askItemId?: string | null;
    askSignal?: number;
  }
>();
const emit = defineEmits<{ 'pending-help': [count: number]; 'clear-target': [] }>();
const education = useEducationApi(), capture = useWorkspaceActionScope();
const actor = useState<{ id: string } | null>('auth:user', () => null);
const feedbackPage = ref(1), helpPage = ref(1);
const expandedHelp = ref<Set<string>>(new Set(props.helpId ? [props.helpId] : []));
const feedbackBody = ref(''), question = ref(''), saving = ref(false);
const questionItem = ref(props.askItemId ?? '');
const feedbackOpen = ref(false), questionOpen = ref(false);
useUnsavedChanges(() => !!(feedbackBody.value.trim() || question.value.trim()));
const feedbackKey = ref(crypto.randomUUID()),
  questionKey = ref(crypto.randomUUID());
const base = computed(() => educationCacheKey(props.slug, actor.value?.id ?? null, props.assignmentId));
const feedback = await useViewAsyncData(
  'feedback',
  () => `${base.value}:feedback:${feedbackPage.value}:${props.isStudent}:${props.canFeedback}`,
  () =>
    props.isStudent || props.canFeedback
      ? education.feedback(props.slug, props.assignmentId, feedbackPage.value)
      : Promise.resolve(null),
);
const help = await useViewAsyncData(
  'help',
  () => `${base.value}:help:${helpPage.value}:${props.isStudent}:${props.canHelp}`,
  () =>
    props.isStudent || props.canHelp
      ? education.help(props.slug, props.assignmentId, helpPage.value)
      : Promise.resolve(null),
);
const focusedFeedback = await useViewAsyncData(
  'focusedFeedback',
  () => `${base.value}:feedback-detail:${props.feedbackId ?? ''}:${props.isStudent}:${props.canFeedback}`,
  () =>
    props.feedbackId && (props.isStudent || props.canFeedback)
      ? education.feedbackDetail(props.slug, props.assignmentId, props.feedbackId)
      : Promise.resolve(null),
);
const feedbackTotal = computed(() => feedback.data.value?.data.total ?? 0);
const helpTotal = computed(() => help.data.value?.data.total ?? 0);
const pendingHelp = computed(() => (help.data.value?.data.data ?? []).filter((request) => request.state === 'open').length);
const showFeedback = computed(() => props.isStudent || props.canFeedback);
const showHelp = computed(() => props.isStudent || props.canHelp);
const singlePane = computed(() => !(showFeedback.value && showHelp.value));
const conversationTitle = computed(() => {
  if (!singlePane.value) return '作业互动';
  return showFeedback.value ? (props.isStudent ? '收到的反馈' : '作业反馈') : (props.isStudent ? '我的求助' : '学生求助');
});
const conversationMeta = computed(() => {
  const parts: string[] = [];
  if (showFeedback.value) parts.push(`${feedbackTotal.value} 条反馈`);
  if (showHelp.value) parts.push(pendingHelp.value ? `${pendingHelp.value} 条待处理求助` : `${helpTotal.value} 条求助`);
  return parts.join(' · ');
});
function helpItem(itemId: string | null | undefined) {
  return itemId ? props.items?.find((entry) => entry.id === itemId) : undefined;
}
function helpItemLabel(itemId: string | null | undefined) {
  const item = helpItem(itemId);
  if (!itemId) return '未关联题目';
  if (!item) return '关联题目已移除';
  return item.title ? `${item.displayRef} · ${item.title}` : `题目 ${item.displayRef}`;
}
/** 教练点击求助关联的题目时直接打开当前域的题目页。 */
function helpItemPath(itemId: string | null | undefined) {
  const item = helpItem(itemId);
  return item?.qualifiedRef ? workspaceProblemPath(props.slug, item.qualifiedRef) : null;
}
const questionItemOptions = computed(() => [
  { label: '不指定题目', value: '' },
  ...(props.items ?? []).map((item) => ({
    label: item.title ? `${item.displayRef} · ${item.title}` : `题目 ${item.displayRef}`,
    value: item.id,
  })),
]);
watch(pendingHelp, (count) => emit('pending-help', showHelp.value ? count : 0), { immediate: true });
watch(showHelp, (visible) => emit('pending-help', visible ? pendingHelp.value : 0));
watch(() => props.helpId, (id) => {
  if (!id) return;
  expandedHelp.value = new Set([...expandedHelp.value, id]);
});
watch(() => props.feedbackSignal, () => {
  feedbackOpen.value = true;
});
watch(feedbackBody, () => {
  feedbackKey.value = crypto.randomUUID();
});
watch(() => props.targetUserId, (id, previous) => {
  feedbackKey.value = crypto.randomUUID();
  if (id && previous && id !== previous) feedbackBody.value = '';
});
watch([question, questionItem], () => {
  questionKey.value = crypto.randomUUID();
});
watch(() => props.askSignal, () => {
  questionItem.value = props.askItemId ?? '';
  questionOpen.value = true;
});
watch([() => props.slug, () => props.assignmentId, () => actor.value?.id], () => {
  expandedHelp.value = new Set();
  feedbackBody.value = '';
  question.value = '';
  questionItem.value = '';
  feedbackOpen.value = false;
  questionOpen.value = false;
  feedbackPage.value = helpPage.value = 1;
});
function cancelFeedback() {
  feedbackOpen.value = false;
  feedbackBody.value = '';
}
function cancelQuestion() {
  questionOpen.value = false;
  question.value = '';
  questionItem.value = '';
}
async function act(kind: 'feedback' | 'question') {
  if (saving.value || !props.writable) return;
  const scope = capture(), id = props.assignmentId;
  saving.value = true;
  try {
    if (kind === 'feedback') {
      await education.addFeedback(scope.slug, id, feedbackBody.value, props.targetUserId ?? null, feedbackKey.value);
    }
    if (kind === 'question') {
      await education.ask(scope.slug, id, question.value, questionKey.value, questionItem.value || null);
    }
    if (!scope.isCurrent() || props.assignmentId !== id) return;
    if (kind === 'feedback') {
      feedbackBody.value = '';
      feedbackOpen.value = false;
      emit('clear-target');
      await feedback.refresh();
    }
    if (kind === 'question') {
      question.value = '';
      questionItem.value = '';
      questionOpen.value = false;
      await help.refresh();
    }
  } finally {
    saving.value = false;
  }
}
function isExpanded(helpId: string) {
  return expandedHelp.value.has(helpId);
}
function toggleHelp(helpId: string) {
  const next = new Set(expandedHelp.value);
  if (next.has(helpId)) next.delete(helpId);
  else next.add(helpId);
  expandedHelp.value = next;
}
function collapseHelp(helpId: string) {
  const next = new Set(expandedHelp.value);
  next.delete(helpId);
  expandedHelp.value = next;
}
async function refreshThreads() {
  await help.refresh();
}
</script>
<template>
  <div class="overflow-hidden rounded-md border border-border bg-bg-panel">
    <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
      <div class="min-w-0">
        <h2 class="font-semibold">{{ conversationTitle }}</h2>
        <p class="mt-0.5 text-xs text-text-muted tabular-nums">{{ conversationMeta }}</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <UButton v-if="canFeedback && writable && !feedbackOpen" size="sm" variant="outline"
          icon="i-lucide-pen-line" @click="feedbackOpen = true">
          写反馈
        </UButton>
        <UButton v-if="isStudent && writable && !questionOpen" size="sm" variant="outline"
          icon="i-lucide-message-circle-question-mark" @click="questionOpen = true">
          向老师求助
        </UButton>
      </div>
    </div>

    <div class="grid divide-y divide-border"
      :class="showFeedback && showHelp ? 'lg:grid-cols-2 lg:divide-x lg:divide-y-0' : ''">
      <section v-if="showFeedback" class="min-w-0 p-4 sm:p-5" :aria-label="isStudent ? '收到的反馈' : '作业反馈'">
        <div v-if="showFeedback && showHelp" class="mb-3 flex items-center justify-between gap-2">
          <h3 class="text-sm font-semibold">{{ isStudent ? '收到的反馈' : '作业反馈' }}</h3>
          <span class="text-xs text-text-muted tabular-nums">{{ feedbackTotal }} 条</span>
        </div>

        <div v-if="targetUserId && canFeedback"
          class="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded bg-primary-bg px-3 py-2 text-sm">
          <UIcon name="i-lucide-user-round" class="size-4 text-primary" aria-hidden="true" />
          <span>反馈给 <strong class="font-medium">{{ targetUserName ?? targetUserId }}</strong></span>
          <button type="button" class="text-primary-dark hover:underline" @click="emit('clear-target')">改为全班</button>
        </div>

        <UAlert v-if="focusedFeedback.error.value" class="mb-3" color="error"
          :title="extractApiError(focusedFeedback.error.value).message" />
        <article v-if="feedbackId && focusedFeedback.data.value?.data.id === feedbackId"
          class="mb-3 rounded bg-primary-bg px-3 py-2.5">
          <p class="text-xs text-text-muted">{{ focusedFeedback.data.value!.data.author_name }} · 本次通知的反馈</p>
          <p class="mt-1 whitespace-pre-wrap text-sm">{{ focusedFeedback.data.value!.data.body }}</p>
        </article>

        <form v-if="feedbackOpen && canFeedback && writable"
          class="mb-3 rounded bg-bg-sunken/60 p-3" @submit.prevent="act('feedback')">
          <p v-if="!targetUserId" class="text-sm font-medium">反馈对象：本作业全体目标学生</p>
          <UTextarea v-model="feedbackBody" class="mt-2 w-full" :rows="3" :maxlength="30000"
            aria-label="作业反馈正文" placeholder="写下具体、可执行的下一步建议" />
          <div class="mt-2 flex items-center justify-end gap-2">
            <UButton type="button" variant="ghost" color="neutral" size="sm" @click="cancelFeedback">
              取消并清空</UButton>
            <UButton type="submit" size="sm" :loading="saving" :disabled="!feedbackBody.trim()">发送反馈</UButton>
          </div>
        </form>

        <UAlert v-if="feedback.error.value" class="mb-3" color="error"
          :title="extractApiError(feedback.error.value).message" />
        <div v-if="feedback.data.value?.data.data.length" class="divide-y divide-border">
          <article v-for="note in feedback.data.value.data.data" :key="note.id" class="py-3 first:pt-0 last:pb-0">
            <p class="flex flex-wrap items-center gap-x-1.5 text-xs text-text-muted">
              <span class="font-medium text-text-secondary">{{ note.author_name }}</span>
              <span aria-hidden="true">·</span>
              <span>{{ note.target_user_id ? `给 ${note.target_name ?? note.target_user_id}` : '给全体目标学生' }}</span>
            </p>
            <p class="mt-1 whitespace-pre-wrap text-sm text-text">{{ note.body }}</p>
          </article>
        </div>
        <p v-else-if="feedback.data.value"
          class="rounded bg-bg-sunken/50 px-3 py-6 text-center text-sm text-text-muted">暂无反馈</p>
        <div v-if="feedbackTotal > 50" class="mt-3 flex items-center justify-between gap-2">
          <UButton :disabled="feedbackPage <= 1" variant="ghost" color="neutral" size="sm"
            icon="i-lucide-chevron-left" aria-label="上一页反馈" @click="feedbackPage--" />
          <span class="text-xs text-text-muted tabular-nums">{{ feedbackPage }}</span>
          <UButton :disabled="feedbackPage * 50 >= feedbackTotal" variant="ghost" color="neutral" size="sm"
            trailing-icon="i-lucide-chevron-right" aria-label="下一页反馈" @click="feedbackPage++" />
        </div>
      </section>

      <section v-if="showHelp" class="min-w-0 p-4 sm:p-5" :aria-label="isStudent ? '我的求助' : '学生求助'">
        <div v-if="showFeedback && showHelp" class="mb-3 flex items-center justify-between gap-2">
          <h3 class="text-sm font-semibold">{{ isStudent ? '我的求助' : '学生求助' }}</h3>
          <span class="text-xs text-text-muted tabular-nums">
            {{ helpTotal }} 条<template v-if="pendingHelp"> · {{ pendingHelp }} 待处理</template>
          </span>
        </div>

        <form v-if="questionOpen && isStudent && writable"
          class="mb-3 rounded bg-bg-sunken/60 p-3" @submit.prevent="act('question')">
          <p class="text-sm font-medium">描述已经尝试的方法和遇到的问题</p>
          <UTextarea v-model="question" class="mt-2 w-full" :rows="3" :maxlength="30000" aria-label="求助正文"
            placeholder="例如：我已经检查了边界，但第三个测试点仍然不通过" />
          <label v-if="(items?.length ?? 0) > 1" class="mt-2 flex flex-col gap-1">
            <span class="text-xs font-semibold text-text-secondary">问题涉及题目（可选）</span>
            <USelect v-model="questionItem" size="sm" :items="questionItemOptions" class="w-full"
              aria-label="问题涉及的题目" />
          </label>
          <div class="mt-2 flex items-center justify-end gap-2">
            <UButton type="button" variant="ghost" color="neutral" size="sm" @click="cancelQuestion">取消</UButton>
            <UButton type="submit" size="sm" :loading="saving" :disabled="!question.trim()">发送求助</UButton>
          </div>
        </form>

        <UAlert v-if="help.error.value" class="mb-3" color="error"
          :title="extractApiError(help.error.value).message" />
        <div v-if="help.data.value?.data.data.length" class="divide-y divide-border">
          <div v-for="request in help.data.value.data.data" :key="request.id" class="py-3 last:pb-0">
            <button type="button"
              class="flex w-full items-start justify-between gap-3 text-left transition-colors hover:text-primary"
              :title="request.body" :aria-expanded="isExpanded(request.id)"
              :aria-controls="`help-detail-${request.id}`"
              @click="toggleHelp(request.id)">
              <span class="min-w-0">
                <span class="block break-words text-sm text-text"
                  :class="isExpanded(request.id) ? '' : 'line-clamp-2'">{{ request.body }}</span>
              </span>
              <UIcon :name="isExpanded(request.id) ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
                class="mt-0.5 size-4 shrink-0 text-text-muted" aria-hidden="true" />
            </button>
            <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
              <template v-if="!isStudent && helpItemPath(request.item_id)">
                <NuxtLink :to="helpItemPath(request.item_id)!" title="打开题目页"
                  class="inline-flex items-center gap-1 text-primary-dark hover:underline">
                  <UIcon name="i-lucide-book-open-text" class="size-3.5" aria-hidden="true" />
                  {{ helpItemLabel(request.item_id) }}
                </NuxtLink>
              </template>
              <span v-else class="inline-flex items-center gap-1 text-text-secondary">
                <UIcon name="i-lucide-book-open-text" class="size-3.5" aria-hidden="true" />
                {{ helpItemLabel(request.item_id) }}
              </span>
              <span aria-hidden="true">·</span>
              <span class="inline-flex items-center gap-1.5">
                <span class="size-1.5 rounded-full" aria-hidden="true"
                  :class="request.state === 'resolved' ? 'bg-signal' : 'bg-warning'" />
                {{ request.state === 'resolved' ? '已处理' : '待处理' }}
              </span>
            </div>
            <div v-if="isExpanded(request.id)" :id="`help-detail-${request.id}`"
              class="mt-3 border-t border-border pt-3">
              <AssignmentHelpThread :slug="slug" :assignment-id="assignmentId" :help-id="request.id"
                :can-help="canHelp" :writable="writable" @changed="refreshThreads"
                @close="collapseHelp(request.id)" />
            </div>
          </div>
        </div>
        <p v-else-if="help.data.value" class="rounded bg-bg-sunken/50 px-3 py-6 text-center text-sm text-text-muted">
          暂无求助
        </p>
        <div v-if="helpTotal > 50" class="mt-3 flex items-center justify-between gap-2">
          <UButton :disabled="helpPage <= 1" variant="ghost" color="neutral" size="sm"
            icon="i-lucide-chevron-left" aria-label="上一页求助" @click="helpPage--" />
          <span class="text-xs text-text-muted tabular-nums">{{ helpPage }}</span>
          <UButton :disabled="helpPage * 50 >= helpTotal" variant="ghost" color="neutral" size="sm"
            trailing-icon="i-lucide-chevron-right" aria-label="下一页求助" @click="helpPage++" />
        </div>

      </section>
    </div>
  </div>
</template>
