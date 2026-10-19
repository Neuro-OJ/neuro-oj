<script setup lang="ts">
import type { AnnotationDetail } from '~/utils/annotations';
import { extractApiError } from '~/utils/apiError';

definePageMeta({ layout: 'admin', middleware: 'admin' });
const { api } = useApi(), { user } = useAuth();
const slug = ref(''), thread = ref(''), reason = ref(''), page = ref(1);
const detail = ref<AnnotationDetail | null>(null), loading = ref(false), failure = ref('');
const scope = computed(() => `${user.value?.id}:${slug.value}:${thread.value}:${reason.value}`);
watch(scope, () => { detail.value = null; failure.value = ''; page.value = 1; });
async function query(nextPage = 1) {
  if (loading.value || !slug.value.trim() || !thread.value.trim() || !reason.value.trim()) return;
  const current = scope.value;
  loading.value = true; detail.value = null; failure.value = '';
  try {
    const result = await api.post<{ data: AnnotationDetail }>(`/api/v1/admin/instance/annotations/${encodeURIComponent(slug.value.trim())}/${encodeURIComponent(thread.value.trim())}/query`, { reason: reason.value.trim(), page: nextPage }, { silent: true });
    if (scope.value === current) { detail.value = result.data; page.value = nextPage; }
  } catch (error) { if (scope.value === current) failure.value = extractApiError(error).message; }
  finally { loading.value = false; }
}
useSeoMeta({ title: '批注治理查询' });
</script>
<template>
  <div class="mx-auto max-w-4xl space-y-6">
    <InstanceNav />
    <LibraryPageHeader title="批注治理查询" description="按会话 ID 处理具体问题。每次读取及翻页均记录操作者、会话和查询原因。" icon="i-lucide-notebook-pen" />
    <form class="space-y-4 rounded border border-border bg-bg-panel p-5" @submit.prevent="query()">
      <div class="grid gap-4 sm:grid-cols-2">
        <AdminFormField label="使用域标识"><UInput v-model="slug" aria-label="使用域标识" class="w-full" required :maxlength="100" /></AdminFormField>
        <AdminFormField label="批注会话 ID"><UInput v-model="thread" aria-label="批注会话 ID" class="w-full" required :maxlength="100" /></AdminFormField>
      </div>
      <AdminFormField label="治理查询原因"><UTextarea v-model="reason" aria-label="治理查询原因" class="w-full" required :maxlength="1000" placeholder="填写关联报告或需要核查的具体问题" /></AdminFormField>
      <UButton type="submit" :loading="loading" :disabled="!slug.trim() || !thread.trim() || !reason.trim()">记录原因并查询</UButton>
    </form>
    <UAlert v-if="failure" color="error" :title="failure" />
    <section v-if="detail" class="space-y-4" aria-label="已审计的批注详情">
      <div class="flex flex-wrap items-center gap-3"><UserIdentity :user="detail.author" :domain="slug" /><UBadge variant="subtle">{{ detail.visibility === 'private' ? '个人笔记' : '师生问答' }}</UBadge></div>
      <pre class="overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-bg-sunken p-3 text-sm">{{ detail.anchor.before }}<mark>{{ detail.anchor.quote }}</mark>{{ detail.anchor.after }}</pre>
      <article v-for="message in detail.messages" :key="message.id" class="space-y-2 border-t border-border pt-4">
        <UserIdentity :user="message.author" :domain="slug" size="sm" />
        <p v-if="message.withdrawn_at" class="text-sm text-text-muted">该消息已撤回</p>
        <MarkdownRenderer v-else :content="message.body ?? ''" />
      </article>
      <div class="flex justify-between gap-3"><UButton variant="outline" :disabled="loading || page <= 1" @click="query(page - 1)">上一页并记录审计</UButton><UButton variant="outline" :disabled="loading || page * detail.per_page >= detail.total" @click="query(page + 1)">下一页并记录审计</UButton></div>
    </section>
  </div>
</template>
