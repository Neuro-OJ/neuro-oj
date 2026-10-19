<script setup lang="ts">
import type { AnnotationDetail, AnnotationMessage, AnnotationSource, AnnotationTarget } from '~/utils/annotations';
import { annotationSelection } from '~/utils/annotations';
import { extractApiError } from '~/utils/apiError';
import type { UserSummary } from '~/utils/user-identity';

const props = defineProps<{ slug: string; threadId?: string; target?: AnnotationTarget; selectedText?: string; selectedRange?: { block_id: string; start: number; end: number } }>();
const open = defineModel<boolean>('open', { default: false });
const emit = defineEmits<{ changed: []; located: [quote: string] }>();
const annotations = useAnnotationsApi(), { user } = useAuth(), workspace = useOptionalWorkspace();
const { dialog } = useDialog();
const contextKey = computed(() => `${props.slug}:${actorId.value}:${props.threadId ?? ''}:${JSON.stringify(props.target)}`);
const detail = ref<AnnotationDetail | null>(null), source = ref<AnnotationSource | null>(null);
const activeId = ref(''), page = ref(1), loading = ref(false), saving = ref(false), failure = ref('');
const generation = ref(0);
let detailSequence = 0;
const body = ref(''), reply = ref(''), editBody = ref(''), editing = ref<AnnotationMessage | null>(null);
const withdrawalReason = ref('');
const visibility = ref<'private' | 'teaching'>('private'), student = ref<string>(), keyword = ref('');
const recipients = ref<UserSummary[]>([]), blockId = ref(''), selectionIndex = ref<number>(), originalOpen = ref(false);
const requestKey = ref(crypto.randomUUID());
const actorId = computed(() => user.value?.id), education = computed(() => workspace?.domain.value?.preset === 'education');
const coach = computed(() => ['owner', 'coach'].includes(workspace?.domain.value?.role ?? ''));
const writable = computed(() => workspace?.domain.value?.status === 'active');
const candidates = computed(() => annotationSelection(source.value?.blocks ?? [], props.selectedText?.trim() ?? ''));
const selected = ref<{ block_id: string; start: number; end: number } | null>(null);
const block = computed(() => source.value?.blocks.find((b) => b.id === selected.value?.block_id));
const quote = computed(() => selected.value && block.value ? block.value.text.slice(selected.value.start, selected.value.end) : '');
const needsStudent = computed(() => coach.value && !source.value?.student_id && (visibility.value === 'teaching' || detail.value?.visibility === 'private'));
const canSave = computed(() => !!source.value && !!selected.value && !!body.value.trim() && (!needsStudent.value || visibility.value === 'private' || !!student.value));
useUnsavedChanges(() => open.value && !!(body.value.trim() || reply.value.trim() || editing.value));
watch([body, visibility, student, selected, reply], () => { requestKey.value = crypto.randomUUID(); });
function fail(error: unknown) {
  const value = extractApiError(error); failure.value = value.message;
  if ([401, 403, 404].includes(value.status ?? 0)) {
    generation.value++; detailSequence++; loading.value = false; saving.value = false;
    detail.value = null; source.value = null; body.value = ''; reply.value = ''; editing.value = null;
  }
}
async function loadDetail() {
  if (!activeId.value || !open.value) return;
  const actor = actorId.value, slug = props.slug, id = activeId.value, run = generation.value, sequence = ++detailSequence;
  try {
    const response = await annotations.detail(slug, id, page.value);
    if (generation.value !== run || detailSequence !== sequence || !open.value || props.slug !== slug || actorId.value !== actor || activeId.value !== id) return;
    detail.value = response.data; failure.value = '';
  } catch (e) { if (generation.value === run && detailSequence === sequence && props.slug === slug && actorId.value === actor && activeId.value === id) fail(e); }
}
async function initialize() {
  const run = ++generation.value; detailSequence++;
  detail.value = null; source.value = null; activeId.value = props.threadId ?? ''; page.value = 1;
  body.value = ''; reply.value = ''; editing.value = null; failure.value = ''; selected.value = null;
  visibility.value = 'private'; student.value = undefined; recipients.value = []; originalOpen.value = false;
  withdrawalReason.value = '';
  saving.value = false; loading.value = false;
  if (!open.value) return;
  loading.value = true;
  const actor = actorId.value, slug = props.slug, context = contextKey.value;
  try {
    if (activeId.value) { await loadDetail(); if (detail.value) await annotations.read(slug, activeId.value); }
    else if (props.target) {
      const response = await annotations.source(slug, props.target);
      if (generation.value !== run || !open.value || props.slug !== slug || actorId.value !== actor || contextKey.value !== context) return;
      source.value = response.data;
      const match = props.selectedRange ?? (candidates.value.length === 1 ? candidates.value[0] : undefined);
      selected.value = match ?? null; blockId.value = match?.block_id ?? response.data.blocks[0]?.id ?? '';
      selectionIndex.value = candidates.value.length === 1 ? 0 : undefined;
    }
  } catch (e) { if (generation.value === run && props.slug === slug && actorId.value === actor && contextKey.value === context) fail(e); }
  finally { if (generation.value === run && contextKey.value === context) loading.value = false; }
}
watch([open, () => props.threadId, () => JSON.stringify(props.target), () => props.slug, actorId], initialize, { immediate: true });
watch(blockId, (value) => { if (selected.value?.block_id !== value) selected.value = null; });
watch(page, () => { if (open.value && detail.value) void loadDetail(); });
usePolling({ active: computed(() => open.value && !!detail.value), intervalMs: 30000, fetcher: loadDetail, immediate: false });
function wholeBlock() {
  const value = source.value?.blocks.find((b) => b.id === blockId.value);
  selected.value = value?.text ? { block_id: value.id, start: 0, end: value.text.length } : null;
}
function chooseCandidate(value: number) { selected.value = candidates.value[value] ?? null; blockId.value = selected.value?.block_id ?? ''; }
function selectPreview(event: Event) {
  const selection = window.getSelection(), element = event.currentTarget as HTMLElement;
  if (!selection || selection.isCollapsed || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return;
  const before = range.cloneRange(); before.selectNodeContents(element); before.setEnd(range.startContainer, range.startOffset);
  selected.value = { block_id: blockId.value, start: before.toString().length, end: before.toString().length + range.toString().length };
}
async function findStudents(target?: AnnotationTarget) {
  const selectedTarget = target ?? source.value?.target ?? detail.value?.target;
  if (!selectedTarget || saving.value) return;
  const context = contextKey.value, run = generation.value;
  saving.value = true;
  try { const result = await annotations.recipients(props.slug, selectedTarget, keyword.value); if (generation.value === run && open.value && contextKey.value === context) recipients.value = result.data; }
  catch (e) { if (generation.value === run && contextKey.value === context) fail(e); } finally { if (generation.value === run && contextKey.value === context) saving.value = false; }
}
async function perform(action: () => Promise<{ data: AnnotationDetail }>) {
  if (saving.value || !writable.value) return;
  const actor = actorId.value, slug = props.slug, context = contextKey.value, run = generation.value;
  saving.value = true; failure.value = '';
  try {
    const result = await action();
    if (generation.value !== run || !open.value || actorId.value !== actor || props.slug !== slug || contextKey.value !== context) return;
    detail.value = result.data; activeId.value = result.data.id; body.value = ''; reply.value = ''; editing.value = null;
    requestKey.value = crypto.randomUUID(); emit('changed');
  } catch (e) { if (generation.value === run && actorId.value === actor && props.slug === slug && contextKey.value === context) fail(e); }
  finally { if (generation.value === run && contextKey.value === context) saving.value = false; }
}
function save() {
  if (!canSave.value || !source.value || !selected.value) return;
  const value = { target: source.value.target, content_hash: source.value.content_hash, anchor: selected.value,
    body: body.value, visibility: visibility.value, student_id: source.value.student_id ?? student.value };
  void perform(() => annotations.create(props.slug, value, requestKey.value));
}
async function showOriginal() {
  if (!detail.value || saving.value) return;
  const context = contextKey.value, id = detail.value.id, run = generation.value;
  saving.value = true;
  try { const result = await annotations.original(props.slug, id); if (generation.value === run && open.value && contextKey.value === context && detail.value?.id === id) { source.value = result.data; originalOpen.value = !originalOpen.value; } }
  catch (e) { if (generation.value === run && contextKey.value === context) fail(e); } finally { if (generation.value === run && contextKey.value === context) saving.value = false; }
}
async function withdrawThread() {
  if (!detail.value || saving.value || !writable.value) return;
  const current = detail.value, context = contextKey.value, run = generation.value, reason = current.owner_id === actorId.value ? undefined : withdrawalReason.value.trim();
  if (current.owner_id !== actorId.value && !reason) return;
  if (!await dialog.confirm('撤回整条批注会从普通页面隐藏会话，历史依据仍保留。继续撤回？', { title: '撤回批注会话', confirmText: '确认撤回' }) || contextKey.value !== context || generation.value !== run) return;
  saving.value = true;
  try { await annotations.withdraw(props.slug, current.id, current.revision, reason); if (generation.value === run && contextKey.value === context) { emit('changed'); open.value = false; } }
  catch (e) { if (generation.value === run && contextKey.value === context) fail(e); } finally { if (generation.value === run && contextKey.value === context) saving.value = false; }
}
async function requestClose(value: boolean) {
  const run = generation.value;
  if (!value && (body.value.trim() || reply.value.trim() || editing.value)) {
    if (!await dialog.confirm('放弃尚未保存的批注内容并关闭？', { title: '尚未保存的批注', confirmText: '放弃并关闭' })) return;
  }
  if (generation.value === run) open.value = value;
}
</script>
<template>
  <USlideover :open="open" :title="detail?.visibility === 'teaching' ? '定向师生问答' : '个人批注'" :ui="{ content: 'w-full sm:max-w-xl' }" @update:open="requestClose">
    <template #body>
      <div class="space-y-5">
        <UAlert v-if="failure" color="error" :title="failure" />
        <p v-if="loading" role="status" class="text-sm text-text-secondary">正在读取批注与原文权限…</p>
        <template v-if="detail">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <UserIdentity :user="detail.author" :domain="slug" size="sm" />
            <UBadge :color="detail.visibility === 'private' ? 'neutral' : 'primary'" variant="subtle">{{ detail.visibility === 'private' ? '仅自己' : '学生与本域现任教师组' }}</UBadge>
          </div>
          <UAlert v-if="detail.visibility === 'teaching'" color="neutral" variant="subtle" title="仅此学生与本域现任负责人、教练可见" description="新任教练可以接手历史问答，离任教练立即失去读取权限。" />
          <UAlert v-if="detail.source_changed" color="warning" title="原文已有新版本，批注保留在原来的文字上" />
          <section class="space-y-2" aria-label="批注引用与上下文">
            <p class="text-xs text-text-muted tabular-nums">原文 {{ detail.anchor.start_line }}–{{ detail.anchor.end_line }} 行</p>
            <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-bg-sunken p-3 text-sm"><span class="text-text-secondary">{{ detail.anchor.before }}</span><mark class="bg-primary-bg text-text">{{ detail.anchor.quote }}</mark><span class="text-text-secondary">{{ detail.anchor.after }}</span></pre>
            <div class="flex flex-wrap gap-2">
              <UButton variant="outline" color="neutral" size="sm" :loading="saving" @click="showOriginal">{{ originalOpen ? '收起完整原文' : '查看完整原文' }}</UButton>
              <UButton variant="ghost" color="neutral" size="sm" :disabled="detail.source_changed" @click="emit('located', detail.anchor.quote)">定位选中文字</UButton>
              <UButton :to="detail.href" variant="link" size="sm">打开原页面</UButton>
            </div>
            <div v-if="originalOpen && source" class="max-h-96 space-y-3 overflow-auto border-y border-border py-3" aria-label="批注时的原文版本">
              <MarkdownRenderer v-if="source.blocks[0]?.id !== 'file' && source.content !== undefined" :content="source.content" />
              <template v-else><pre v-for="part in source.blocks" :key="part.id" class="whitespace-pre-wrap break-words text-sm" :class="part.id === detail.anchor.block_id ? 'bg-primary-bg' : ''">{{ part.text }}</pre></template>
            </div>
          </section>
          <ol class="space-y-5" aria-label="批注消息">
            <li v-for="message in detail.messages" :key="message.id" class="space-y-2 border-t border-border pt-4">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <UserIdentity :user="message.author" :domain="slug" size="sm" />
                <time :datetime="message.created_at" class="text-xs text-text-muted">{{ new Date(message.created_at).toLocaleString() }}</time>
              </div>
              <form v-if="editing?.id === message.id" class="space-y-2" @submit.prevent="perform(() => annotations.edit(slug, detail!.id, message.id, message.revision, editBody))">
                <UTextarea v-model="editBody" :maxlength="30000" aria-label="修改批注正文" class="w-full" />
                <UButton type="submit" :loading="saving" :disabled="!editBody.trim()">保存修改</UButton>
                <UButton variant="ghost" @click="editing = null">取消</UButton>
              </form>
              <p v-else-if="message.withdrawn_at" class="text-sm text-text-muted">作者已撤回此消息。</p>
              <MarkdownRenderer v-else :content="message.body ?? ''" />
              <div v-if="writable && message.author_id === actorId && !message.withdrawn_at && !editing" class="flex gap-2">
                <UButton size="xs" variant="ghost" color="neutral" @click="editing = message; editBody = message.body ?? ''">修改</UButton>
                <UButton size="xs" variant="ghost" color="error" :disabled="saving" @click="perform(() => annotations.withdrawMessage(slug, detail!.id, message.id, message.revision))">撤回消息</UButton>
              </div>
            </li>
          </ol>
          <div v-if="detail.total > detail.per_page" class="flex items-center justify-between gap-2">
            <UButton variant="outline" size="sm" :disabled="page <= 1" @click="page--">上一页</UButton>
            <span class="text-xs tabular-nums">第 {{ page }} 页</span>
            <UButton variant="outline" size="sm" :disabled="page * detail.per_page >= detail.total" @click="page++">下一页</UButton>
          </div>
          <section v-if="detail.visibility === 'private' && education && writable" class="space-y-3 border-t border-border pt-4">
            <p class="text-sm text-text-secondary">发送会创建独立会话。以后修改这份个人笔记，不会自动同步给教师组。</p>
            <template v-if="coach && detail.target.kind !== 'submission'">
              <div class="flex gap-2"><UInput v-model="keyword" placeholder="查找域内学生" aria-label="查找接收学生" /><UButton variant="outline" :loading="saving" @click="findStudents(detail.target)">查找</UButton></div>
              <USelect v-model="student" :items="recipients.map(r => ({ value: r.id, label: r.username }))" placeholder="选择一名有原文访问权的学生" aria-label="接收学生" class="w-full" />
            </template>
            <UButton :loading="saving" :disabled="coach && detail.target.kind !== 'submission' && !student" @click="perform(() => annotations.share(slug, detail!.id, detail!.revision, requestKey, student))">{{ coach ? '发送定向教学批注' : '向教师组提问' }}</UButton>
          </section>
          <form v-if="detail.can_reply && writable" class="space-y-3 border-t border-border pt-4" @submit.prevent="perform(() => annotations.reply(slug, detail!.id, reply, requestKey))">
            <UTextarea v-model="reply" :rows="4" :maxlength="30000" class="w-full" aria-label="师生问答回复" placeholder="回复此问题" />
            <div class="flex flex-wrap items-center justify-between gap-2">
              <UButton type="submit" :loading="saving" :disabled="!reply.trim()">回复</UButton>
              <UButton variant="outline" color="neutral" :disabled="saving" @click="perform(() => annotations.state(slug, detail!.id, detail!.revision, detail!.state === 'open' ? 'resolved' : 'open'))">{{ detail.state === 'open' ? '标记已处理' : '重新打开' }}</UButton>
            </div>
          </form>
          <UButton v-if="detail.owner_id === actorId && writable" color="error" variant="ghost" size="sm" :loading="saving" @click="withdrawThread">撤回整条批注</UButton>
          <section v-else-if="coach && detail.visibility === 'teaching' && writable" class="space-y-3 border-t border-border pt-4" aria-label="撤回教学会话">
            <label class="text-sm text-text-secondary" for="annotation-withdrawal-reason">撤回他人的教学会话需要说明原因，原消息仍保留审计依据。</label>
            <UTextarea id="annotation-withdrawal-reason" v-model="withdrawalReason" :maxlength="1000" class="w-full" aria-label="教学会话撤回原因" />
            <UButton color="error" variant="outline" size="sm" :loading="saving" :disabled="!withdrawalReason.trim()" @click="withdrawThread">记录原因并撤回会话</UButton>
          </section>
        </template>
        <form v-else-if="source && !loading" class="space-y-4" @submit.prevent="save">
          <p class="text-sm text-text-secondary">确认选中文字后写下批注。默认只有你自己可见。</p>
          <USelect v-if="candidates.length > 1" v-model="selectionIndex" :items="candidates.map((c, i) => ({ value: i, label: `第 ${i + 1} 个匹配位置 · ${c.block_id}` }))" aria-label="确认重复文字位置" class="w-full" @update:model-value="chooseCandidate(Number($event))" />
          <UAlert v-if="!selected" color="neutral" title="请选择原文中的文字或按整段批注" description="公式等复杂内容可以在下面的原文段落中重新选择。" />
          <div class="flex gap-2">
            <USelect v-model="blockId" :items="source.blocks.map(b => ({ value: b.id, label: `第 ${b.start_line} 行 · ${b.text.slice(0, 35)}` }))" aria-label="原文段落" class="min-w-0 flex-1" />
            <UButton variant="outline" color="neutral" @click="wholeBlock">按整段批注</UButton>
          </div>
          <pre tabindex="0" class="max-h-56 select-text overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-bg-sunken p-3 text-sm" aria-label="选择批注原文" @mouseup="selectPreview" @keyup="selectPreview">{{ source.blocks.find(b => b.id === blockId)?.text }}</pre>
          <blockquote v-if="quote" class="rounded border border-border bg-primary-bg p-3 text-sm" aria-label="已选引用">{{ quote }}</blockquote>
          <USelect v-model="visibility" :items="[{ label: '仅自己', value: 'private' }, ...(education ? [{ label: '定向师生问答', value: 'teaching' }] : [])]" aria-label="批注可见范围" class="w-full" />
          <template v-if="visibility === 'teaching'">
            <UAlert color="neutral" title="仅一名学生与本域现任负责人、教练可见" description="新任教练可以查看历史，离任教练立即失去读取权限。" />
            <template v-if="coach && !source.student_id">
              <div class="flex gap-2"><UInput v-model="keyword" placeholder="查找域内学生" aria-label="查找接收学生" /><UButton variant="outline" :loading="saving" @click="findStudents()">查找</UButton></div>
              <USelect v-model="student" :items="recipients.map(r => ({ value: r.id, label: r.username }))" placeholder="选择接收学生" aria-label="接收学生" class="w-full" />
            </template>
          </template>
          <UTextarea v-model="body" :rows="6" :maxlength="30000" class="w-full" aria-label="批注正文" placeholder="写下你的理解、问题或教学建议" />
          <UButton type="submit" :loading="saving" :disabled="!canSave || !writable">{{ visibility === 'private' ? '保存个人笔记' : '发送师生问答' }}</UButton>
        </form>
        <UButton v-if="failure" variant="outline" color="neutral" @click="initialize">重新读取</UButton>
      </div>
    </template>
  </USlideover>
</template>
