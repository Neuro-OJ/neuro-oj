<script setup lang="ts">
import { workspaceCacheKey } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
import type { DomainLlmProvider, DomainLlmQuota } from '~/composables/useDomainLlm';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const { slug, can, domain } = useWorkspace();
const { user } = useAuth();
const capture = useWorkspaceActionScope();
const api = useDomainLlm();
const key = computed(() => workspaceCacheKey(slug.value!, user.value?.id ?? null, 'llm'));
const { data, error, refresh } = await useAsyncData(key, async () => {
  if (!can('llm:manage')) return null;
  const [settings, providers, quotas] = await Promise.all([
    api.settings(slug.value!),
    api.providers(slug.value!),
    api.quotas(slug.value!),
  ]);
  return { settings: settings.data, providers: providers.data, quotas: quotas.data };
});
const providerId = ref('none');
const model = ref('');
watch(data, (value) => {
  providerId.value = value?.settings.provider_id ?? 'none';
  model.value = value?.settings.model ?? '';
}, { immediate: true });
const modal = ref(false);
const editing = ref<string | null>(null);
const form = reactive({ name: '', base_url: '', api_key: '', cost_per_1k_tokens: 0, enabled: true });
const quota = reactive({
  id: undefined as string | undefined,
  scope_type: 'domain' as DomainLlmQuota['scope_type'],
  scope_id: '',
  window_type: 'day' as DomainLlmQuota['window_type'],
  calls: '',
  tokens: '',
  cost: '',
});
const busy = ref(false);
const failure = ref('');
const page = ref(1);
const usageUser = ref('');
const usageProblem = ref('');
const { data: usage, error: usageError, refresh: refreshUsage } = await useAsyncData(
  computed(() => `${key.value}:usage:${page.value}:${usageUser.value}:${usageProblem.value}`),
  () =>
    can('llm:manage')
      ? api.usage(slug.value!, {
        page: page.value,
        user_id: usageUser.value || undefined,
        problem_id: usageProblem.value || undefined,
      })
      : Promise.resolve(null),
);
const writable = computed(() => domain.value?.status === 'active' && can('llm:manage'));
async function write(operation: (target: string) => Promise<unknown>) {
  if (busy.value || !writable.value) return;
  const scope = capture();
  busy.value = true;
  failure.value = '';
  try {
    await operation(scope.slug);
    if (scope.isCurrent()) {
      form.api_key = '';
      modal.value = false;
      await refresh();
    }
  } catch (e) {
    if (scope.isCurrent()) failure.value = extractApiError(e).message;
  } finally {
    if (scope.isCurrent()) busy.value = false;
  }
}
function edit(provider?: DomainLlmProvider) {
  editing.value = provider?.id ?? null;
  Object.assign(form, {
    name: provider?.name ?? '',
    base_url: provider?.base_url ?? '',
    api_key: '',
    cost_per_1k_tokens: provider?.cost_per_1k_tokens ?? 0,
    enabled: provider?.enabled ?? true,
  });
  modal.value = true;
}
function saveProvider() {
  return write((target) =>
    editing.value
      ? api.updateProvider(target, editing.value, { ...form, ...(form.api_key ? {} : { api_key: undefined }) })
      : api.provider(target, { ...form })
  );
}
function limit(value: string) {
  return value.trim() ? Number(value) : null;
}
function editQuota(value: DomainLlmQuota) {
  Object.assign(quota, {
    id: value.id,
    scope_type: value.scope_type,
    scope_id: value.scope_id,
    window_type: value.window_type,
    calls: value.max_calls == null ? '' : String(value.max_calls),
    tokens: value.max_tokens == null ? '' : String(value.max_tokens),
    cost: value.max_cost == null ? '' : String(value.max_cost),
  });
}
function saveQuota() {
  return write((target) =>
    api.saveQuota(target, {
      id: quota.id,
      scope_type: quota.scope_type,
      scope_id: quota.scope_id,
      window_type: quota.window_type,
      max_calls: limit(quota.calls),
      max_tokens: limit(quota.tokens),
      max_cost: limit(quota.cost),
    })
  );
}
useSeoMeta({ title: '空间 LLM 配置' });
</script>
<template>
  <div v-if="can('llm:manage')" class="space-y-5">
    <h2 class="text-xl font-semibold">LLM 配置与用量</h2>
    <UAlert v-if="error" color="error" :title="extractApiError(error).message">
      <template #actions>
        <UButton @click="refresh()">重试</UButton>
      </template>
    </UAlert>
    <UAlert v-if="failure" color="error" :title="failure" />
    <UCard v-if="data">
      <h3 class="mb-3 font-semibold">本域默认 Provider 和模型</h3>
      <p class="mb-4 text-sm text-text-secondary">共享题使用本域模型、密钥及额度。未配置时无法创建 LLM 评测。</p>
      <div class="flex flex-wrap gap-3">
        <USelect v-model="providerId"
          :items="[{ value: 'none', label: '未配置' }, ...data.providers.filter((provider) => provider.enabled).map((provider) => ({ value: provider.id, label: provider.name }))]"
          :disabled="!writable" class="min-w-48" aria-label="默认 Provider" />
        <UInput v-model="model" :disabled="!writable || providerId === 'none'" placeholder="模型标识"
          aria-label="默认模型" />
        <UButton :loading="busy" :disabled="!writable || providerId !== 'none' && !model.trim()"
          @click="write((target) => api.saveSettings(target, providerId === 'none' ? null : providerId, providerId === 'none' ? null : model.trim(), data!.settings.revision))">保存默认配置</UButton>
      </div>
    </UCard>
    <UCard v-if="data">
      <div class="mb-4 flex justify-between">
        <h3 class="font-semibold">Provider</h3>
        <UButton :disabled="!writable" @click="edit()">新增 Provider</UButton>
      </div>
      <div v-for="provider in data.providers" :key="provider.id"
        class="flex flex-wrap justify-between gap-3 border-t border-border py-3">
        <div>
          <p>{{ provider.name }} <UBadge color="neutral" variant="subtle">{{ provider.enabled ? '启用' : '停用' }}</UBadge></p>
          <p class="mt-1 text-xs text-text-muted">{{ provider.base_url }} · {{ provider.api_key_masked }}</p>
        </div>
        <div class="flex gap-2">
          <UButton variant="outline" :disabled="!writable" @click="edit(provider)">编辑</UButton>
          <UButton variant="ghost" color="neutral" :disabled="!writable || busy"
            @click="write((target) => api.updateProvider(target, provider.id, { enabled: !provider.enabled }))">{{ provider.enabled ? '停用' : '启用' }}</UButton>
        </div>
      </div>
    </UCard>
    <UCard v-if="data">
      <h3 class="mb-3 font-semibold">配额</h3>
      <form class="grid gap-3 sm:grid-cols-3" @submit.prevent="saveQuota">
        <USelect v-model="quota.scope_type"
          :items="[{ value: 'domain', label: '全域' }, { value: 'user', label: '域内用户' }, { value: 'problem', label: '域内源题' }, { value: 'user_problem', label: '用户 × 源题' }]"
          aria-label="配额作用域" />
        <UInput v-model="quota.scope_id" :disabled="quota.scope_type === 'domain'"
          placeholder="对象 ID；组合用 用户ID:题目ID" aria-label="配额对象" />
        <USelect v-model="quota.window_type"
          :items="[{ value: 'day', label: '每天' }, { value: 'month', label: '每月' }]" aria-label="配额窗口" />
        <UInput v-model="quota.calls" type="number" min="0" placeholder="调用次数，空为不限"
          aria-label="调用次数上限" />
        <UInput v-model="quota.tokens" type="number" min="0" placeholder="Token，空为不限" aria-label="Token上限" />
        <UInput v-model="quota.cost" type="number" min="0" step="any" placeholder="费用，空为不限"
          aria-label="费用上限" />
        <UButton type="submit" :disabled="!writable" :loading="busy">{{ quota.id ? '更新配额' : '新增配额' }}</UButton>
        <UButton type="button" variant="ghost" @click="quota.id = undefined">切换为新增</UButton>
      </form>
      <p class="mt-3 text-xs text-text-muted">实际用量按上游返回结算；调用前预估与上游账单可能存在差异。</p>
      <div v-for="item in data.quotas" :key="item.id"
        class="mt-3 flex items-center justify-between border-t border-border pt-3 text-sm"><span>{{ item.scope_type }} · {{ item.scope_id }} · {{ item.window_type }}：{{ item.max_calls ?? '不限' }} 次 / {{ item.max_tokens ?? '不限' }} Token / {{ item.max_cost ?? '不限' }} 费用</span><UButton variant="ghost" @click="editQuota(item)">编辑</UButton></div>
    </UCard>
    <UCard>
      <h3 class="mb-3 font-semibold">本域用量</h3>
      <div class="mb-3 flex gap-3">
        <UInput v-model="usageUser" placeholder="用户 ID" aria-label="按用户筛选用量" @update:model-value="page = 1" />
        <UInput v-model="usageProblem" placeholder="源题 ID" aria-label="按题筛选用量" @update:model-value="page = 1" />
        <UButton variant="ghost" icon="i-lucide-refresh-cw" aria-label="刷新用量" @click="refreshUsage()" />
      </div>
      <UAlert v-if="usageError" color="error" :title="extractApiError(usageError).message" />
      <div v-for="entry in usage?.data" :key="entry.id"
        class="border-t border-border py-2 text-sm tabular-nums">{{ new Date(entry.created_at).toLocaleString() }} · {{ entry.model }} · {{ entry.total_tokens }} Token · 估算费用 {{ entry.estimated_cost }} · {{ entry.status }}</div>
      <div
        class="mt-3 flex gap-3"><UButton variant="ghost" :disabled="page <= 1" @click="page--">上一页</UButton><span class="tabular-nums">{{ page }}</span><UButton variant="ghost" :disabled="(usage?.data.length ?? 0) < 30" @click="page++">下一页</UButton></div>
    </UCard>
    <UModal v-model:open="modal" :title="editing ? '编辑 Provider' : '新增 Provider'">
      <template #body>
        <form class="space-y-4" @submit.prevent="saveProvider">
          <AdminFormField label="名称">
            <UInput v-model="form.name" required class="w-full" />
          </AdminFormField>
          <AdminFormField label="Base URL">
            <UInput v-model="form.base_url" type="url" required class="w-full" />
          </AdminFormField>
          <AdminFormField label="API Key" :hint="editing ? '留空保留现有密钥' : '仅写入加密存储'">
            <UInput v-model="form.api_key" type="password" autocomplete="new-password" :required="!editing"
              class="w-full" />
          </AdminFormField>
          <AdminFormField label="每 1000 Token 费用">
            <UInput v-model.number="form.cost_per_1k_tokens" type="number" min="0" step="any" />
          </AdminFormField>
          <UCheckbox v-model="form.enabled" label="启用" />
          <UButton type="submit" :loading="busy">保存</UButton>
        </form>
      </template>
    </UModal>
  </div>
  <UAlert v-else color="warning" title="没有当前域 LLM 管理权限" />
</template>
