<script setup lang="ts">
import { extractApiError } from '~/utils/apiError';
import { workspaceCacheKey } from '~/utils/workspace';
import type { WorkspaceConfiguration, WorkspaceLimits } from '~/utils/workspace';
import { useToast } from '~/composables/useToast';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const context = useWorkspace();
const captureAction = useWorkspaceActionScope();
const { user } = useAuth();
const workspaces = useWorkspaceApi();
const { toast } = useToast();
const { dialog } = useDialog();
const general = ref<{ dirty: boolean } | null>(null);
const formVersion = ref(0);
const permitted = computed(() =>
  !!context.domain.value &&
  (context.domain.value.platform_admin || context.domain.value.permissions.includes('domain:settings'))
);
const key = computed(() => workspaceCacheKey(context.slug.value ?? '', user.value?.id ?? null, 'settings-policy'));
const policy = await useAsyncData<{ data: { modules: WorkspaceConfiguration['features'] } | null }>(
  key,
  () => permitted.value ? workspaces.instance() : Promise.resolve({ data: null }),
  { watch: [permitted] },
);
const quotaKey = computed(() => workspaceCacheKey(context.slug.value ?? '', user.value?.id ?? null, 'limits'));
const quotas = await useAsyncData<{ data: Awaited<ReturnType<typeof workspaces.limits>>['data'] | null }>(
  quotaKey,
  () =>
    context.can('domain:limits') && context.slug.value
      ? workspaces.limits(context.slug.value)
      : Promise.resolve({ data: null }),
  { watch: [() => context.can('domain:limits')] },
);
const quotaDraft = ref<WorkspaceLimits | null>(null);
const quotaRevision = ref(0);
const quotaError = ref('');
const savingQuota = ref(false);
const quotaSnapshot = ref('');
const quotaDirty = computed(() => !!quotaDraft.value && JSON.stringify(quotaDraft.value) !== quotaSnapshot.value);
function loadQuota() {
  const value = quotas.data.value?.data;
  if (!value) return;
  quotaDraft.value = { ...value.configured };
  quotaRevision.value = value.revision;
  quotaSnapshot.value = JSON.stringify(quotaDraft.value);
}
watch(quotas.data, (value) => {
  if (value?.data && !quotaDirty.value) loadQuota();
}, { immediate: true });
useUnsavedChanges(() => !!general.value?.dirty || quotaDirty.value);
async function refreshGeneral() {
  await context.refresh();
  formVersion.value++;
}
async function reload() {
  if ((general.value?.dirty || quotaDirty.value) && !await dialog.confirm('重新读取会替换本页尚未保存的修改。',{title:'重新读取设置'})) return;
  await context.refresh();
  await quotas.refresh();
  if (!quotas.error.value) loadQuota();
  formVersion.value++;
}
async function saveQuota() {
  if (!quotaDraft.value || !context.slug.value || savingQuota.value) return;
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
  } catch (cause) {
    quotaError.value = extractApiError(cause).message;
  } finally {
    savingQuota.value = false;
  }
}
useSeoMeta({ title: '域设置' });
</script>

<template>
  <DomainSettingsShell>
  <div v-if="permitted && context.domain.value" class="space-y-6">
    <AdminPageHeader title="基本设置" description="名称、访问与加入政策。" icon="i-lucide-settings">
      <template #actions>
        <UButton color="neutral" variant="outline" @click="reload">重新读取设置</UButton>
      </template>
    </AdminPageHeader>
    <UAlert v-if="policy.error.value" color="error" :title="extractApiError(policy.error.value).message" />
    <WorkspaceSettingsForm v-if="policy.data.value?.data" ref="general"
      :key="`${context.domain.value.id}:${context.domain.value.actor_id}:${formVersion}`"
      :domain="context.domain.value" :modules="policy.data.value.data.modules"
      :can-archive="context.can('domain:archive') || context.domain.value.platform_admin" @saved="refreshGeneral" />
    <UCard id="limits" v-if="quotaDraft && context.can('domain:limits')" class="scroll-mt-24 rounded">
      <form class="space-y-4" @submit.prevent="saveQuota">
        <h2 class="font-semibold text-text">成员、题库、存储与提交额度</h2>
        <p
          class="text-sm text-text-secondary">不限制本域额度时，仍受实例上限约束。域管理员只能降低有效额度；提高额度需平台治理权限。降低配额不会清除已有成员或历史。</p>
        <WorkspaceLimitFields v-model="quotaDraft" :caps="quotas.data.value?.data?.caps"
          :effective="quotas.data.value?.data?.effective"
          :disabled="context.domain.value.status !== 'active' || savingQuota" />
        <div v-if="quotas.data.value?.data"
          class="space-y-2 rounded border border-border bg-bg-sunken p-3 text-sm tabular-nums">
          <p>成员：已使用 {{ quotas.data.value.data.usage.members }} 人 · 已预约 {{ quotas.data.value.data.usage.reserved_members }} 人</p>
          <p>题库条目：已使用 {{ quotas.data.value.data.usage.problems }} 道 · 已预约 {{ quotas.data.value.data.usage.reserved_problems }} 道</p>
          <p>存储：已使用 {{ quotas.data.value.data.usage.storage_bytes }} 字节 · 上传预约 {{ quotas.data.value.data.usage.reserved_storage_bytes }} 字节</p>
          <p class="text-xs text-text-muted">每分钟提交按当前受理窗口限流，此处不将持久资源计数当作当前窗口次数。</p>
        </div>
        <p v-if="quotaError" class="text-sm text-error-text" role="alert">{{ quotaError }}</p>
        <UButton type="submit" :loading="savingQuota"
          :disabled="context.domain.value.status !== 'active'">保存配额</UButton>
      </form>
    </UCard>
    <p v-if="quotas.error.value" class="text-sm text-error-text"
      role="alert">{{ extractApiError(quotas.error.value).message }}</p>
  </div>
  <UAlert v-else-if="context.domain.value" color="neutral" variant="subtle" title="你没有管理此域设置的权限" />
  </DomainSettingsShell>
</template>
