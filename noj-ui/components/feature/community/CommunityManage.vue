<script setup lang="ts">
import type { PostRow, CommentRow, ReportRow } from '~/composables/useCommunity';
import { extractApiError } from '~/utils/apiError';
import { useToast } from '~/composables/useToast';

interface Board {
  id: string; slug: string; name: string; description: string | null;
  sort_order: number; is_archived: boolean; revision: number;
}
const scope = useCommunityScope().capture();
const { can, domain } = useWorkspace();
const { api } = useApi();
const { toast } = useToast();
const { dialog } = useDialog();
const allowed = computed(() => can('community:moderate'));
const writable = computed(() => allowed.value && domain.value?.status === 'active');
const tab = ref('boards');
const pending = ref(false);
const failure = ref('');
const boardDraft = ref({ slug: '', name: '', description: '' });
const editing = ref<(Omit<Board, 'description'> & { description: string }) | null>(null);
const resolution = ref('');
const selectedReport = ref<ReportRow | null>(null);
const { data, status, error, refresh } = await useAsyncData(`${scope.key}:manage`, async () => {
  if (!allowed.value) return null;
  const [boards, posts, comments, reports] = await Promise.all([
    api.get<{ data: Board[] }>(scope.apiPath('manage/boards'), { silent: true }),
    api.get<{ data: PostRow[] }>(scope.apiPath('manage/posts'), { silent: true }),
    api.get<{ data: CommentRow[] }>(scope.apiPath('manage/comments'), { silent: true }),
    api.get<{ data: ReportRow[] }>(scope.apiPath('manage/reports'), { silent: true }),
  ]);
  return { boards: boards.data, posts: posts.data, comments: comments.data, reports: reports.data };
});

async function mutate(operation: () => Promise<unknown>) {
  if (pending.value || !writable.value || !scope.isCurrent()) return;
  pending.value = true;
  failure.value = '';
  try {
    await operation();
    if (!scope.isCurrent()) return;
    editing.value = null;
    selectedReport.value = null;
    toast.success('已保存');
    await refresh();
  } catch (err) {
    failure.value = extractApiError(err).message;
  } finally {
    pending.value = false;
  }
}
async function createBoard() {
  await mutate(() => api.post(scope.apiPath('manage/boards'), boardDraft.value));
  if (scope.isCurrent() && !failure.value) boardDraft.value = { slug: '', name: '', description: '' };
}
function editBoard(board: Board) { editing.value = { ...board, description: board.description ?? '' }; }
async function saveBoard() {
  const board = editing.value;
  if (!board) return;
  await mutate(() => api.patch(scope.apiPath(`manage/boards/${board.id}`), {
    name: board.name, description: board.description, sort_order: board.sort_order, is_archived: board.is_archived,
  }, { headers: { 'If-Match': String(board.revision) } }));
}
async function review(kind: 'posts' | 'comments', id: string, action: 'published' | 'hidden') {
  const ok = await dialog.confirm(action === 'published' ? '公开这条内容？' : '隐藏这条内容？', { title: '审核内容' });
  if (!ok || !scope.isCurrent()) return;
  await mutate(() => api.patch(scope.apiPath(`manage/${kind}/${id}/status`), { status: action }));
}
async function resolveReport(action: 'resolved' | 'dismissed') {
  const report = selectedReport.value;
  if (!report) return;
  await mutate(() => api.patch(scope.apiPath(`manage/reports/${report.report.id}`), {
    status: action, resolution: resolution.value,
  }));
}
</script>

<template>
  <div class="space-y-5">
    <AdminPageHeader title="社区管理" description="管理本域板块、内容审核和举报" />
    <UAlert v-if="!allowed" color="warning" title="当前账号没有此域的社区管理权限" />
    <template v-else>
      <div class="flex flex-wrap gap-2">
        <UButton v-for="item in [{value:'boards',label:'板块'}, {value:'review',label:'内容审核'}, {value:'reports',label:'举报'}]"
          :key="item.value" :variant="tab === item.value ? 'solid' : 'outline'" @click="tab = item.value">{{ item.label }}</UButton>
      </div>
      <UAlert v-if="failure" color="error" :title="failure" />
      <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : 'data'"
        :error="error ? extractApiError(error).message : undefined" @retry="refresh()">
        <div v-if="tab === 'boards'" class="space-y-4">
          <form v-if="writable" class="flex flex-wrap items-end gap-3" @submit.prevent="createBoard">
            <UFormField label="板块名称"><UInput v-model="boardDraft.name" required aria-label="板块名称" /></UFormField>
            <UFormField label="固定标识"><UInput v-model="boardDraft.slug" pattern="[a-z0-9]+(-[a-z0-9]+)*" required aria-label="板块固定标识" /></UFormField>
            <UFormField label="简介"><UInput v-model="boardDraft.description" aria-label="板块简介" /></UFormField>
            <UButton type="submit" :loading="pending">创建板块</UButton>
          </form>
          <UCard v-for="board in data?.boards" :key="board.id">
            <div class="flex items-center justify-between gap-3">
              <div><h2 class="font-semibold">{{ board.name }} <span v-if="board.is_archived" class="text-sm text-text-muted">已归档</span></h2><p class="text-sm text-text-muted">{{ board.slug }} · {{ board.description }}</p></div>
              <UButton v-if="writable" variant="outline" @click="editBoard(board)">编辑</UButton>
            </div>
          </UCard>
          <p v-if="!data?.boards.length" class="text-text-muted">尚无板块，请先创建讨论板块。</p>
          <form v-if="editing" class="space-y-3 rounded border border-border p-4" @submit.prevent="saveBoard">
            <UFormField label="板块名称"><UInput v-model="editing.name" required /></UFormField>
            <UFormField label="简介"><UTextarea v-model="editing.description" class="w-full" /></UFormField>
            <UFormField label="排序"><UInput v-model.number="editing.sort_order" type="number" /></UFormField>
            <UCheckbox v-model="editing.is_archived" label="归档板块" />
            <div class="flex gap-2"><UButton type="submit" :loading="pending" :disabled="!writable">保存板块</UButton><UButton variant="outline" @click="editing = null">取消</UButton></div>
          </form>
        </div>
        <div v-else-if="tab === 'review'" class="space-y-4">
          <UCard v-for="row in data?.posts" :key="row.post.id">
            <NuxtLink :to="scope.href(`posts/${row.post.id}`)" class="font-medium text-primary">{{ row.post.title || '动态' }}</NuxtLink>
            <p class="mt-2 line-clamp-3 text-sm text-text-secondary">{{ row.post.content }}</p>
            <p class="mt-2 text-xs text-text-muted">{{ row.author.username }} · {{ row.post.status }}</p>
            <div v-if="writable" class="mt-3 flex gap-2"><UButton variant="outline" :disabled="pending" @click="review('posts',row.post.id,'published')">公开帖子</UButton><UButton color="warning" variant="outline" :disabled="pending" @click="review('posts',row.post.id,'hidden')">隐藏帖子</UButton></div>
          </UCard>
          <UCard v-for="row in data?.comments" :key="row.comment.id">
            <NuxtLink :to="scope.href(`posts/${row.comment.post_id}`)" class="text-primary">查看原帖</NuxtLink>
            <p class="mt-2 whitespace-pre-wrap text-sm">{{ row.comment.content }}</p>
            <div v-if="writable" class="mt-3 flex gap-2"><UButton variant="outline" :disabled="pending" @click="review('comments',row.comment.id,'published')">通过评论</UButton><UButton color="warning" variant="outline" :disabled="pending" @click="review('comments',row.comment.id,'hidden')">隐藏评论</UButton></div>
          </UCard>
          <p v-if="!data?.posts.length && !data?.comments.length" class="text-text-muted">暂无待查看内容。</p>
        </div>
        <div v-else class="space-y-4">
          <UCard v-for="row in data?.reports" :key="row.report.id">
            <NuxtLink :to="scope.href(`reports/${row.report.id}`)" class="font-medium text-primary">{{ row.report.category }} · {{ row.report.status }}</NuxtLink>
            <p class="mt-2 whitespace-pre-wrap text-sm">{{ row.report.reason }}</p>
            <UButton v-if="writable && row.report.status === 'pending'" class="mt-3" variant="outline" @click="selectedReport = row; resolution = ''">处理举报</UButton>
          </UCard>
          <p v-if="!data?.reports.length" class="text-text-muted">暂无举报。</p>
          <form v-if="selectedReport" class="space-y-3 rounded border border-border p-4" @submit.prevent="resolveReport('resolved')">
            <h2 class="font-semibold">处理举报</h2>
            <UTextarea v-model="resolution" class="w-full" placeholder="填写处理说明" aria-label="举报处理说明" />
            <div class="flex gap-2"><UButton type="submit" :loading="pending" :disabled="!writable">标记已处理</UButton><UButton variant="outline" :disabled="pending || !writable" @click="resolveReport('dismissed')">驳回</UButton><UButton variant="ghost" @click="selectedReport = null">取消</UButton></div>
          </form>
        </div>
      </AsyncContent>
    </template>
  </div>
</template>
