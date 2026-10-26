<script setup lang="ts">
import type { SearchItem } from '~/utils/search-types';
import { workspaceCacheKey } from '~/utils/workspace';
import { domainSearchHref, domainSearchReference } from '~/utils/domain-search';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ layout: 'workspace', middleware: 'workspace-context' });
const route = useRoute(), { slug } = useWorkspace(), { user } = useAuth(), api = useDomainQuery();
const router = useRouter();
const entered = ref(String(route.query.q ?? ''));
const query = computed(() => String(route.query.q ?? '').trim());
const page = computed(() => Number(route.query.page) || 1);
const type = computed<'problem' | 'contest' | 'submission' | 'announcement'>({
  get: () =>
    ['problem', 'contest', 'submission', 'announcement'].includes(String(route.query.type))
      ? route.query.type as 'problem' | 'contest' | 'submission' | 'announcement'
      : 'problem',
  set: (value) => {
    void router.push({ query: { ...route.query, type: value, page: undefined } });
  },
});
const { data, status, error, refresh } = await useAsyncData(
  () => workspaceCacheKey(slug.value!, user.value?.id ?? null, `search:${type.value}`, query.value, String(page.value)),
  () => query.value.length >= 2 ? api.search(slug.value!, query.value, type.value, page.value) : Promise.resolve(null),
);
function search() {
  void router.push({ query: { ...route.query, q: entered.value.trim(), page: undefined } });
}
watch(query, (value) => {
  entered.value = value;
});
function href(item: SearchItem): string | undefined {
  return domainSearchHref(slug.value!, item);
}
useSeoMeta({ title: '域内搜索' });
</script>
<template>
  <div class="space-y-5">
    <AdminPageHeader title="搜索当前域" description="查找当前域可访问的题目、比赛、提交与公告" />
    <form class="flex flex-wrap gap-3" @submit.prevent="search">
      <UInput v-model="entered" minlength="2" maxlength="100" placeholder="搜索关键词，至少 2 个字符" class="grow"
        aria-label="域内搜索关键词" />
      <USelect v-model="type"
        :items="[{ label: '题目', value: 'problem' }, { label: '比赛', value: 'contest' }, { label: '提交', value: 'submission' }, { label: '公告', value: 'announcement' }]"
        aria-label="搜索类型" />
      <UButton type="submit" :disabled="entered.trim().length < 2">搜索</UButton>
    </form>
    <p v-if="query.length < 2" class="text-sm text-text-muted">输入关键词查找当前域内容。</p>
    <AsyncContent v-else
      :status="error ? 'error' : status === 'pending' ? 'loading' : data?.data.items.length ? 'data' : 'empty'"
      :error="error ? extractApiError(error).message : undefined" @retry="refresh()">
      <div class="divide-y divide-border rounded border border-border">
        <div v-for="item in data?.data.items" :key="`${item.entity_type}:${item.entity_id}`" class="space-y-1 p-4">
          <NuxtLink v-if="href(item)" :to="href(item)"
            class="font-medium text-primary hover:underline"><span v-if="domainSearchReference(item)" class="mr-2 font-mono">{{ domainSearchReference(item)!.display_ref }}</span>{{ item.title }}</NuxtLink>
          <h3 v-else class="font-medium">{{ item.title }}</h3>
          <p
            class="text-xs text-text-muted">{{ { problem: '题目', contest: '比赛', submission: '提交', announcement: '公告' }[item.entity_type as 'problem' | 'contest' | 'submission' | 'announcement'] }}</p>
        </div>
      </div>
      <div
        class="mt-4 flex items-center justify-between gap-3"><UButton variant="outline" :disabled="page === 1" @click="router.push({query:{...route.query,page:page-1}})">上一页</UButton><span class="text-sm tabular-nums">第 {{ page }} 页</span><UButton variant="outline" :disabled="!data?.data.has_more" @click="router.push({query:{...route.query,page:page+1}})">下一页</UButton></div>
    </AsyncContent>
  </div>
</template>
