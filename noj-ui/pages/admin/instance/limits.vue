<script setup lang="ts">
import { extractApiError } from '~/utils/apiError';
import { useToast } from '~/composables/useToast';
import InstanceNav from '~/components/admin/InstanceNav.vue';
import WorkspaceLimitFields from '~/components/workspace/WorkspaceLimitFields.vue';
import type { WorkspaceLimits } from '~/utils/workspace';

definePageMeta({ layout: 'admin', middleware: 'admin', });

const api = useInstanceAdmin();
const { user } = useAuth();
const { toast } = useToast();
const { dialog } = useDialog();

const key = computed(() => `instance-settings-limits:${user.value?.id}`);
const { data, status, error, refresh } = await useAsyncData(key, () => api.getSection('limits'));

const defaultLimits = ref<WorkspaceLimits>({
  members: null,
  problems: null,
  storage_bytes: null,
  submissions_per_minute: null,
});

const limitCaps = ref<WorkspaceLimits>({
  members: null,
  problems: null,
  storage_bytes: null,
  submissions_per_minute: null,
});

const revision = ref('');
const savedSnapshot = ref('');
const saveError = ref('');
const saving = ref(false);

function parseLimits(val: unknown): WorkspaceLimits {
  return typeof val === 'string' ? JSON.parse(val) : (val as WorkspaceLimits);
}

const capsValid = ref(true);
const defaultsValid = ref(true);

function initDraft() {
  const section = data.value?.data;
  if (!section) return;
  const vals = section.values;
  defaultLimits.value = { ...parseLimits(vals.domain_default_limits) };
  limitCaps.value = { ...parseLimits(vals.domain_limit_caps) };
  revision.value = section.revision ?? '';
  savedSnapshot.value = JSON.stringify({ defaults: defaultLimits.value, caps: limitCaps.value });
  saveError.value = '';
}

const dirty = computed(() =>
  !!savedSnapshot.value &&
  JSON.stringify({ defaults: defaultLimits.value, caps: limitCaps.value }) !== savedSnapshot.value
);

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
  if (saving.value || !capsValid.value || !defaultsValid.value) return;
  saving.value = true;
  saveError.value = '';
  try {
    const payload = {
      domain_default_limits: JSON.stringify(defaultLimits.value),
      domain_limit_caps: JSON.stringify(limitCaps.value),
    };
    const res = await api.updateSection('limits', payload, revision.value);
    revision.value = res.data.revision;
    savedSnapshot.value = JSON.stringify({ defaults: defaultLimits.value, caps: limitCaps.value });
    toast.success('资源额度政策已保存');
    await refresh();
    if (!error.value) initDraft();
  } catch (err: unknown) {
    const apiErr = extractApiError(err);
    saveError.value = apiErr.message;
    toast.error(apiErr.message);
  } finally {
    saving.value = false;
  }
}

useSeoMeta({ title: '资源额度政策 - 实例设置' });
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
        <form class="space-y-6" @submit.prevent="save">
          <!-- 各空间刚性资源上限 (instance_caps) -->
          <UCard class="rounded border border-border bg-bg-panel shadow-xs">
            <div class="mb-4">
              <h2 class="text-base font-semibold text-text">各空间资源上限 (Caps)</h2>
              <p class="text-xs text-text-secondary mt-1 leading-relaxed">
                实时约束所有空间的有效资源。降低上限会保留已有资源，超额时拒绝新增。
              </p>
            </div>
            <WorkspaceLimitFields
              v-model="limitCaps"
              mode="instance_caps"
              @valid="capsValid = $event"
            />
          </UCard>

          <!-- 新空间默认额度 (instance_defaults) -->
          <UCard class="rounded border border-border bg-bg-panel shadow-xs">
            <div class="mb-4">
              <h2 class="text-base font-semibold text-text">新空间默认初始额度 (Defaults)</h2>
              <p class="text-xs text-text-secondary mt-1 leading-relaxed">
                仅在新空间创建时作为初始配额复制，不影响任何已存在的存量空间。
              </p>
            </div>
            <WorkspaceLimitFields
              v-model="defaultLimits"
              mode="instance_defaults"
              :caps="limitCaps"
              @valid="defaultsValid = $event"
            />
          </UCard>

          <UAlert v-if="saveError" color="error" :title="saveError" description="未保存的修改仍保留在表单中，请核对后重试。" />

          <div class="pt-2">
            <UButton type="submit" color="primary" :loading="saving" :disabled="!capsValid || !defaultsValid">保存额度政策</UButton>
          </div>
        </form>
      </AsyncContent>
    </div>
  </div>
</template>
