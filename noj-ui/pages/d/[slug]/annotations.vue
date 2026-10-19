<script setup lang="ts">
import { extractApiError } from '~/utils/apiError';
import { workspaceCacheKey } from '~/utils/workspace';
import type { AnnotationSummary } from '~/utils/annotations';

definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const route = useRoute(), { slug } = useWorkspace(), { user } = useAuth(), annotations = useAnnotationsApi();
const mode = ref('mine'), open = ref(typeof route.query.thread === 'string'), selected = ref<string>(typeof route.query.thread === 'string' ? route.query.thread : '');
const cursor = ref<string>(), previous = ref<Array<string | undefined>>([]);
const inboxCursor = ref<string>(), inboxPrevious = ref<Array<string | undefined>>([]);
const scope = computed(() => workspaceCacheKey(slug.value!, user.value?.id ?? null, 'annotation-directory', mode.value, cursor.value));
const notes = await useAsyncData(scope, () => annotations.list(slug.value!, undefined, mode.value === 'teaching', cursor.value, mode.value === 'teaching'));
const inbox = await useAsyncData(() => workspaceCacheKey(slug.value!, user.value?.id ?? null, 'annotation-inbox', inboxCursor.value), () => annotations.inbox(slug.value!, inboxCursor.value));
// 身份切换后旧请求即使晚到，也不能在新域或新账号页面展示。
const currentNotes = computed(() => !notes.error.value && notes.data.value && notes.data.value.actor_id === user.value?.id && notes.data.value.domain_slug === slug.value ? notes.data.value : null);
const currentInbox = computed(() => !inbox.error.value && inbox.data.value && inbox.data.value.actor_id === user.value?.id && inbox.data.value.domain_slug === slug.value ? inbox.data.value : null);
watch(mode, () => { cursor.value = undefined; previous.value = []; });
watch([slug, () => user.value?.id], () => { open.value = false; selected.value = ''; mode.value = 'mine'; cursor.value = undefined; previous.value = []; inboxCursor.value = undefined; inboxPrevious.value = []; });
watch(() => route.query.thread, (value) => { if (typeof value === 'string') { selected.value = value; open.value = true; } });
function show(id: string) { selected.value = id; open.value = true; }
function title(note: AnnotationSummary) { return note.target.kind === 'problem' ? `题目 ${note.target.reference}` : note.target.kind === 'submission' ? `提交文件 ${note.target.file_name}` : '题解'; }
async function refresh() { await Promise.all([notes.refresh(), inbox.refresh()]); }
usePolling({ active: computed(() => !!user.value), intervalMs: 30000, fetcher: () => inbox.refresh(), immediate: false });
useSeoMeta({ title: '批注与问答' });
</script>
<template>
  <div class="mx-auto max-w-4xl space-y-6">
    <LibraryPageHeader title="批注与问答" description="个人笔记仅自己可见。定向问答由一名学生与本域现任教师组共同查看。" icon="i-lucide-notebook-pen" />
    <UTabs v-model="mode" :content="false" :items="[{ label: '个人笔记', value: 'mine' }, { label: '师生问答', value: 'teaching' }, { label: `消息提醒${currentInbox?.unread_count ? ` (${currentInbox.unread_count})` : ''}`, value: 'inbox' }]" class="w-full sm:w-fit" />
    <template v-if="mode !== 'inbox'">
      <UAlert v-if="notes.error.value" color="error" :title="extractApiError(notes.error.value).message"><template #actions><UButton variant="outline" @click="notes.refresh()">重新读取</UButton></template></UAlert>
      <p v-else-if="notes.status.value === 'pending'" role="status" class="py-8 text-text-muted">正在读取批注…</p>
      <ul v-else-if="currentNotes?.data.length" class="divide-y divide-border border-y border-border">
        <li v-for="note in currentNotes.data" :key="note.id" class="py-4">
          <button type="button" class="w-full space-y-3 rounded text-left focus-visible:outline-2 focus-visible:outline-primary" @click="show(note.id)">
            <span class="flex flex-wrap items-center justify-between gap-2"><UserIdentity :user="note.author" :domain="slug" :link="false" size="sm" /><UBadge :color="note.visibility === 'private' ? 'neutral' : 'primary'" variant="subtle">{{ note.visibility === 'private' ? '仅自己' : note.state === 'resolved' ? '已处理' : '待处理' }}</UBadge></span>
            <span class="block break-words text-sm text-text">{{ note.anchor.quote }}</span>
            <span class="block text-xs text-text-muted">{{ title(note) }} · {{ note.anchor.start_line }}–{{ note.anchor.end_line }} 行</span>
          </button>
        </li>
      </ul>
      <p v-else class="py-10 text-center text-text-muted">{{ mode === 'mine' ? '还没有个人笔记。在题面、提交代码或题解中选择文字即可添加。' : '暂无可查看的师生问答。' }}</p>
      <div class="flex justify-between gap-2">
        <UButton variant="outline" :disabled="!previous.length" @click="cursor = previous.pop()">上一页</UButton>
        <UButton variant="outline" :disabled="!currentNotes?.next_cursor" @click="previous.push(cursor); cursor = currentNotes!.next_cursor!">下一页</UButton>
      </div>
    </template>
    <template v-else>
      <UAlert v-if="inbox.error.value" color="error" :title="extractApiError(inbox.error.value).message"><template #actions><UButton variant="outline" @click="inbox.refresh()">重新读取</UButton></template></UAlert>
      <ul v-else-if="currentInbox?.data.length" class="divide-y divide-border border-y border-border">
        <li v-for="notice in currentInbox.data" :key="notice.id"><button type="button" class="flex min-h-16 w-full items-center justify-between gap-3 py-3 text-left hover:text-primary" @click="show(notice.thread_id)"><span>{{ notice.read_at ? '师生问答有更新' : '新的教学批注或回复' }}</span><UBadge v-if="!notice.read_at" variant="subtle">未读</UBadge><time :datetime="notice.created_at" class="text-xs text-text-muted">{{ new Date(notice.created_at).toLocaleString() }}</time></button></li>
      </ul>
      <p v-else class="py-10 text-center text-text-muted">暂无可查看的批注消息。</p>
      <div class="flex justify-between gap-2">
        <UButton variant="outline" :disabled="!inboxPrevious.length || inbox.status.value === 'pending'" @click="inboxCursor = inboxPrevious.pop()">上一页消息</UButton>
        <UButton variant="outline" :disabled="!currentInbox?.next_cursor || inbox.status.value === 'pending'" @click="inboxPrevious.push(inboxCursor); inboxCursor = currentInbox!.next_cursor!">下一页消息</UButton>
      </div>
    </template>
    <ClientOnly><AnnotationPanel v-model:open="open" :slug="slug!" :thread-id="selected || undefined" @changed="refresh()" /></ClientOnly>
  </div>
</template>
