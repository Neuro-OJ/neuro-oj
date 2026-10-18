<script setup lang="ts">
import { educationCacheKey } from '~/utils/education';
import { extractApiError } from '~/utils/apiError';
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
  }
>();
const education = useEducationApi(), capture = useWorkspaceActionScope();
const actor = useState<{ id: string } | null>('auth:user', () => null);
const feedbackPage = ref(1), helpPage = ref(1), replyPage = ref(1), selectedHelp = ref(props.helpId ?? '');
const feedbackBody = ref(''), question = ref(''), replyBody = ref(''), saving = ref(false);
useUnsavedChanges(() => !!(feedbackBody.value.trim() || question.value.trim() || replyBody.value.trim()));
const feedbackKey = ref(crypto.randomUUID()),
  questionKey = ref(crypto.randomUUID()),
  replyKey = ref(crypto.randomUUID());
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
const detail = await useViewAsyncData(
  'helpDetail',
  () => `${base.value}:help-detail:${selectedHelp.value}:${replyPage.value}`,
  () =>
    selectedHelp.value
      ? education.helpDetail(props.slug, props.assignmentId, selectedHelp.value, replyPage.value)
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
watch(() => props.helpId, (id) => {
  selectedHelp.value = id ?? '';
});
watch([feedbackBody, () => props.targetUserId], () => {
  feedbackKey.value = crypto.randomUUID();
});
watch(question, () => {
  questionKey.value = crypto.randomUUID();
});
watch(replyBody, () => {
  replyKey.value = crypto.randomUUID();
});
watch([() => props.slug, () => props.assignmentId, () => actor.value?.id], () => {
  selectedHelp.value = '';
  feedbackBody.value = '';
  question.value = '';
  replyBody.value = '';
  feedbackPage.value = helpPage.value = replyPage.value = 1;
});
watch(selectedHelp, () => {
  replyPage.value = 1;
  replyBody.value = '';
});
async function act(kind: 'feedback' | 'question' | 'reply' | 'resolve') {
  if (saving.value || !props.writable) return;
  const scope = capture(), id = props.assignmentId, helpId = selectedHelp.value;
  saving.value = true;
  try {
    if (kind === 'feedback') {
      await education.addFeedback(scope.slug, id, feedbackBody.value, props.targetUserId ?? null, feedbackKey.value);
    }
    if (kind === 'question') await education.ask(scope.slug, id, question.value, questionKey.value);
    if (kind === 'reply') await education.reply(scope.slug, id, helpId, replyBody.value, replyKey.value);
    if (kind === 'resolve' && detail.data.value) {
      await education.resolve(scope.slug, id, helpId, detail.data.value.data.revision);
    }
    if (!scope.isCurrent() || props.assignmentId !== id) return;
    if (kind === 'feedback') {
      feedbackBody.value = '';
      await feedback.refresh();
    }
    if (kind === 'question') {
      question.value = '';
      await help.refresh();
    }
    if (selectedHelp.value === helpId && (kind === 'reply' || kind === 'resolve')) {
      replyBody.value = '';
      await Promise.all([detail.refresh(), help.refresh()]);
    }
  } finally {
    saving.value = false;
  }
}
</script>
<template>
  <div class="grid gap-5 lg:grid-cols-2">
    <UCard v-if="isStudent || canFeedback">
      <h2 class="mb-4 font-semibold">作业反馈</h2>
      <UAlert v-if="focusedFeedback.error.value" class="mb-3" color="error"
        :title="extractApiError(focusedFeedback.error.value).message" />
      <article v-if="feedbackId && focusedFeedback.data.value?.data.id === feedbackId"
        class="mb-4 rounded border border-primary p-3">
        <p class="mb-2 text-xs text-text-muted">{{ focusedFeedback.data.value!.data.author_name }} · 本次通知的反馈</p>
        <p class="whitespace-pre-wrap text-sm">{{ focusedFeedback.data.value!.data.body }}</p>
      </article>
      <UAlert v-if="feedback.error.value" color="error" :title="extractApiError(feedback.error.value).message" />
      <article v-for="note in feedback.data.value?.data.data" :key="note.id" class="mb-3 border-b border-border pb-3">
        <p
          class="mb-2 text-xs text-text-muted">{{ note.author_name }} · {{ note.target_user_id ? `给 ${note.target_name ?? note.target_user_id}` : '给全体目标学生' }}</p>
        <p class="whitespace-pre-wrap text-sm">{{ note.body }}</p>
      </article>
      <p v-if="feedback.status.value === 'success' && !feedback.data.value?.data.total"
        class="text-sm text-text-muted">暂无反馈</p>
      <div v-if="(feedback.data.value?.data.total ?? 0) > 50" class="mt-3 flex gap-2">
        <UButton :disabled="feedbackPage <= 1" variant="ghost" @click="feedbackPage--">上一页</UButton>
        <UButton :disabled="feedbackPage * 50 >= (feedback.data.value?.data.total ?? 0)" variant="ghost"
          @click="feedbackPage++">下一页</UButton>
      </div>
      <form v-if="canFeedback && writable" class="mt-4 space-y-3" @submit.prevent="act('feedback')">
        <p
          class="text-sm font-medium">{{ targetUserId ? `反馈对象：${targetUserName ?? targetUserId}` : '反馈对象：本作业全体目标学生' }}</p>
        <UTextarea v-model="feedbackBody" class="w-full" :maxlength="30000" aria-label="作业反馈正文"
          placeholder="留下具体、可操作的反馈" />
        <UButton type="submit" :loading="saving" :disabled="!feedbackBody.trim()">发送反馈</UButton>
      </form>
    </UCard>
    <UCard v-if="isStudent || canHelp">
      <h2 class="mb-4 font-semibold">{{ isStudent ? '我的求助' : '学生求助' }}</h2>
      <UAlert v-if="help.error.value" color="error" :title="extractApiError(help.error.value).message" />
      <UButton v-for="request in help.data.value?.data.data" :key="request.id" class="mb-2 w-full justify-start"
        color="neutral" variant="outline" @click="selectedHelp = request.id">
        <span class="min-w-0 flex-1 truncate">{{ request.body }}</span><UBadge class="shrink-0 whitespace-nowrap" :color="request.state === 'resolved' ? 'success' : 'warning'" variant="subtle">{{ request.state === 'resolved' ? '已处理' : '待处理' }}</UBadge>
      </UButton>
      <div v-if="(help.data.value?.data.total ?? 0) > 50" class="mt-3 flex gap-2">
        <UButton :disabled="helpPage <= 1" variant="ghost" @click="helpPage--">上一页</UButton>
        <UButton :disabled="helpPage * 50 >= (help.data.value?.data.total ?? 0)" variant="ghost"
          @click="helpPage++">下一页</UButton>
      </div>
      <form v-if="isStudent && writable" class="mt-4 space-y-3" @submit.prevent="act('question')">
        <UTextarea v-model="question" class="w-full" :maxlength="30000" aria-label="求助正文"
          placeholder="描述已经尝试的方法和遇到的问题" />
        <UButton type="submit" :loading="saving" :disabled="!question.trim()">向老师求助</UButton>
      </form>
      <div v-if="selectedHelp" class="mt-4 space-y-3 rounded border border-border p-3">
        <UAlert v-if="detail.error.value" color="error" :title="extractApiError(detail.error.value).message" />
        <template v-if="detail.data.value?.data.id === selectedHelp">
          <p class="whitespace-pre-wrap text-sm">{{ detail.data.value.data.body }}</p>
          <article v-for="reply in detail.data.value.data.replies" :key="reply.id" class="border-t border-border pt-3">
            <p class="text-xs text-text-muted">{{ reply.author_name }}</p>
            <p class="mt-1 whitespace-pre-wrap text-sm">{{ reply.body }}</p>
          </article>
          <div v-if="(detail.data.value.data.reply_total ?? 0) > 50" class="flex gap-2">
            <UButton :disabled="replyPage <= 1" variant="ghost" @click="replyPage--">上一页回复</UButton>
            <UButton :disabled="replyPage * 50 >= (detail.data.value.data.reply_total ?? 0)" variant="ghost"
              @click="replyPage++">下一页回复</UButton>
          </div>
          <form v-if="writable" class="space-y-3" @submit.prevent="act('reply')">
            <UTextarea v-model="replyBody" class="w-full" :maxlength="30000" aria-label="求助回复" />
            <UButton type="submit" :loading="saving" :disabled="!replyBody.trim()">回复</UButton>
            <UButton v-if="canHelp && detail.data.value.data.state === 'open'" class="ml-2" color="success"
              variant="outline" :loading="saving" @click="act('resolve')">标记已处理</UButton>
          </form>
        </template>
      </div>
    </UCard>
  </div>
</template>
