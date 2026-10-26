<script setup lang="ts">
import type { DomainLlmModelAlias, DomainLlmProvider } from '~/composables/useDomainLlm';
import { workspaceCacheKey } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
const props = defineProps<{ slug: string; providers: DomainLlmProvider[]; writable: boolean }>();
const { user } = useAuth(), api = useDomainLlm(), capture = useWorkspaceActionScope(), { dialog } = useDialog();
const { data, error, refresh } = await useAsyncData(
  () => workspaceCacheKey(props.slug, user.value?.id ?? null, 'llm-aliases'),
  () => api.aliases(props.slug),
);
const form = reactive({ alias: '', provider_id: '', model: '', description: '', revision: 0 });
const editing = ref(false), busy = ref(false), failure = ref('');
const providers = computed(() => props.providers.map((item) => ({ label: item.name, value: item.id })));
function edit(row?: DomainLlmModelAlias) {
  editing.value = !!row;
  Object.assign(form, row ?? { alias: '', provider_id: '', model: '', description: '', revision: 0 });
  failure.value = '';
}
async function save() {
  if (!props.writable || busy.value) return;
  const scope = capture();
  busy.value = true;
  failure.value = '';
  try {
    await api.saveAlias(scope.slug, form.alias.trim(), {
      provider_id: form.provider_id, model: form.model.trim(), description: form.description.trim(),
    }, form.revision);
    if (!scope.isCurrent()) return;
    edit();
    await refresh();
  } catch (error) {
    if (scope.isCurrent()) failure.value = extractApiError(error).message;
  } finally {
    if (scope.isCurrent()) busy.value = false;
  }
}
async function remove(row: DomainLlmModelAlias) {
  if (!props.writable || busy.value) return;
  const scope = capture();
  if (!await dialog.confirm(
    row.problem_count ? `此别名被 ${row.problem_count} 道本域题引用。删除后新尝试无法解析该能力，确认删除「${row.alias}」？` : `删除本域模型别名「${row.alias}」？`,
    { title: '删除模型别名', danger: true },
  ) || !scope.isCurrent()) return;
  busy.value = true;
  failure.value = '';
  try {
    await api.deleteAlias(scope.slug, row.alias, row.revision, row.problem_count > 0);
    if (scope.isCurrent()) await refresh();
  } catch (error) {
    if (scope.isCurrent()) failure.value = extractApiError(error).message;
  } finally {
    if (scope.isCurrent()) busy.value = false;
  }
}
</script>
<template>
  <UCard>
    <div class="flex items-center justify-between gap-3">
      <h3 class="font-semibold">本域模型别名</h3>
      <UButton variant="ghost" @click="refresh()">重新读取</UButton>
    </div>
    <p class="mt-2 text-xs text-text-muted">default 使用本域默认模型；题目声明能力别名，实际 Provider 与模型仅由使用域决定。</p>
    <UAlert v-if="error || failure" color="error" :title="failure || extractApiError(error).message" class="mt-3" />
    <form class="mt-4 grid gap-3 sm:grid-cols-2" @submit.prevent="save">
      <AdminFormField label="别名">
        <UInput v-model="form.alias" :disabled="editing || !writable || busy" pattern="[a-z][a-z0-9_-]*" required aria-label="模型能力别名" />
      </AdminFormField>
      <AdminFormField label="本域 Provider">
        <USelect v-model="form.provider_id" :items="providers" :disabled="!writable || busy" aria-label="别名 Provider" />
      </AdminFormField>
      <AdminFormField label="实际模型">
        <UInput v-model="form.model" :disabled="!writable || busy" required aria-label="别名实际模型" />
      </AdminFormField>
      <AdminFormField label="能力说明">
        <UInput v-model="form.description" :disabled="!writable || busy" maxlength="80" aria-label="别名能力说明" />
      </AdminFormField>
      <div class="flex gap-3">
        <UButton type="submit" :loading="busy" :disabled="!writable || !form.provider_id || !form.alias.trim() || form.alias === 'default'">{{ editing ? '保存别名' : '新增别名' }}</UButton>
        <UButton type="button" variant="ghost" :disabled="busy" @click="edit()">切换为新增</UButton>
      </div>
    </form>
    <div v-for="row in data?.data" :key="row.alias" class="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3 text-sm">
      <span><span class="font-mono">{{ row.alias }}</span> · {{ providers.find(item => item.value === row.provider_id)?.label }} · {{ row.model }} · {{ row.description }}</span>
      <div class="flex gap-2">
        <UButton variant="ghost" :disabled="!writable || busy" @click="edit(row)">编辑别名</UButton>
        <UButton variant="ghost" color="error" :disabled="!writable || busy" @click="remove(row)">删除别名</UButton>
      </div>
    </div>
  </UCard>
</template>
