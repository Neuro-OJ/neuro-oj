<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { classroomCan, educationCacheKey, formatTeachingTime, helpRequestTitle } from '~/utils/education';
import { extractApiError } from '~/utils/apiError';
import { workspacePath, workspaceProblemPath } from '~/utils/workspace';
import MarkdownEditor from '~/components/shared/MarkdownEditor.vue';
import MarkdownRenderer from '~/components/shared/MarkdownRenderer.vue';

definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });

const route = useRoute();
const { slug, domain } = useWorkspace();
const education = useEducationApi();
const capture = useWorkspaceActionScope();
const actor = useState<{ id: string } | null>('auth:user', () => null);

const assignmentId = computed(() => String(route.params.assignmentId));
const helpId = computed(() => String(route.params.helpId));

const replyPage = ref(1);
const replyBody = ref('');
const replyKey = ref(crypto.randomUUID());
const saving = ref(false);
const mutationError = ref('');

useUnsavedChanges(() => !!replyBody.value.trim());

const base = computed(() => educationCacheKey(slug.value!, actor.value?.id ?? null, assignmentId.value, 'help', helpId.value));

const task = await useAsyncData(
  () => `${base.value}:task`,
  () => education.assignment(slug.value!, assignmentId.value),
);

const room = await useAsyncData(
  () => `${base.value}:classroom:${task.data.value?.data.classroom_id ?? ''}`,
  () => task.data.value ? education.classroom(slug.value!, task.data.value.data.classroom_id) : Promise.resolve(null),
);

const detail = await useAsyncData(
  () => `${base.value}:detail:${replyPage.value}`,
  () => education.helpDetail(slug.value!, assignmentId.value, helpId.value, replyPage.value),
);

const canHelp = computed(() => !room.error.value && !!room.data.value && classroomCan(room.data.value.data, 'help:manage'));
const isStudent = computed(() =>
  !room.data.value?.data.manages_domain && (
    room.data.value?.data.membership?.role === 'student' ||
    room.data.value?.data.historical_student === true
  )
);
const writable = computed(() => {
  const roomWritable = domain.value?.status === 'active' &&
    domain.value.configuration.features.classroom &&
    domain.value.configuration.features.assignment &&
    room.data.value?.data.status === 'active' &&
    task.data.value?.data.state !== 'archived';
  const studentRemoved = isStudent.value && room.data.value?.data.membership?.status !== 'active';
  return Boolean(roomWritable && !studentRemoved);
});

const itemRef = computed(() => {
  const itemId = detail.data.value?.data.item_id;
  if (!itemId) return null;
  return task.data.value?.data.items?.find((item) => item.id === itemId) ?? null;
});

const issueTitle = computed(() =>
  detail.data.value?.data.body ? helpRequestTitle(detail.data.value.data.body) : '求助详情'
);

const statusInfo = computed(() => {
  const item = detail.data.value?.data;
  if (!item) return { label: '', color: 'neutral' as const, icon: 'i-lucide-circle-dot' };
  if (item.state === 'resolved') {
    return { label: '已处理', color: 'success' as const, icon: 'i-lucide-circle-check-big' };
  }
  if (item.answered_by_coach) {
    return { label: '教练已回答', color: 'primary' as const, icon: 'i-lucide-message-square-check' };
  }
  return { label: '待教练回答', color: 'warning' as const, icon: 'i-lucide-circle-dot' };
});

watch(replyBody, () => {
  replyKey.value = crypto.randomUUID();
});

watch([() => slug.value, () => assignmentId.value, () => helpId.value, () => actor.value?.id], () => {
  replyPage.value = 1;
  replyBody.value = '';
  mutationError.value = '';
});

useBreadcrumbParams({
  assignmentId: () => task.data.value?.data.title,
  helpId: () => issueTitle.value,
});
useSeoMeta({ title: () => `${issueTitle.value} · 求助详情` });

async function submitReply(resolveAfter = false) {
  if (saving.value || !writable.value || !replyBody.value.trim()) return;
  const scope = capture();
  saving.value = true;
  mutationError.value = '';
  try {
    await education.reply(scope.slug, assignmentId.value, helpId.value, replyBody.value, replyKey.value, resolveAfter);
    if (!scope.isCurrent()) return;
    replyBody.value = '';
    await detail.refresh();
  } catch (e) {
    if (scope.isCurrent()) mutationError.value = extractApiError(e).message;
  } finally {
    if (scope.isCurrent()) saving.value = false;
  }
}

async function toggleState() {
  const current = detail.data.value?.data;
  if (!current || saving.value || !canHelp.value) return;
  const nextState = current.state === 'resolved' ? 'open' : 'resolved';
  const scope = capture();
  saving.value = true;
  mutationError.value = '';
  try {
    await education.setHelpState(scope.slug, assignmentId.value, helpId.value, current.revision, nextState);
    if (!scope.isCurrent()) return;
    await detail.refresh();
  } catch (e) {
    if (scope.isCurrent()) mutationError.value = extractApiError(e).message;
  } finally {
    if (scope.isCurrent()) saving.value = false;
  }
}
</script>

<template>
  <div class="mx-auto flex w-full max-w-4xl flex-col gap-6">
    <div>
      <NuxtLink
        :to="{ path: workspacePath(slug!, `assignments/${assignmentId}`), query: { tab: 'help' } }"
        class="inline-flex items-center gap-1.5 text-sm text-text-secondary transition-colors hover:text-primary"
      >
        <UIcon name="i-lucide-arrow-left" class="size-4" aria-hidden="true" />
        <span>返回作业<template v-if="task.data.value?.data.title"> · {{ task.data.value.data.title }}</template></span>
      </NuxtLink>
    </div>

    <AsyncContent
      :status="detail.error.value ? 'error' : detail.data.value ? 'data' : detail.status.value === 'pending' ? 'loading' : 'empty'"
      :error="detail.error.value ? extractApiError(detail.error.value).message : undefined"
      @retry="detail.refresh()"
    >
      <template v-if="detail.data.value">
        <header class="flex flex-col gap-3 border-b border-border pb-4">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <h1 class="min-w-0 flex-1 break-words text-xl font-bold leading-snug text-text sm:text-2xl">
              {{ issueTitle }}
            </h1>
            <UButton
              v-if="canHelp && writable"
              size="sm"
              :color="detail.data.value.data.state === 'resolved' ? 'neutral' : 'success'"
              variant="outline"
              :icon="detail.data.value.data.state === 'resolved' ? 'i-lucide-rotate-ccw' : 'i-lucide-check'"
              :loading="saving"
              @click="toggleState"
            >
              {{ detail.data.value.data.state === 'resolved' ? '重新打开' : '标记已处理' }}
            </UButton>
          </div>

          <div class="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
            <UBadge :color="statusInfo.color" variant="subtle" size="sm" class="inline-flex items-center gap-1">
              <UIcon :name="statusInfo.icon" class="size-3.5" aria-hidden="true" />
              {{ statusInfo.label }}
            </UBadge>
            <span>
              <strong class="font-medium text-text">{{ detail.data.value.data.author_name ?? '学生' }}</strong>
              <template v-if="detail.data.value.data.created_at">
                于 {{ formatTeachingTime(detail.data.value.data.created_at) }} 发起求助
              </template>
            </span>
            <span aria-hidden="true">·</span>
            <span class="tabular-nums">{{ detail.data.value.data.reply_total ?? detail.data.value.data.replies?.length ?? 0 }} 条回复</span>
            <template v-if="detail.data.value.data.item_id">
              <span aria-hidden="true">·</span>
              <NuxtLink
                v-if="itemRef && !isStudent"
                :to="workspaceProblemPath(slug!, itemRef.reference.qualified_ref)"
                class="inline-flex items-center gap-1 text-primary hover:underline"
              >
                <UIcon name="i-lucide-book-open-text" class="size-3.5" aria-hidden="true" />
                题目 {{ itemRef.reference.display_ref }}
              </NuxtLink>
              <span v-else class="inline-flex items-center gap-1">
                <UIcon name="i-lucide-book-open-text" class="size-3.5" aria-hidden="true" />
                {{ itemRef ? `题目 ${itemRef.reference.display_ref}` : '关联题目已移除' }}
              </span>
            </template>
          </div>
        </header>

        <!-- GitHub Issue 风格 Comment Flow 时间线 -->
        <div class="space-y-4">
          <!-- 首楼：提问正文 -->
          <article class="overflow-hidden rounded-md border border-border bg-bg-panel">
            <header class="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-bg-sunken/50 px-4 py-2.5 text-xs">
              <div class="flex items-center gap-2">
                <span class="inline-flex size-6 items-center justify-center rounded-full bg-primary-bg text-[11px] font-semibold text-primary">
                  {{ (detail.data.value.data.author_name ?? '学').slice(0, 1).toUpperCase() }}
                </span>
                <span class="font-semibold text-text">{{ detail.data.value.data.author_name ?? '学生' }}</span>
                <UBadge color="neutral" variant="outline" size="xs">提问者</UBadge>
              </div>
              <span v-if="detail.data.value.data.created_at" class="text-text-muted tabular-nums">
                {{ formatTeachingTime(detail.data.value.data.created_at) }}
              </span>
            </header>
            <div class="px-4 py-3.5 text-sm [&_p:first-child]:mt-0 [&_p:last-child]:mb-0">
              <MarkdownRenderer :content="detail.data.value.data.body" />
            </div>
          </article>

          <!-- 回复时间线 -->
          <div v-if="detail.data.value.data.replies?.length" class="relative space-y-4 pl-5 before:absolute before:bottom-2 before:left-2 before:top-0 before:w-px before:bg-border">
            <article
              v-for="reply in detail.data.value.data.replies"
              :key="reply.id"
              class="overflow-hidden rounded-md border bg-bg-panel"
              :class="reply.is_coach ? 'border-primary/30' : 'border-border'"
            >
              <header
                class="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2 text-xs"
                :class="reply.is_coach ? 'border-primary/20 bg-primary-bg/40' : 'border-border bg-bg-sunken/40'"
              >
                <div class="flex items-center gap-2">
                  <span
                    class="inline-flex size-6 items-center justify-center rounded-full text-[11px] font-semibold"
                    :class="reply.is_coach ? 'bg-primary text-white' : 'bg-bg-sunken text-text-secondary'"
                  >
                    {{ reply.author_name.slice(0, 1).toUpperCase() }}
                  </span>
                  <span class="font-semibold text-text">{{ reply.author_name }}</span>
                  <UBadge :color="reply.is_coach ? 'primary' : 'neutral'" variant="subtle" size="xs">
                    {{ reply.is_coach ? '教练' : '提问者' }}
                  </UBadge>
                </div>
                <span class="text-text-muted tabular-nums">{{ formatTeachingTime(reply.created_at) }}</span>
              </header>
              <div class="px-4 py-3 text-sm [&_p:first-child]:mt-0 [&_p:last-child]:mb-0">
                <MarkdownRenderer :content="reply.body" />
              </div>
            </article>
          </div>

          <div
            v-if="(detail.data.value.data.reply_total ?? 0) > 50"
            class="flex items-center justify-between gap-2"
          >
            <UButton :disabled="replyPage <= 1" variant="outline" color="neutral" size="sm" icon="i-lucide-chevron-left" @click="replyPage--">
              上一页回复
            </UButton>
            <span class="text-xs text-text-muted tabular-nums">第 {{ replyPage }} 页</span>
            <UButton
              :disabled="replyPage * 50 >= (detail.data.value.data.reply_total ?? 0)"
              variant="outline"
              color="neutral"
              size="sm"
              trailing-icon="i-lucide-chevron-right"
              @click="replyPage++"
            >
              下一页回复
            </UButton>
          </div>

          <UAlert v-if="mutationError" color="error" variant="subtle" :title="mutationError" />

          <!-- 底部评论框 -->
          <form v-if="writable" class="rounded-md border border-border bg-bg-panel p-4 space-y-3" @submit.prevent="submitReply(false)">
            <p class="text-sm font-medium text-text">添加回复</p>
            <MarkdownEditor
              v-model="replyBody"
              compact
              height="140px"
              :maxlength="30000"
              aria-label="求助回复"
              placeholder="输入回复内容（支持 Markdown、代码块与公式）"
            />
            <div class="flex flex-wrap items-center justify-end gap-2">
              <UButton type="submit" :variant="canHelp ? 'outline' : 'solid'" color="primary" size="sm" :loading="saving" :disabled="!replyBody.trim()">
                回复
              </UButton>
              <UButton
                v-if="canHelp && detail.data.value.data.state === 'open'"
                type="button"
                color="primary"
                size="sm"
                icon="i-lucide-check"
                :loading="saving"
                :disabled="!replyBody.trim()"
                @click="submitReply(true)"
              >
                回复并标记已处理
              </UButton>
            </div>
          </form>
          <p v-else class="rounded-md border border-border bg-bg-sunken/40 px-4 py-3 text-xs text-text-muted">
            当前账号暂无权限继续回复此求助。
          </p>
        </div>
      </template>
    </AsyncContent>
  </div>
</template>
