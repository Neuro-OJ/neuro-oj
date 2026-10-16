<script setup lang="ts">
import { workspaceCacheKey, workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
import type { DomainLlmProvider } from '~/composables/useDomainLlm';
import DomainLlmAliases from '~/components/feature/DomainLlmAliases.vue';

definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const { slug, can, domain } = useWorkspace();
const { user } = useAuth();
const capture = useWorkspaceActionScope();
const api = useDomainLlm();

const key = computed(() => workspaceCacheKey(slug.value!, user.value?.id ?? null, 'llm-settings'));
const { data, error, refresh } = await useAsyncData(key, async () => {
  if (!can('llm:manage')) return null;
  const [settings, providers] = await Promise.all([
    api.settings(slug.value!),
    api.providers(slug.value!),
  ]);
  return { settings: settings.data, providers: providers.data };
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

const writable = computed(() => domain.value?.status === 'active' && can('llm:manage'));
const busy = ref(false);
const failure = ref('');

const modal = ref(false);
const editing = ref<string | null>(null);
const providerRevision = ref(0);
const form = reactive({
  name: '',
  base_url: '',
  api_key: '',
  cost_per_1k_tokens: 0,
  enabled: true,
  rpm_limit: 0,
  tpm_limit: 0,
});

const testModal = ref(false);
const testProvider = shallowRef<DomainLlmProvider | null>(null);
const testModel = ref('');
const testing = ref(false);
const testFailure = ref('');
const testResult = shallowRef<Awaited<ReturnType<typeof api.testProvider>>['data'] | null>(null);

watch(key, () => {
  modal.value = false;
  testModal.value = false;
  testProvider.value = null;
  testModel.value = '';
  testFailure.value = '';
  testResult.value = null;
  testing.value = false;
  editing.value = null;
  providerRevision.value = 0;
  form.api_key = '';
  failure.value = '';
});

function openTest(provider: DomainLlmProvider) {
  testProvider.value = provider;
  testModel.value = data.value?.settings.model ?? '';
  testResult.value = null;
  testFailure.value = '';
  testModal.value = true;
}

async function runTest() {
  if (!writable.value || testing.value || !testProvider.value || !testModel.value.trim()) return;
  const scope = capture(), id = testProvider.value.id;
  testing.value = true;
  testFailure.value = '';
  testResult.value = null;
  try {
    const response = await api.testProvider(scope.slug, id, testModel.value.trim());
    if (scope.isCurrent()) testResult.value = response.data;
  } catch (err) {
    if (scope.isCurrent()) testFailure.value = extractApiError(err).message;
  } finally {
    if (scope.isCurrent()) testing.value = false;
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
    rpm_limit: provider?.rpm_limit ?? 0,
    tpm_limit: provider?.tpm_limit ?? 0,
  });
  modal.value = true;
}

async function saveProvider() {
  if (![form.rpm_limit, form.tpm_limit].every((val) => Number.isSafeInteger(val) && val >= 0)) {
    failure.value = 'RPM / TPM 上限必须为非负整数，0 表示不限';
    return;
  }
  if (busy.value || !writable.value) return;
  const scope = capture();
  busy.value = true;
  failure.value = '';
  try {
    if (editing.value) {
      await api.updateProvider(
        scope.slug,
        editing.value,
        { ...form, ...(form.api_key ? {} : { api_key: undefined }) },
        providerRevision.value,
      );
    } else {
      await api.provider(scope.slug, { ...form });
    }
    if (scope.isCurrent()) {
      form.api_key = '';
      modal.value = false;
      const response = await api.providers(scope.slug);
      if (scope.isCurrent() && data.value) data.value = { ...data.value, providers: response.data };
    }
  } catch (err) {
    if (scope.isCurrent()) failure.value = extractApiError(err).message;
  } finally {
    if (scope.isCurrent()) busy.value = false;
  }
}

async function toggleProvider(provider: DomainLlmProvider) {
  if (busy.value || !writable.value) return;
  const scope = capture();
  busy.value = true;
  failure.value = '';
  try {
    await api.updateProvider(scope.slug, provider.id, { enabled: !provider.enabled }, provider.revision);
    if (scope.isCurrent()) {
      const response = await api.providers(scope.slug);
      if (scope.isCurrent() && data.value) data.value = { ...data.value, providers: response.data };
    }
  } catch (err) {
    if (scope.isCurrent()) failure.value = extractApiError(err).message;
  } finally {
    if (scope.isCurrent()) busy.value = false;
  }
}

async function saveDefaults() {
  if (busy.value || !writable.value || !data.value) return;
  const scope = capture();
  busy.value = true;
  failure.value = '';
  try {
    const response = await api.saveSettings(
      scope.slug,
      providerId.value === 'none' ? null : providerId.value,
      providerId.value === 'none' ? null : model.value.trim(),
      data.value.settings.revision,
    );
    if (scope.isCurrent() && data.value) {
      data.value = { ...data.value, settings: response.data };
    }
  } catch (err) {
    if (scope.isCurrent()) failure.value = extractApiError(err).message;
  } finally {
    if (scope.isCurrent()) busy.value = false;
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
  } catch (err) {
    if (scope.isCurrent()) failure.value = extractApiError(err).message;
  }
}

async function reloadProviders() {
  const scope = capture();
  failure.value = '';
  try {
    const response = await api.providers(scope.slug);
    if (scope.isCurrent() && data.value) {
      data.value = { ...data.value, providers: response.data };
    }
  } catch (err) {
    if (scope.isCurrent()) failure.value = extractApiError(err).message;
  }
}

useSeoMeta({ title: 'LLM Provider 与别名 - 域设置' });
</script>

<template>
  <DomainSettingsShell>
    <div v-if="can('llm:manage')" class="space-y-6">
      <AdminPageHeader title="LLM Provider 与模型别名" description="配置空间专属的模型服务商、默认评测模型及模型别名。" icon="i-lucide-bot">
        <template #actions>
          <div class="flex items-center gap-2">
            <UButton :to="workspacePath(slug!, 'settings/llm/quotas')" variant="outline" icon="i-lucide-sliders-horizontal">
              管理额度
            </UButton>
            <UButton :to="workspacePath(slug!, 'settings/llm/usage')" variant="outline" icon="i-lucide-bar-chart-3">
              用量统计
            </UButton>
            <UButton variant="outline" :disabled="busy" @click="reloadProviders">重新读取 Provider 列表</UButton>
          </div>
        </template>
      </AdminPageHeader>

      <UAlert v-if="error" color="error" :title="extractApiError(error).message">
        <template #actions>
          <UButton @click="refresh()">重试</UButton>
        </template>
      </UAlert>

      <UAlert v-if="failure" color="error" :title="failure"
        description="原输入和编辑依据仍保留；冲突时重新读取对应资源，再显式打开编辑。" />

      <!-- 默认 Provider 与模型 -->
      <UCard v-if="data" class="rounded">
        <h3 class="mb-2 font-semibold text-text">本域默认 Provider 和模型</h3>
        <p class="mb-4 text-sm text-text-secondary">
          共享题使用本域模型、密钥及额度。未配置时无法创建 LLM 评测。
        </p>
        <div class="flex flex-wrap items-center gap-3">
          <USelect
            v-model="providerId"
            :items="[
              { value: 'none', label: '未配置' },
              ...data.providers.filter((provider) => provider.enabled).map((provider) => ({ value: provider.id, label: provider.name }))
            ]"
            :disabled="!writable || busy"
            class="min-w-48"
            aria-label="默认 Provider"
          />
          <UInput
            v-model="model"
            :disabled="!writable || providerId === 'none' || busy"
            placeholder="默认模型名称（如 gpt-4o）"
            aria-label="默认模型"
            class="min-w-48"
          />
          <UButton
            :loading="busy"
            :disabled="!writable || (providerId !== 'none' && !model.trim())"
            @click="saveDefaults"
          >
            保存默认配置
          </UButton>
          <UButton variant="ghost" :disabled="busy" @click="reloadSettings">重新读取</UButton>
        </div>
      </UCard>

      <!-- Provider 列表 -->
      <UCard v-if="data" class="rounded">
        <div class="mb-4 flex items-center justify-between">
          <div>
            <h3 class="font-semibold text-text">LLM Provider 列表</h3>
            <p class="text-xs text-text-muted mt-1">
              费用额度与 Provider 单价采用同一单位，使用整数；实际用量按上游返回结算。
            </p>
          </div>
          <UButton :disabled="!writable" icon="i-lucide-plus" @click="edit()">新增 Provider</UButton>
        </div>

        <div v-if="!data.providers.length" class="py-8 text-center text-sm text-text-muted">
          暂无已配置的 Provider
        </div>

        <div
          v-for="provider in data.providers"
          :key="provider.id"
          class="flex flex-wrap items-center justify-between gap-3 border-t border-border py-3"
        >
          <div>
            <p class="font-medium text-text">
              {{ provider.name }}
              <UBadge :color="provider.enabled ? 'primary' : 'neutral'" variant="subtle" class="ml-2">
                {{ provider.enabled ? '启用' : '停用' }}
              </UBadge>
            </p>
            <p class="mt-1 text-xs text-text-muted font-mono">{{ provider.base_url }} · {{ provider.api_key_masked }}</p>
            <p class="mt-1 text-xs text-text-muted tabular-nums">
              RPM: {{ provider.rpm_limit || '不限' }} / TPM: {{ provider.tpm_limit || '不限' }}
            </p>
          </div>
          <div class="flex items-center gap-2">
            <UButton variant="outline" size="sm" :disabled="!writable" @click="edit(provider)">编辑</UButton>
            <UButton variant="outline" size="sm" :disabled="!writable" @click="openTest(provider)">测试连接</UButton>
            <UButton
              variant="ghost"
              color="neutral"
              size="sm"
              :disabled="!writable || busy"
              @click="toggleProvider(provider)"
            >
              {{ provider.enabled ? '停用' : '启用' }}
            </UButton>
          </div>
        </div>
      </UCard>

      <!-- 别名管理 -->
      <DomainLlmAliases v-if="data" :key="key" :slug="slug!" :providers="data.providers" :writable="writable" />

      <!-- 测试连接弹窗 -->
      <UModal v-model:open="testModal" title="测试本域 Provider 连接">
        <template #body>
          <p class="mb-3 text-sm text-text-secondary">{{ testProvider?.name }} · 调用真实上游进行连接检查。</p>
          <form class="space-y-3" @submit.prevent="runTest">
            <UInput v-model="testModel" placeholder="测试模型名称（如 gpt-4o-mini）" aria-label="Provider 测试模型" required />
            <UButton type="submit" :disabled="!writable || !testModel.trim()" :loading="testing">运行连接测试</UButton>
          </form>
          <UAlert v-if="testFailure" color="error" :title="testFailure" class="mt-3" />
          <UAlert
            v-if="testResult"
            :color="testResult.status === 'ok' ? 'success' : 'error'"
            :title="testResult.status === 'ok' ? `连接成功，耗时 ${testResult.latency_ms} ms` : testResult.message ?? '上游连接失败'"
            class="mt-3"
          />
        </template>
      </UModal>

      <!-- 新增/编辑 Provider 弹窗 -->
      <UModal v-model:open="modal" :title="editing ? '编辑 Provider' : '新增 Provider'">
        <template #body>
          <form class="space-y-4" @submit.prevent="saveProvider">
            <AdminFormField label="名称" required>
              <UInput v-model="form.name" required class="w-full" placeholder="如 OpenAI / DeepSeek" aria-label="Provider 名称" />
            </AdminFormField>
            <AdminFormField label="Base URL" required>
              <UInput v-model="form.base_url" type="url" required class="w-full" placeholder="https://api.openai.com/v1" aria-label="Provider Base URL" />
            </AdminFormField>
            <AdminFormField label="API Key" :hint="editing ? '留空保留现有密钥' : '仅写入加密存储'">
              <UInput v-model="form.api_key" type="password" autocomplete="new-password" :required="!editing" class="w-full" aria-label="Provider API Key" />
            </AdminFormField>
            <AdminFormField label="每 1000 Token 费用" hint="费用整数与 Provider 单价采用同一单位">
              <UInput v-model.number="form.cost_per_1k_tokens" type="number" min="0" step="any" aria-label="Provider 每 1000 Token 费用" />
            </AdminFormField>
            <UCheckbox v-model="form.enabled" label="启用此 Provider" />
            <div class="grid grid-cols-2 gap-3">
              <AdminFormField label="RPM 上限" hint="每分钟请求数，0 为不限">
                <UInput v-model.number="form.rpm_limit" type="number" min="0" aria-label="Provider RPM 上限" />
              </AdminFormField>
              <AdminFormField label="TPM 上限" hint="每分钟 Token，0 为不限">
                <UInput v-model.number="form.tpm_limit" type="number" min="0" aria-label="Provider TPM 上限" />
              </AdminFormField>
            </div>
            <UButton type="submit" :loading="busy">保存 Provider</UButton>
          </form>
        </template>
      </UModal>
    </div>
    <UAlert v-else color="warning" title="没有当前域 LLM 管理权限" />
  </DomainSettingsShell>
</template>
