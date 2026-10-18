<script setup lang="ts">
import { extractApiError } from '~/utils/apiError';
import { useToast } from '~/composables/useToast';
import InstanceNav from '~/components/admin/InstanceNav.vue';

definePageMeta({ layout: 'admin', middleware: 'admin', });

const api = useInstanceAdmin();
const { user } = useAuth();
const { toast } = useToast();
const { dialog } = useDialog();

const key = computed(() => `instance-settings-llm-limits:${user.value?.id}`);
const { data, status, error, refresh } = await useAsyncData(key, () => api.getSection('llm-limits'));

interface QuotaLimits {
  max_calls: number | null;
  max_tokens: number | null;
  max_cost: number | null;
}

const draft = reactive<Record<'day' | 'month', QuotaLimits>>({
  day: { max_calls: null, max_tokens: null, max_cost: null },
  month: { max_calls: null, max_tokens: null, max_cost: null },
});

const revision = ref('');
const savedSnapshot = ref('');
const saveError = ref('');
const saving = ref(false);

function parseLlmCaps(val: unknown): Record<'day' | 'month', QuotaLimits> {
  return typeof val === 'string' ? JSON.parse(val) : (val as Record<'day' | 'month', QuotaLimits>);
}

function initDraft() {
  const section = data.value?.data;
  if (!section) return;
  const vals = section.values;
  const parsed = parseLlmCaps(vals.domain_llm_quota_caps);
  draft.day = { ...parsed.day };
  draft.month = { ...parsed.month };
  revision.value = section.revision ?? '';
  savedSnapshot.value = JSON.stringify(draft);
  saveError.value = '';
}

const dirty = computed(() => !!savedSnapshot.value && JSON.stringify(draft) !== savedSnapshot.value);

watch(data, () => {
  if (!savedSnapshot.value || !revision.value || !dirty.value) initDraft();
}, { immediate: true });

useUnsavedChanges(() => dirty.value);

async function reload() {
  if (dirty.value && !await dialog.confirm('重新读取会替换本页尚未保存的修改。确认重新读取？', { title: '重新读取政策' })) {
    return;
  }
  await refresh();
  if (!error.value) initDraft();
}

async function save() {
  if (saving.value) return;
  saving.value = true;
  saveError.value = '';
  try {
    const payload = {
      domain_llm_quota_caps: JSON.stringify(draft),
    };
    const res = await api.updateSection('llm-limits', payload, revision.value);
    revision.value = res.data.revision;
    savedSnapshot.value = JSON.stringify(draft);
    toast.success('各空间 LLM 额度上限已保存');
    await refresh();
  } catch (err: unknown) {
    const apiErr = extractApiError(err);
    saveError.value = apiErr.message;
    toast.error(apiErr.message);
  } finally {
    saving.value = false;
  }
}

useSeoMeta({ title: 'LLM 额度上限 - 实例设置' });
</script>

<template>
  <div class="space-y-6">
    <AdminPageHeader title="实例与域治理" description="管理实例全局政策、可选模块与各空间资源上限。" icon="i-lucide-building-2">
      <template #actions>
        <UButton variant="outline" @click="reload">重新读取政策</UButton>
      </template>
    </AdminPageHeader>

    <InstanceNav />

    <div class="max-w-[768px]">
      <AsyncContent
        :status="error ? 'error' : status === 'pending' ? 'loading' : data ? 'data' : 'empty'"
        :error="error ? extractApiError(error).message : undefined"
        @retry="refresh()"
      >
        <UCard class="rounded border border-border bg-bg-panel shadow-xs">
          <form class="space-y-6" @submit.prevent="save">
            <div>
              <h2 class="text-base font-semibold text-text">各工作空间 LLM 额度上限</h2>
              <p class="text-xs text-text-secondary mt-1 leading-relaxed">
                域管理员只能在实例上限内降低额度；提高上限需平台管理员权限。费用额度与 Provider 单价采用同一单位，使用整数；0 表示禁止对应新增或调用，但保留历史。
              </p>
            </div>

            <div class="space-y-6 divide-y divide-border/60">
              <fieldset
                v-for="win in ([{ key: 'day' as const, label: '每日上限' }, { key: 'month' as const, label: '每月上限' }])"
                :key="win.key"
                class="pt-4 first:pt-0 space-y-4"
              >
                <legend class="text-sm font-semibold text-text">{{ win.label }}</legend>

                <div class="grid gap-4 sm:grid-cols-3">
                  <div
                    v-for="field in ([
                      { key: 'max_calls' as const, label: '调用次数', unit: '次' },
                      { key: 'max_tokens' as const, label: 'Token 消耗', unit: 'Token' },
                      { key: 'max_cost' as const, label: '费用整数', unit: '单位' }
                    ])"
                    :key="field.key"
                    class="space-y-2 rounded border border-border bg-bg-sunken p-3"
                  >
                    <div class="flex items-center justify-between">
                      <span class="text-xs font-medium text-text">{{ field.label }}</span>
                      <UCheckbox
                        :model-value="draft[win.key][field.key] === null"
                        label="不额外限制"
                        @update:model-value="draft[win.key][field.key] = $event ? null : 0"
                      />
                    </div>

                    <div v-if="draft[win.key][field.key] !== null" class="space-y-1 pt-1">
                      <div class="flex items-center gap-1.5">
                        <UInputNumber
                          v-model="draft[win.key][field.key]"
                          :min="0"
                          :max="2147483647"
                          class="w-full"
                          :aria-label="`${win.label}${field.label}上限`"
                        />
                        <span class="text-xs text-text-muted shrink-0">{{ field.unit }}</span>
                      </div>
                      <p v-if="draft[win.key][field.key] === 0" class="text-[11px] text-amber-600">
                        0 表示禁止调用
                      </p>
                    </div>
                  </div>
                </div>
              </fieldset>
            </div>

            <UAlert v-if="saveError" color="error" :title="saveError" description="未保存的修改仍保留在表单中，请核对后重试。" />

            <div class="pt-2">
              <UButton type="submit" color="primary" :loading="saving">保存 LLM 上限</UButton>
            </div>
          </form>
        </UCard>
      </AsyncContent>
    </div>
  </div>
</template>
