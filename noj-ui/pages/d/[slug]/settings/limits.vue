<script setup lang="ts">
import { extractApiError } from '~/utils/apiError';
import { workspaceCacheKey } from '~/utils/workspace';
import type { WorkspaceLimits, WorkspaceLimitUsage } from '~/utils/workspace';
import { useToast } from '~/composables/useToast';

definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const context = useWorkspace();
const captureAction = useWorkspaceActionScope();
const { user } = useAuth();
const workspaces = useWorkspaceApi();
const { toast } = useToast();
const { dialog } = useDialog();

const permitted = computed(() => context.can('domain:limits'));

interface QuotasPayload {
  configured: WorkspaceLimits;
  effective: WorkspaceLimits;
  caps: WorkspaceLimits;
  revision: number;
  usage: WorkspaceLimitUsage;
}

const quotaKey = computed(() => workspaceCacheKey(context.slug.value ?? '', user.value?.id ?? null, 'limits'));
const quotas = await useAsyncData<{ data: QuotasPayload | null }>(
  quotaKey,
  () =>
    permitted.value && context.slug.value
      ? workspaces.limits(context.slug.value)
      : Promise.resolve({ data: null }),
  { watch: [permitted] },
);

const quotaDraft = ref<WorkspaceLimits | null>(null);
const quotaRevision = ref(0);
const quotaError = ref('');
const savingQuota = ref(false);
const quotaSnapshot = ref('');
const limitsValid = ref(true);

const quotaDirty = computed(() => !!quotaDraft.value && JSON.stringify(quotaDraft.value) !== quotaSnapshot.value);

useUnsavedChanges(() => quotaDirty.value);

function loadQuota() {
  const value = quotas.data.value?.data;
  if (!value) return;
  quotaDraft.value = { ...value.configured };
  quotaRevision.value = value.revision;
  quotaSnapshot.value = JSON.stringify(quotaDraft.value);
}

watch(
  quotas.data,
  (value) => {
    if (value?.data && !quotaDirty.value) loadQuota();
  },
  { immediate: true },
);

async function reload() {
  if (
    quotaDirty.value &&
    !await dialog.confirm('重新读取会替换本页尚未保存的修改。', { title: '重新读取额度' })
  ) return;
  await quotas.refresh();
  if (!quotas.error.value) loadQuota();
}

async function saveQuota() {
  if (!quotaDraft.value || !context.slug.value || savingQuota.value || !limitsValid.value || !context.writable.value) return;
  savingQuota.value = true;
  quotaError.value = '';
  const action = captureAction();
  try {
    await workspaces.updateLimits(action.slug, quotaDraft.value, quotaRevision.value);
    if (!action.isCurrent()) return;
    quotaSnapshot.value = JSON.stringify(quotaDraft.value);
    toast.success('配额设置已保存');
    await context.refresh();
    await quotas.refresh();
    loadQuota();
  } catch (cause) {
    quotaError.value = extractApiError(cause).message;
  } finally {
    savingQuota.value = false;
  }
}

useSeoMeta({ title: '资源额度 - 域设置' });
</script>

<template>
  <DomainSettingsShell>
    <div v-if="permitted && context.domain.value" class="space-y-6">
      <AdminPageHeader title="资源额度" description="成员数、题库条目、存储空间与提交频次限制。" icon="i-lucide-gauge">
        <template #actions>
          <UButton color="neutral" variant="outline" @click="reload">重新读取额度</UButton>
        </template>
      </AdminPageHeader>

      <UCard v-if="quotaDraft" class="rounded">
        <form class="space-y-5" @submit.prevent="saveQuota">
          <div>
            <h2 class="font-semibold text-text">成员、题库、存储与提交额度</h2>
            <p class="mt-1 text-sm text-text-secondary">
              不限制本域额度时，仍受实例上限约束。域管理员只能降低有效额度；提高额度需平台治理权限。降低配额不会清除已有成员或历史。
            </p>
          </div>

          <WorkspaceLimitFields
            v-model="quotaDraft"
            mode="domain_limits"
            :caps="quotas.data.value?.data?.caps"
            :effective="quotas.data.value?.data?.effective"
            :disabled="!context.writable.value || savingQuota"
            @valid="limitsValid = $event"
          />

          <div
            v-if="quotas.data.value?.data"
            class="space-y-2 rounded border border-border bg-bg-sunken p-3 text-sm tabular-nums"
          >
            <p>
              成员：已使用 {{ quotas.data.value.data.usage.members }} 人 · 已预约 {{ quotas.data.value.data.usage.reserved_members }} 人
            </p>
            <p>
              题库条目：已使用 {{ quotas.data.value.data.usage.problems }} 道 · 已预约 {{ quotas.data.value.data.usage.reserved_problems }} 道
            </p>
            <p>
              存储：已使用 {{ (quotas.data.value.data.usage.storage_bytes / 1048576).toFixed(2) }} MiB ({{ quotas.data.value.data.usage.storage_bytes }} 字节) · 上传预约 {{ quotas.data.value.data.usage.reserved_storage_bytes }} 字节
            </p>
            <p class="text-xs text-text-muted">每分钟提交按当前受理窗口限流，此处不将持久资源计数当作当前窗口次数。</p>
          </div>

          <p v-if="quotaError" class="text-sm text-error-text" role="alert">{{ quotaError }}</p>

          <UButton type="submit" :loading="savingQuota" :disabled="!context.writable.value || !limitsValid">
            保存配额
          </UButton>
        </form>
      </UCard>

      <p v-if="quotas.error.value" class="text-sm text-error-text" role="alert">
        {{ extractApiError(quotas.error.value).message }}
      </p>
    </div>
    <UAlert v-else-if="context.status.value !== 'pending' && context.domain.value" color="neutral" variant="subtle" title="你没有管理此空间配额的权限" />
  </DomainSettingsShell>
</template>
