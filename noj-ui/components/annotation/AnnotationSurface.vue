<script setup lang="ts">
import type { AnnotationSummary, AnnotationTarget } from '~/utils/annotations';
import { extractApiError } from '~/utils/apiError';
import { workspaceCacheKey } from '~/utils/workspace';

const props = defineProps<{ slug: string; target: AnnotationTarget }>();
const annotations = useAnnotationsApi(), { user } = useAuth(), workspace = useOptionalWorkspace();
const root = ref<HTMLElement | null>(null), shared = ref(false), panelOpen = ref(false), threadId = ref<string>();
const selectedText = ref(''), failure = ref(''), extra = ref<AnnotationSummary[]>([]), next = ref<string | null>(null), paging = ref(false);
const selectedRange = ref<{ block_id: string; start: number; end: number }>();
const member = computed(() => !!user.value && !!workspace?.domain.value?.is_member);
const scope = computed(() => workspaceCacheKey(props.slug, user.value?.id ?? null, 'annotations', JSON.stringify(props.target), String(shared.value)));
const notes = await useAsyncData(scope, () => member.value ? annotations.list(props.slug, props.target, shared.value) : Promise.resolve({ actor_id: user.value?.id ?? null, domain_slug: props.slug, data: [], next_cursor: null }));
const currentResponse = computed(() => !notes.error.value && notes.data.value?.actor_id === user.value?.id && notes.data.value?.domain_slug === props.slug);
const items = computed(() => currentResponse.value ? [...(notes.data.value?.data ?? []), ...extra.value] : []);
watch(notes.data, (value) => { extra.value = []; next.value = value?.next_cursor ?? null; }, { immediate: true });
watch([() => props.slug, () => JSON.stringify(props.target), () => user.value?.id], () => {
  shared.value = false; panelOpen.value = false; threadId.value = undefined; selectedText.value = ''; failure.value = ''; extra.value = [];
});
function selection() {
  if (!member.value || !root.value) return;
  const selected = window.getSelection();
  if (!selected?.rangeCount || selected.isCollapsed) return;
  const range = selected.getRangeAt(0);
  if (!root.value.contains(range.startContainer) || !root.value.contains(range.endContainer)) return;
  if (range.startContainer.parentElement?.closest('[data-annotation-ui]')) return;
  selectedText.value = selected.toString().trim().slice(0, 30000);
}
function create() { selectedRange.value = undefined; threadId.value = undefined; panelOpen.value = true; }
function annotateRange(range: { block_id: string; start: number; end: number }) {
  selectedRange.value = range; threadId.value = undefined; panelOpen.value = true;
}
defineExpose({ annotateRange });
function show(id: string) { threadId.value = id; panelOpen.value = true; }
async function more() {
  if (!next.value || paging.value) return;
  const key = scope.value, cursor = next.value;
  paging.value = true; failure.value = '';
  try {
    const response = await annotations.list(props.slug, props.target, shared.value, cursor);
    if (scope.value !== key) return;
    extra.value.push(...response.data); next.value = response.next_cursor;
  } catch (e) { if (scope.value === key) failure.value = extractApiError(e).message; }
  finally { paging.value = false; }
}
function locate(quote: string) {
  if (!root.value || !quote) return;
  const walker = document.createTreeWalker(root.value, NodeFilter.SHOW_TEXT, { acceptNode(node) {
    return node.parentElement?.closest('[data-annotation-ui],button,textarea,input') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
  } });
  const nodes: Text[] = []; let node: Node | null;
  while ((node = walker.nextNode())) nodes.push(node as Text);
  const text = nodes.map(n => n.data).join(''), start = text.indexOf(quote);
  if (start < 0) { failure.value = '当前排版无法直接定位这段文字，请在批注详情中查看固定原文。'; return; }
  if (text.indexOf(quote, start + 1) >= 0) { failure.value = '当前页面有多处相同文字，请在批注详情中查看固定的原文范围。'; return; }
  const range = document.createRange(); let offset = 0, started = false;
  for (const current of nodes) {
    if (!started && start < offset + current.length) { range.setStart(current, start - offset); started = true; }
    if (started && start + quote.length <= offset + current.length) { range.setEnd(current, start + quote.length - offset); break; }
    offset += current.length;
  }
  const selected = window.getSelection(); selected?.removeAllRanges(); selected?.addRange(range);
  range.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}
</script>
<template>
  <div ref="root" class="min-w-0" @mouseup="selection" @keyup="selection" @touchend="selection">
    <slot />
    <section v-if="member" class="mt-3 space-y-3 border-t border-border pt-3" aria-label="原文批注" data-annotation-ui>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex flex-wrap items-center gap-3">
          <span class="text-xs text-text-muted">个人笔记 {{ items.filter(n => n.visibility === 'private').length }}</span>
          <USwitch v-model="shared" label="与我共享" size="sm" />
        </div>
        <UButton v-if="workspace?.domain.value?.status === 'active'" size="sm" variant="outline" icon="i-lucide-message-square-plus" @click="create">{{ selectedText ? '批注选中文字' : '添加批注' }}</UButton>
      </div>
      <UAlert v-if="notes.error.value || failure" color="error" :title="failure || extractApiError(notes.error.value).message">
        <template #actions><UButton size="xs" variant="outline" @click="failure = ''; notes.refresh()">重新读取</UButton></template>
      </UAlert>
      <p v-if="notes.status.value === 'pending' && !notes.data.value" role="status" class="text-xs text-text-muted">正在读取个人笔记…</p>
      <ul v-if="items.length" class="divide-y divide-border">
        <li v-for="note in items" :key="note.id" class="py-2">
          <button type="button" class="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded py-1 text-left hover:text-primary focus-visible:outline-2 focus-visible:outline-primary" @click="show(note.id)">
            <UserIdentity :user="note.author" :domain="slug" :link="false" size="sm" />
            <span class="min-w-0 flex-1 truncate text-sm">{{ note.anchor.quote || `第 ${note.anchor.start_line} 行（空行）` }}</span>
            <UBadge variant="subtle" :color="note.visibility === 'private' ? 'neutral' : 'primary'" size="xs">{{ note.visibility === 'private' ? '仅自己' : note.state === 'resolved' ? '已处理' : '师生问答' }}</UBadge>
          </button>
        </li>
      </ul>
      <UButton v-if="next && currentResponse" variant="ghost" size="sm" :loading="paging" @click="more">读取更多批注</UButton>
    </section>
    <ClientOnly><AnnotationPanel v-model:open="panelOpen" :slug="slug" :thread-id="threadId" :target="target" :selected-text="selectedText" :selected-range="selectedRange" @changed="notes.refresh()" @located="locate" /></ClientOnly>
  </div>
</template>
