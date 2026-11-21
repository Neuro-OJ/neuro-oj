<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { educationCacheKey, formatTeachingTime } from '~/utils/education';
import type { AssignmentFeedback } from '~/utils/education';
import { extractApiError } from '~/utils/apiError';
import MarkdownEditor from '~/components/shared/MarkdownEditor.vue';
import MarkdownRenderer from '~/components/shared/MarkdownRenderer.vue';

const props = defineProps<{
  slug: string;
  assignmentId: string;
  isStudent: boolean;
  canWrite: boolean;
  managesDomain?: boolean;
  writable: boolean;
  focusedFeedbackId?: string;
}>();

const education = useEducationApi();
const capture = useWorkspaceActionScope();
const { dialog } = useDialog();
const actor = useState<{ id: string } | null>('auth:user', () => null);

const page = ref(1);
const composeOpen = ref(false);
const composeBody = ref('');
const composeKey = ref(crypto.randomUUID());
const editingId = ref<string | null>(null);
const editBody = ref('');
const expandedAll = ref(false);
const saving = ref(false);
const mutationError = ref('');

useUnsavedChanges(() => !!(composeBody.value.trim() || (editingId.value && editBody.value.trim())));

const base = computed(() => educationCacheKey(props.slug, actor.value?.id ?? null, props.assignmentId));
const readable = computed(() => props.isStudent || props.canWrite);

const list = await useAsyncData(
  () => `${base.value}:notices:${page.value}:${readable.value}`,
  () => readable.value ? education.feedback(props.slug, props.assignmentId, page.value) : Promise.resolve(null),
);

const focused = await useAsyncData(
  () => `${base.value}:notice-detail:${props.focusedFeedbackId ?? ''}:${readable.value}`,
  () =>
    props.focusedFeedbackId && readable.value
      ? education.feedbackDetail(props.slug, props.assignmentId, props.focusedFeedbackId)
      : Promise.resolve(null),
);

// 仅保留面向全体学生的作业通知（target_user_id === null），按最新优先排列
const notices = computed(() => {
  const rows = (list.data.value?.data.data ?? []).filter((item) => item.target_user_id === null);
  return [...rows].reverse();
});

const focusedNotice = computed(() => {
  const item = focused.data.value?.data;
  if (!item || item.id !== props.focusedFeedbackId || item.target_user_id !== null) return null;
  return notices.value.some((n) => n.id === item.id) ? null : item;
});

const collapsedCount = 2;
const visibleNotices = computed(() =>
  expandedAll.value || notices.value.length <= collapsedCount ? notices.value : notices.value.slice(0, collapsedCount)
);

const hasHiddenNotices = computed(() => notices.value.length > collapsedCount && !expandedAll.value);
const showSection = computed(() =>
  Boolean(
    list.error.value ||
      focused.error.value ||
      focusedNotice.value ||
      notices.value.length > 0 ||
      (props.canWrite && props.writable) ||
      composeOpen.value,
  )
);

watch(composeBody, () => {
  composeKey.value = crypto.randomUUID();
});

watch(() => props.focusedFeedbackId, (id) => {
  if (!id) return;
  const idx = notices.value.findIndex((item) => item.id === id);
  if (idx >= collapsedCount) expandedAll.value = true;
}, { immediate: true });

watch([() => props.slug, () => props.assignmentId, () => actor.value?.id], () => {
  composeOpen.value = false;
  composeBody.value = '';
  editingId.value = null;
  editBody.value = '';
  mutationError.value = '';
  expandedAll.value = false;
  page.value = 1;
});

function canEditNotice(note: AssignmentFeedback) {
  return props.canWrite && props.writable && note.author_id === actor.value?.id;
}

function canWithdrawNotice(note: AssignmentFeedback) {
  return props.canWrite && props.writable && (note.author_id === actor.value?.id || props.managesDomain === true);
}

function startEdit(note: AssignmentFeedback) {
  editingId.value = note.id;
  editBody.value = note.body;
  mutationError.value = '';
}

function cancelCompose() {
  composeBody.value = '';
  composeOpen.value = false;
  mutationError.value = '';
}

async function publish() {
  if (saving.value || !props.canWrite || !props.writable || !composeBody.value.trim()) return;
  const scope = capture();
  saving.value = true;
  mutationError.value = '';
  try {
    await education.addFeedback(scope.slug, props.assignmentId, composeBody.value, null, composeKey.value);
    if (!scope.isCurrent()) return;
    composeBody.value = '';
    composeOpen.value = false;
    await list.refresh();
  } catch (e) {
    if (scope.isCurrent()) mutationError.value = extractApiError(e).message;
  } finally {
    if (scope.isCurrent()) saving.value = false;
  }
}

async function saveEdit(note: AssignmentFeedback) {
  if (saving.value || !canEditNotice(note) || !editBody.value.trim()) return;
  const scope = capture();
  saving.value = true;
  mutationError.value = '';
  try {
    await education.updateFeedback(scope.slug, props.assignmentId, note.id, note.revision, { body: editBody.value });
    if (!scope.isCurrent()) return;
    editingId.value = null;
    editBody.value = '';
    await Promise.all([list.refresh(), props.focusedFeedbackId === note.id ? focused.refresh() : Promise.resolve()]);
  } catch (e) {
    if (scope.isCurrent()) mutationError.value = extractApiError(e).message;
  } finally {
    if (scope.isCurrent()) saving.value = false;
  }
}

async function withdrawNotice(note: AssignmentFeedback) {
  if (saving.value || !canWithdrawNotice(note)) return;
  if (!await dialog.confirm('撤回这条作业全体通知？学生将不再在通知栏看到它。')) return;
  const scope = capture();
  saving.value = true;
  mutationError.value = '';
  try {
    await education.updateFeedback(scope.slug, props.assignmentId, note.id, note.revision, { withdraw: true });
    if (!scope.isCurrent()) return;
    if (editingId.value === note.id) {
      editingId.value = null;
      editBody.value = '';
    }
    await list.refresh();
  } catch (e) {
    if (scope.isCurrent()) mutationError.value = extractApiError(e).message;
  } finally {
    if (scope.isCurrent()) saving.value = false;
  }
}
</script>

<template>
  <section
    v-if="showSection"
    aria-label="作业全体通知"
    class="rounded-md border border-border bg-bg-panel"
  >
    <div class="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5 sm:px-5">
      <div class="flex items-center gap-2">
        <UIcon name="i-lucide-megaphone" class="size-4 text-primary" aria-hidden="true" />
        <h2 class="text-sm font-semibold text-text">作业全体通知</h2>
        <span v-if="notices.length" class="text-xs text-text-muted tabular-nums">{{ notices.length }} 条</span>
      </div>
      <div class="flex items-center gap-2">
        <UButton
          v-if="hasHiddenNotices"
          size="xs"
          variant="ghost"
          color="neutral"
          @click="expandedAll = true"
        >
          展开全部 {{ notices.length }} 条
        </UButton>
        <UButton
          v-else-if="expandedAll && notices.length > collapsedCount"
          size="xs"
          variant="ghost"
          color="neutral"
          @click="expandedAll = false"
        >
          收起部分通知
        </UButton>
        <UButton
          v-if="canWrite && writable"
          size="xs"
          :variant="composeOpen ? 'ghost' : 'outline'"
          :color="composeOpen ? 'neutral' : 'primary'"
          :icon="composeOpen ? 'i-lucide-x' : 'i-lucide-plus'"
          @click="composeOpen ? cancelCompose() : (composeOpen = true)"
        >
          {{ composeOpen ? '收起编辑' : '发布通知' }}
        </UButton>
      </div>
    </div>

    <div class="space-y-3 px-4 py-3 sm:px-5">
      <UAlert v-if="mutationError" color="error" variant="subtle" :title="mutationError" />
      <UAlert v-if="list.error.value" color="error" variant="subtle" :title="extractApiError(list.error.value).message" />
      <UAlert v-if="focused.error.value" color="error" variant="subtle" :title="extractApiError(focused.error.value).message" />

      <form v-if="composeOpen && canWrite && writable" class="rounded bg-bg-sunken/60 p-3 space-y-2.5" @submit.prevent="publish">
        <MarkdownEditor
          v-model="composeBody"
          compact
          height="130px"
          :maxlength="30000"
          aria-label="作业全体通知正文"
          placeholder="输入面向全班同学的作业提醒、样例说明或补充要求（支持 Markdown 与公式）"
        />
        <div class="flex items-center justify-end gap-2">
          <UButton type="button" variant="ghost" color="neutral" size="sm" @click="cancelCompose">取消</UButton>
          <UButton type="submit" size="sm" :loading="saving" :disabled="!composeBody.trim()">发布全体通知</UButton>
        </div>
      </form>

      <article
        v-if="focusedNotice"
        class="rounded border border-primary/30 bg-primary-bg/50 px-3.5 py-2.5"
      >
        <p class="flex flex-wrap items-center gap-x-2 text-xs text-text-muted">
          <span class="font-medium text-text">{{ focusedNotice.author_name }}</span>
          <span>·</span>
          <span>{{ formatTeachingTime(focusedNotice.created_at) }}</span>
          <UBadge color="primary" variant="subtle" size="xs">定位通知</UBadge>
        </p>
        <div class="mt-1.5 text-sm text-text [&_p:first-child]:mt-0 [&_p:last-child]:mb-0">
          <MarkdownRenderer :content="focusedNotice.body" />
        </div>
      </article>

      <div v-if="visibleNotices.length" class="divide-y divide-border">
        <article
          v-for="note in visibleNotices"
          :key="note.id"
          class="py-3 first:pt-0 last:pb-0"
          :class="focusedFeedbackId === note.id ? 'rounded bg-primary-bg/40 px-2.5 py-2.5' : ''"
        >
          <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted">
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span class="font-medium text-text-secondary">{{ note.author_name }}</span>
              <span aria-hidden="true">·</span>
              <span class="tabular-nums">{{ formatTeachingTime(note.updated_at || note.created_at) }}</span>
              <span v-if="note.revision > 0" class="text-[11px] text-text-muted">（已编辑）</span>
            </div>
            <div v-if="(canEditNotice(note) || canWithdrawNotice(note)) && editingId !== note.id" class="flex items-center gap-1">
              <UButton v-if="canEditNotice(note)" size="xs" variant="ghost" color="neutral" :disabled="saving" @click="startEdit(note)">
                编辑
              </UButton>
              <UButton v-if="canWithdrawNotice(note)" size="xs" variant="ghost" color="error" :disabled="saving" @click="withdrawNotice(note)">
                撤回
              </UButton>
            </div>
          </div>

          <form v-if="editingId === note.id" class="mt-2 space-y-2" @submit.prevent="saveEdit(note)">
            <MarkdownEditor
              v-model="editBody"
              compact
              height="120px"
              :maxlength="30000"
              aria-label="编辑作业全体通知正文"
            />
            <div class="flex items-center justify-end gap-2">
              <UButton type="button" size="xs" variant="ghost" color="neutral" :disabled="saving" @click="editingId = null">
                取消
              </UButton>
              <UButton type="submit" size="xs" :loading="saving" :disabled="!editBody.trim()">保存修改</UButton>
            </div>
          </form>

          <div v-else class="mt-1.5 text-sm text-text [&_p:first-child]:mt-0 [&_p:last-child]:mb-0">
            <MarkdownRenderer :content="note.body" />
          </div>
        </article>
      </div>

      <p v-else-if="!composeOpen && !focusedNotice && !list.error.value" class="text-xs text-text-muted">
        暂无作业全体通知，需要补充作业说明或共性提醒时可点击右上角「发布通知」。
      </p>
    </div>
  </section>
</template>
