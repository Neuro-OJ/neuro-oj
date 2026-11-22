<script setup lang="ts">
import { extractApiError } from '~/utils/apiError';
import { workspaceCacheKey } from '~/utils/workspace';
const props = defineProps<{ slug: string; disabled?: boolean }>();
const selected = defineModel<string[]>({ required: true });
const api = useDomainProblems(), { user } = useAuth(), capture = useWorkspaceActionScope();
const page = ref(1), keyword = ref(''), entered = ref(''), reference = ref(''), adding = ref(false), failure = ref('');
const { data, error, status, refresh } = await useAsyncData(
  () => workspaceCacheKey(props.slug, user.value?.id ?? null, 'problem-chooser', String(page.value), keyword.value),
  () => api.list(props.slug, page.value, keyword.value),
);
function search() {
  page.value = 1;
  keyword.value = entered.value.trim();
}
function add(ref: string) {
  if (!selected.value.includes(ref)) selected.value = [...selected.value, ref];
}
async function addReference() {
  if (props.disabled || adding.value || !reference.value.trim()) return;
  const scope = capture();
  adding.value = true;
  failure.value = '';
  try {
    const result = await api.detail(scope.slug, reference.value.trim());
    if (scope.isCurrent()) {
      add(result.reference.display_ref);
      reference.value = '';
    }
  } catch (error) {
    if (scope.isCurrent()) failure.value = extractApiError(error).message;
  } finally {
    if (scope.isCurrent()) adding.value = false;
  }
}
function move(index: number, delta: number) {
  const target = index + delta;
  if (target < 0 || target >= selected.value.length) return;
  const next = [...selected.value];
  [next[index], next[target]] = [next[target]!, next[index]!];
  selected.value = next;
}
</script>
<template>
  <section class="space-y-4">
    <h3 class="font-semibold">题目与顺序</h3>
    <div v-for="(ref, index) in selected" :key="ref" class="flex flex-wrap items-center gap-2">
      <span class="mr-auto font-mono text-sm">{{ index + 1 }}. {{ ref }}</span>
      <UButton type="button" size="xs" variant="ghost" :disabled="disabled || index === 0"
        @click="move(index, -1)">上移</UButton>
      <UButton type="button" size="xs" variant="ghost" :disabled="disabled || index === selected.length - 1"
        @click="move(index, 1)">下移</UButton>
      <UButton type="button" size="xs" color="error" variant="ghost" :disabled="disabled"
        @click="selected = selected.filter(item => item !== ref)">移除</UButton>
    </div>
    <div class="flex gap-2">
      <UInput v-model="reference" placeholder="本域题号或已引用来源题号，如 main:1001" class="grow"
        :disabled="disabled" />
      <UButton type="button" variant="outline" :loading="adding" :disabled="disabled"
        @click="addReference">按题号添加</UButton>
    </div>
    <UAlert v-if="failure" color="error" :title="failure" />
    <div class="flex gap-2">
      <UInput v-model="entered" placeholder="搜索当前域题库" class="grow" @keydown.enter.prevent="search" />
      <UButton type="button" variant="outline" @click="search">搜索</UButton>
    </div>
    <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : data?.items.length ? 'data' : 'empty'"
      :error="error ? extractApiError(error).message : undefined" @retry="refresh()">
      <div class="max-h-80 divide-y divide-border overflow-auto">
        <div v-for="item in data?.items" :key="item.binding_id"
          class="flex items-center justify-between gap-3 py-2 text-sm"><span><span class="mr-2 font-mono">{{ item.reference.display_ref }}</span>{{ item.title }}</span><UButton type="button" size="xs" variant="outline" :disabled="disabled || selected.includes(item.reference.display_ref)" @click="add(item.reference.display_ref)">{{ selected.includes(item.reference.display_ref) ? '已选' : '添加' }}</UButton></div>
      </div>
      <PaginationNav :current-page="page" :total-pages="Math.ceil((data?.total ?? 0) / 30)"
        @page-change="page = $event" />
    </AsyncContent>
  </section>
</template>
