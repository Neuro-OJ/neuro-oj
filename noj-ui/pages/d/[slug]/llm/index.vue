<script setup lang="ts">
import { workspaceCacheKey } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
import type { DomainLlmProvider, DomainLlmQuota } from '~/composables/useDomainLlm';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const { slug, can, domain } = useWorkspace();
const { user } = useAuth();
const capture = useWorkspaceActionScope();
const api = useDomainLlm();
const workspaces = useWorkspaceApi(), problems = useDomainProblems();
const key = computed(() => workspaceCacheKey(slug.value!, user.value?.id ?? null, 'llm'));
const { data, error, refresh } = await useAsyncData(key, async () => {
  if (!can('llm:manage')) return null;
  const [settings, providers, quotas] = await Promise.all([
    api.settings(slug.value!),
    api.providers(slug.value!),
    api.quotas(slug.value!),
  ]);
  return { settings: settings.data, providers: providers.data, quotas: quotas.data, caps: quotas.caps };
});
const providerId = ref('none');
const model = ref('');
let defaultsScope = '';
watch(data, (value) => {
  if (value && defaultsScope !== key.value) {
    providerId.value = value.settings.provider_id ?? 'none';
    model.value = value.settings.model ?? '';
    defaultsScope = key.value;
  }
}, { immediate: true });
const modal = ref(false);
const editing = ref<string | null>(null);
const providerRevision = ref(0);
const form = reactive({ name: '', base_url: '', api_key: '', cost_per_1k_tokens: 0, enabled: true });
const quota = reactive({
  id: undefined as string | undefined,
  revision: 0,
  scope_type: 'domain' as DomainLlmQuota['scope_type'],
  user: 'none',
  problem: 'none',
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
const memberPage = ref(1), problemPage = ref(1), problemSearch = ref(''), problemKeyword = ref('');
const members = await useAsyncData(
  () => `${key.value}:members:${memberPage.value}`,
  () =>
    can('llm:manage') && can('domain:members')
      ? workspaces.members(slug.value!, memberPage.value)
      : Promise.resolve(null),
);
const problemChoices = await useAsyncData(
  () => `${key.value}:problems:${problemPage.value}:${problemKeyword.value}`,
  () => can('llm:manage') ? problems.list(slug.value!, problemPage.value, problemKeyword.value) : Promise.resolve(null),
);
watch(problemKeyword, () => {
  problemPage.value = 1;
});
const needsUser = computed(() => ['user', 'user_problem'].includes(quota.scope_type));
const needsProblem = computed(() => ['problem', 'user_problem'].includes(quota.scope_type));
const userOptions = computed(() => {
  const options = (members.data.value?.data ?? []).filter((member) => member.status === 'active').map((member) => ({
    label: member.username,
    value: member.user_id,
  }));
  if (quota.user !== 'none' && !options.some((option) => option.value === quota.user)) {
    options.push({ label: '此前选择的用户（当前页之外）', value: quota.user });
  }
  return [{ label: '选择域内用户', value: 'none' }, ...options];
});
const problemOptions = computed(() => {
  const options = (problemChoices.data.value?.items ?? []).map((problem) => ({
    label: `${problem.reference.display_ref} · ${problem.title}`,
    value: problem.reference.problem_id,
  }));
  if (quota.problem !== 'none' && !options.some((option) => option.value === quota.problem)) {
    options.push({ label: '此前选择的题目（当前页之外）', value: quota.problem });
  }
  return [{ label: '选择域内绑定题目', value: 'none' }, ...options];
});
function quotaTarget(item: DomainLlmQuota) {
  if (item.scope_type === 'domain') return '全域';
  const [userId, problemId] = item.scope_type === 'user_problem' ? item.scope_id.split(':') : [
    item.scope_type === 'user' ? item.scope_id : undefined,
    item.scope_type === 'problem' ? item.scope_id : undefined,
  ];
  const username = members.data.value?.data.find((member) => member.user_id === userId)?.username;
  const reference = problemChoices.data.value?.items.find((problem) => problem.reference.problem_id === problemId)
    ?.reference.display_ref;
  return [userId ? username ?? '当前成员页之外的用户' : null, problemId ? reference ?? '当前题目页之外的题目' : null]
    .filter(Boolean).join(' × ');
}
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
async function reloadLists() {
  const scope = capture();
  failure.value = '';
  try {
    const [providers, quotas] = await Promise.all([api.providers(scope.slug), api.quotas(scope.slug)]);
    if (scope.isCurrent() && data.value) {
      data.value = { ...data.value, providers: providers.data, quotas: quotas.data, caps: quotas.caps };
    }
  } catch (error) {
    if (scope.isCurrent()) failure.value = extractApiError(error).message;
  }
}
async function reloadSettings() {
  const scope = capture();
  failure.value = '';
  try {
    const response = await api.settings(scope.slug);
    if (scope.isCurrent() && data.value) {
      data.value = { ...data.value, settings: response.data };
      providerId.value = response.data.provider_id ?? 'none';
      model.value = response.data.model ?? '';
    }
  } catch (error) {
    if (scope.isCurrent()) failure.value = extractApiError(error).message;
  }
}
async function write(operation: (target: string) => Promise<unknown>, section: 'settings' | 'providers' | 'quotas') {
  if (busy.value || !writable.value) return;
  const scope = capture();
  busy.value = true;
  failure.value = '';
  try {
    const saved = await operation(scope.slug);
    if (scope.isCurrent()) {
      if (section === 'providers') {
        form.api_key = '';
        modal.value = false;
        const response = await api.providers(scope.slug);
        if (scope.isCurrent() && data.value) data.value = { ...data.value, providers: response.data };
      } else if (section === 'quotas') {
        const row = (saved as { data: { id: string; revision: number } }).data;
        quota.id = row.id;
        quota.revision = row.revision;
        const response = await api.quotas(scope.slug);
        if (scope.isCurrent() && data.value) {
          data.value = { ...data.value, quotas: response.data, caps: response.caps };
        }
      } else {
        const response = saved as { data: Awaited<ReturnType<typeof api.settings>>['data'] };
        if (scope.isCurrent() && data.value) data.value = { ...data.value, settings: response.data };
      }
    }
  } catch (e) {
    if (scope.isCurrent()) failure.value = extractApiError(e).message;
  } finally {
    if (scope.isCurrent()) busy.value = false;
  }
}
function edit(provider?: DomainLlmProvider) {
  editing.value = provider?.id ?? null;
  providerRevision.value = provider?.revision ?? 0;
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
  return write(
    (target) =>
      editing.value
        ? api.updateProvider(
          target,
          editing.value,
          { ...form, ...(form.api_key ? {} : { api_key: undefined }) },
          providerRevision.value,
        )
        : api.provider(target, { ...form }),
    'providers',
  );
}
function limit(value: string) {
  return value.trim() ? Number(value) : null;
}
function editQuota(value: DomainLlmQuota) {
  const [userId, problemId] = value.scope_type === 'user_problem'
    ? value.scope_id.split(':')
    : [value.scope_type === 'user' ? value.scope_id : 'none', value.scope_type === 'problem' ? value.scope_id : 'none'];
  Object.assign(quota, {
    id: value.id,
    revision: value.revision,
    scope_type: value.scope_type,
    user: userId,
    problem: problemId,
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
      scope_id: quota.scope_type === 'domain'
        ? ''
        : quota.scope_type === 'user'
        ? quota.user
        : quota.scope_type === 'problem'
        ? quota.problem
        : `${quota.user}:${quota.problem}`,
      window_type: quota.window_type,
      max_calls: limit(quota.calls),
      max_tokens: limit(quota.tokens),
      max_cost: limit(quota.cost),
    }, quota.revision), 'quotas');
}
function newQuota() {
  Object.assign(quota, {
    id: undefined,
    revision: 0,
    scope_type: 'domain',
    user: 'none',
    problem: 'none',
    window_type: 'day',
    calls: '',
    tokens: '',
    cost: '',
  });
}
watch(key, () => {
  modal.value = false;
  editing.value = null;
  providerRevision.value = 0;
  form.api_key = '';
  failure.value = '';
  busy.value = false;
  defaultsScope = '';
  providerId.value = 'none';
  model.value = '';
  newQuota();
  memberPage.value = problemPage.value = page.value = 1;
  usageUser.value = usageProblem.value = '';
});
useSeoMeta({ title: '空间 LLM 配置' });
</script>
<template>
  <div v-if="can('llm:manage')" class="space-y-5">
    <div class="flex flex-wrap justify-between gap-3">
      <h2 class="text-xl font-semibold">LLM 配置与用量</h2>
      <UButton variant="outline" :disabled="busy" @click="reloadLists">重新读取 Provider 与额度列表</UButton>
    </div>
    <UAlert v-if="error" color="error" :title="extractApiError(error).message">
      <template #actions>
        <UButton @click="refresh()">重试</UButton>
      </template>
    </UAlert>
    <UAlert v-if="failure" color="error" :title="failure"
      description="原输入和编辑依据仍保留；冲突时重新读取对应资源，再显式打开编辑。" />
    <UCard v-if="data">
      <h3 class="mb-3 font-semibold">本域默认 Provider 和模型</h3>
      <p class="mb-4 text-sm text-text-secondary">共享题使用本域模型、密钥及额度。未配置时无法创建 LLM 评测。</p>
      <div class="flex flex-wrap gap-3">
        <USelect v-model="providerId"
          :items="[{ value: 'none', label: '未配置' }, ...data.providers.filter((provider) => provider.enabled).map((provider) => ({ value: provider.id, label: provider.name }))]"
          :disabled="!writable || busy" class="min-w-48" aria-label="默认 Provider" />
        <UInput v-model="model" :disabled="!writable || providerId === 'none' || busy" placeholder="模型标识"
          aria-label="默认模型" />
        <UButton :loading="busy" :disabled="!writable || providerId !== 'none' && !model.trim()"
          @click="write((target) => api.saveSettings(target, providerId === 'none' ? null : providerId, providerId === 'none' ? null : model.trim(), data!.settings.revision), 'settings')">保存默认配置</UButton>
        <UButton variant="ghost" :disabled="busy" @click="reloadSettings">重新读取默认配置</UButton>
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
            @click="write((target) => api.updateProvider(target, provider.id, { enabled: !provider.enabled }, provider.revision), 'providers')">{{ provider.enabled ? '停用' : '启用' }}</UButton>
        </div>
      </div>
    </UCard>
    <UCard v-if="data">
      <h3 class="mb-3 font-semibold">配额</h3>
      <form class="grid gap-3 sm:grid-cols-3" @submit.prevent="saveQuota">
        <USelect v-model="quota.scope_type"
          :items="[{ value: 'domain', label: '全域' }, { value: 'user', label: '域内用户' }, { value: 'problem', label: '域内源题' }, { value: 'user_problem', label: '用户 × 源题' }]"
          :disabled="!writable || busy" aria-label="配额作用域" />
        <USelect v-if="needsUser" v-model="quota.user" :items="userOptions" :disabled="!writable || busy"
          aria-label="配额用户" />
        <USelect v-if="needsProblem" v-model="quota.problem" :items="problemOptions" :disabled="!writable || busy"
          aria-label="配额来源题目" />
        <USelect v-model="quota.window_type"
          :items="[{ value: 'day', label: '每天' }, { value: 'month', label: '每月' }]" :disabled="!writable || busy"
          aria-label="配额窗口" />
        <UInput v-model="quota.calls" type="number" min="0" placeholder="调用次数，空为不限"
          :disabled="!writable || busy"
          aria-label="调用次数上限" />
        <UInput v-model="quota.tokens" type="number" min="0" placeholder="Token，空为不限" :disabled="!writable || busy"
          aria-label="Token上限" />
        <UInput v-model="quota.cost" type="number" min="0" step="1" placeholder="费用整数额度，空为不限"
          :disabled="!writable || busy"
          aria-label="费用整数上限" />
        <UButton type="submit"
          :disabled="!writable || needsUser && quota.user === 'none' || needsProblem && quota.problem === 'none'"
          :loading="busy">{{ quota.id ? '更新配额' : '新增配额' }}</UButton>
        <UButton type="button" variant="ghost" :disabled="busy" @click="newQuota">切换为新增</UButton>
      </form>
      <div v-if="needsUser" class="mt-3 flex flex-wrap items-center gap-3">
        <UAlert v-if="members.error.value" color="error" :title="extractApiError(members.error.value).message" />
        <UButton variant="ghost" :disabled="memberPage <= 1" @click="memberPage--">上一页成员</UButton><span class="text-xs tabular-nums">成员第 {{ memberPage }} 页</span><UButton variant="ghost" :disabled="(members.data.value?.data.length ?? 0) < 100" @click="memberPage++">下一页成员</UButton>
      </div>
      <form v-if="needsProblem" class="mt-3 flex flex-wrap items-center gap-3"
        @submit.prevent="problemKeyword = problemSearch.trim()">
        <UAlert v-if="problemChoices.error.value" color="error" :title="extractApiError(problemChoices.error.value).message" />
        <UInput v-model="problemSearch" placeholder="来源题号或标题" aria-label="搜索配额题目" /><UButton type="submit" variant="ghost">搜索题目</UButton>
        <UButton type="button" variant="ghost" :disabled="problemPage <= 1" @click="problemPage--">上一页题目</UButton><span class="text-xs tabular-nums">题目第 {{ problemPage }} 页</span><UButton type="button" variant="ghost" :disabled="problemPage * 30 >= (problemChoices.data.value?.total ?? 0)" @click="problemPage++">下一页题目</UButton>
      </form>
      <p
        class="mt-3 text-xs text-text-muted tabular-nums">{{ quota.window_type === 'day' ? '每日' : '每月' }}实例允许上限：{{ data.caps[quota.window_type].max_calls ?? '不限' }} 次 / {{ data.caps[quota.window_type].max_tokens ?? '不限' }} Token / {{ data.caps[quota.window_type].max_cost ?? '不限' }} 费用整数。域总额度只能降低，提高需平台治理权限。</p>
      <p
        class="mt-3 text-xs text-text-muted">费用额度与 Provider 单价采用同一单位，使用整数；实际用量按上游返回结算，调用前预估与上游账单可能存在差异。</p>
      <div v-for="item in data.quotas" :key="item.id"
        class="mt-3 flex items-center justify-between border-t border-border pt-3 text-sm"><span>{{ quotaTarget(item) }} · {{ item.window_type === 'day' ? '每日' : '每月' }}：{{ item.max_calls ?? '不限' }} 次 / {{ item.max_tokens ?? '不限' }} Token / {{ item.max_cost ?? '不限' }} 费用</span><UButton variant="ghost" @click="editQuota(item)">编辑配额</UButton></div>
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
