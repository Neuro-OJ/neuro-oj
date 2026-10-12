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
watch(quotas.data, (value) => {
  if (value?.data) {
    quotaDraft.value = { ...value.data.configured };
    quotaRevision.value = value.data.revision;
  }
}, { immediate: true });
async function reload() {
  await context.refresh();
  await quotas.refresh();
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
    toast.success('配额设置已保存');
    await context.refresh();
    await quotas.refresh();
  } catch (cause) {
    quotaError.value = extractApiError(cause).message;
  } finally {
    savingQuota.value = false;
  }
}
useSeoMeta({ title: '空间设置' });
</script>

<template>
  <div v-if="permitted && context.domain.value" class="space-y-6">
    <AdminPageHeader title="空间设置" description="成员、功能与访问政策仅作用于当前空间。" icon="i-lucide-settings">
      <template #actions>
        <UButton color="neutral" variant="outline" @click="reload">重新读取设置</UButton>
      </template>
    </AdminPageHeader>
    <UAlert v-if="policy.error.value" color="error" :title="extractApiError(policy.error.value).message" />
    <WorkspaceSettingsForm v-if="policy.data.value?.data"
      :key="`${context.domain.value.id}:${context.domain.value.actor_id}:${formVersion}`"
      :domain="context.domain.value" :modules="policy.data.value.data.modules"
      :can-archive="context.can('domain:archive') || context.domain.value.platform_admin" @saved="reload" />
    <UCard v-if="quotaDraft && context.can('domain:limits')" class="rounded">
      <form class="space-y-4" @submit.prevent="saveQuota">
        <h2 class="font-semibold text-text">成员与题库条目配额</h2>
        <p class="text-sm text-text-secondary">不限制本域额度时，仍受实例上限约束。降低配额不会清除已有成员或历史。</p>
        <div
          v-for="field in ([{ key: 'members', label: '成员上限' }, { key: 'problems', label: '题库条目上限' }] as const)"
          :key="field.key" class="space-y-2">
          <UCheckbox :model-value="quotaDraft[field.key] === null" :label="`${field.label}：本域不额外限制`"
            @update:model-value="quotaDraft[field.key] = $event ? null : (quotas.data.value?.data?.effective[field.key] ?? 0)" />
          <UInputNumber v-if="quotaDraft[field.key] !== null" v-model="quotaDraft[field.key]" :min="0" :max="2147483647"
            :aria-label="field.label" />
          <p
            class="text-xs text-text-muted">当前有效上限：{{ quotas.data.value?.data?.effective[field.key] ?? '不限制' }}</p>
        </div>
        <p v-if="quotaError" class="text-sm text-error-text" role="alert">{{ quotaError }}</p>
        <UButton type="submit" :loading="savingQuota"
          :disabled="context.domain.value.status !== 'active'">保存配额</UButton>
      </form>
    </UCard>
    <p v-if="quotas.error.value" class="text-sm text-error-text"
      role="alert">{{ extractApiError(quotas.error.value).message }}</p>
  </div>
  <UAlert v-else-if="context.domain.value" color="neutral" variant="subtle" title="你没有管理此空间设置的权限" />
</template>
