<script setup lang="ts">
import { extractApiError } from '~/utils/apiError';
const props = defineProps<{
  slug: string;
  assignmentId: string;
  helpId: string;
  canHelp: boolean;
  writable: boolean;
}>();
const emit = defineEmits<{ changed: []; close: [] }>();
const education = useEducationApi(), capture = useWorkspaceActionScope();
const page = ref(1), replyBody = ref(''), saving = ref(false), failure = ref('');
const replyKey = ref(crypto.randomUUID());
const { data, status, error, refresh } = await useAsyncData(
  () => `help-thread:${props.slug}:${props.assignmentId}:${props.helpId}:${page.value}`,
  () => education.helpDetail(props.slug, props.assignmentId, props.helpId, page.value),
);
useUnsavedChanges(() => !!replyBody.value.trim());
watch(replyBody, () => {
  replyKey.value = crypto.randomUUID();
});
function apiError(value: unknown) {
  return value ? extractApiError(value).message : '';
}
async function reply() {
  if (saving.value || !props.writable || !replyBody.value.trim()) return;
  const scope = capture();
  saving.value = true;
  failure.value = '';
  try {
    await education.reply(scope.slug, props.assignmentId, props.helpId, replyBody.value, replyKey.value);
    if (!scope.isCurrent()) return;
    replyBody.value = '';
    await refresh();
    emit('changed');
  } catch (e) {
    if (scope.isCurrent()) failure.value = apiError(e);
  } finally {
    if (scope.isCurrent()) saving.value = false;
  }
}
async function resolve() {
  if (saving.value || !props.canHelp || !data.value?.data) return;
  const scope = capture(), requested = data.value.data;
  saving.value = true;
  failure.value = '';
  try {
    await education.resolve(scope.slug, props.assignmentId, props.helpId, requested.revision);
    if (!scope.isCurrent()) return;
    await refresh();
    emit('changed');
  } catch (e) {
    if (scope.isCurrent()) failure.value = apiError(e);
  } finally {
    if (scope.isCurrent()) saving.value = false;
  }
}
</script>
<template>
  <section class="space-y-3" :aria-label="`求助 ${helpId} 的回复`">
    <div class="flex items-center justify-between gap-2">
      <h4 class="text-sm font-semibold">回复与处理</h4>
      <UButton variant="ghost" color="neutral" size="xs" icon="i-lucide-x" @click="emit('close')">
        收起</UButton>
    </div>
    <UAlert v-if="failure" color="error" :title="failure" />
    <UAlert v-if="error" color="error" :title="apiError(error)" />
    <p v-if="status === 'pending' && !data" class="text-sm text-text-muted">读取回复中…</p>
    <template v-if="data?.data">
      <div v-for="reply in data.data.replies" :key="reply.id" class="border-t border-border pt-3">
        <p class="text-xs text-text-muted">{{ reply.author_name }}</p>
        <p class="mt-1 whitespace-pre-wrap text-sm">{{ reply.body }}</p>
      </div>
      <p v-if="!data.data.replies?.length" class="text-sm text-text-muted">还没有回复。</p>
      <div v-if="(data.data.reply_total ?? 0) > 50" class="flex items-center justify-between gap-2">
        <UButton :disabled="page <= 1" variant="ghost" color="neutral" size="sm" icon="i-lucide-chevron-left"
          aria-label="上一页回复" @click="page--" />
        <span class="text-xs text-text-muted tabular-nums">{{ page }}</span>
        <UButton :disabled="page * 50 >= (data.data.reply_total ?? 0)" variant="ghost" color="neutral" size="sm"
          trailing-icon="i-lucide-chevron-right" aria-label="下一页回复" @click="page++" />
      </div>
      <form v-if="writable" class="space-y-2" @submit.prevent="reply">
        <UTextarea v-model="replyBody" class="w-full" :rows="2" :maxlength="30000" aria-label="求助回复"
          placeholder="回复学生的问题" />
        <div class="flex flex-wrap items-center justify-end gap-2">
          <UButton v-if="canHelp && data.data.state === 'open'" color="success" variant="outline" size="sm"
            :loading="saving" @click="resolve">标记已处理</UButton>
          <UButton type="submit" size="sm" :loading="saving" :disabled="!replyBody.trim()">回复</UButton>
        </div>
      </form>
      <p v-else-if="!data.data.replies?.length" class="text-xs text-text-muted">当前账号没有回复权限。</p>
    </template>
  </section>
</template>
