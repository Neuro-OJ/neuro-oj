<script setup lang="ts">
// 显式导入项目 useToast：避免与 @nuxt/ui 自动导入的同名 useToast 混淆
import { useToast } from '~/composables/useToast';
import { extractApiError } from '~/utils/server/apiError';

/**
 * 自带模型（BYOK）设置：保存一个 OpenAI 兼容 Provider，练习提交 LLM 题时可选用。
 *
 * Key 只写不读：服务端只返回脱敏值；留空保存表示保留原 Key。
 */
interface ByokProvider {
  provider_id: string;
  base_url: string;
  model: string;
  api_key_masked: string;
  enabled: boolean;
  revision: number;
  updated_at: string;
}
interface ByokState {
  enabled: boolean;
  allowed_hosts: string[];
  provider: ByokProvider | null;
}

const { api } = useApi();
const { toast } = useToast();
const { dialog } = useDialog();

const state = ref<ByokState | null>(null);
const loadError = ref('');
const saving = ref(false);
const testing = ref(false);
const removing = ref(false);
const form = reactive({ base_url: '', model: '', api_key: '', enabled: true });

function fillForm(provider: ByokProvider | null) {
  form.base_url = provider?.base_url ?? '';
  form.model = provider?.model ?? '';
  form.api_key = '';
  form.enabled = provider?.enabled ?? true;
}

async function load() {
  loadError.value = '';
  try {
    const res = await api.get<{ data: ByokState }>('/api/v1/me/llm-provider', { silent: true });
    state.value = res.data;
    fillForm(res.data.provider);
  } catch (e) {
    loadError.value = extractApiError(e).message;
  }
}

onMounted(load);

async function save() {
  if (!state.value) return;
  const provider = state.value.provider;
  if (!provider && !form.api_key.trim()) {
    toast.error('请填写 API Key');
    return;
  }
  saving.value = true;
  try {
    const body: Record<string, unknown> = {
      base_url: form.base_url.trim(),
      model: form.model.trim(),
      enabled: form.enabled,
    };
    if (form.api_key.trim()) body.api_key = form.api_key.trim();
    const res = await api.put<{ data: ByokProvider }>('/api/v1/me/llm-provider', body, {
      headers: { 'If-Match': String(provider?.revision ?? 0) },
      silent: true,
    });
    state.value = { ...state.value, provider: res.data };
    fillForm(res.data);
    toast.success('自带模型已保存');
  } catch (e) {
    toast.error(extractApiError(e).message);
    if (extractApiError(e).code === 'REVISION_CONFLICT') await load();
  } finally {
    saving.value = false;
  }
}

async function test() {
  testing.value = true;
  try {
    const res = await api.post<{ data: { status: 'ok' | 'failed'; message?: string } }>(
      '/api/v1/me/llm-provider/test',
      undefined,
      { silent: true },
    );
    if (res.data.status === 'ok') toast.success('连接成功');
    else toast.error(res.data.message ?? '连接失败');
  } catch (e) {
    toast.error(extractApiError(e).message);
  } finally {
    testing.value = false;
  }
}

async function remove() {
  const ok = await dialog.confirm('删除后将无法再用自带模型提交，已保存的 Key 会被销毁。确定删除？');
  if (!ok || !state.value) return;
  removing.value = true;
  try {
    await api.delete('/api/v1/me/llm-provider', { silent: true });
    state.value = { ...state.value, provider: null };
    fillForm(null);
    toast.success('自带模型已删除');
  } catch (e) {
    toast.error(extractApiError(e).message);
  } finally {
    removing.value = false;
  }
}
</script>

<template>
  <section id="settings-byok" aria-labelledby="byok-title"
    class="scroll-mt-32 overflow-hidden rounded border border-border bg-bg-panel">
    <div class="border-b border-border px-6 py-5">
      <h2 id="byok-title" class="flex items-center gap-2 text-xl font-bold text-text">
        <UIcon name="i-lucide-key-round" class="size-5" />
        自带模型
      </h2>
      <p class="mt-1 text-sm text-text-secondary">
        练习 LLM 题时可改用你自己的 OpenAI 兼容模型评测，不消耗平台额度。比赛与作业提交不能使用。
      </p>
    </div>
    <div class="flex flex-col gap-4 px-6 py-6">
      <p v-if="loadError" class="text-sm text-error-text">{{ loadError }}</p>
      <p v-else-if="!state" class="text-sm text-text-muted">加载中…</p>
      <UAlert v-else-if="!state.enabled" color="neutral" variant="subtle" title="本实例未开启自带模型" />
      <template v-else>
        <p class="text-xs text-text-muted">
          允许的服务地址（仅 https）：{{ state.allowed_hosts.join('、') }}
        </p>
        <div class="grid max-w-xl gap-3">
          <UFormField label="Base URL" required>
            <UInput v-model="form.base_url" placeholder="https://api.example.com/v1" class="w-full" />
          </UFormField>
          <UFormField label="模型名" required help="题目声明的所有模型别名都会使用这个模型">
            <UInput v-model="form.model" placeholder="gpt-4o-mini" class="w-full" />
          </UFormField>
          <UFormField label="API Key" :required="!state.provider"
            :help="state.provider ? `当前：${state.provider.api_key_masked}；留空保留原 Key` : undefined">
            <UInput v-model="form.api_key" type="password" autocomplete="off" class="w-full" />
          </UFormField>
          <USwitch v-model="form.enabled" label="启用" />
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <UButton color="primary" :loading="saving" @click="save">保存</UButton>
          <UButton v-if="state.provider" color="neutral" variant="outline" :loading="testing" @click="test">
            测试连接
          </UButton>
          <UButton v-if="state.provider" color="error" variant="outline" :loading="removing" @click="remove">
            删除
          </UButton>
        </div>
      </template>
    </div>
  </section>
</template>
