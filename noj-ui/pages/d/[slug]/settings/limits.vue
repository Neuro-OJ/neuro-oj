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
      <AdminPageHeader
        title="资源额度"
        description="成员数上限、题库条目数、存储空间大小与提交频次限制管理。"
        icon="i-lucide-gauge"
      >
        <template #actions>
          <UButton color="neutral" variant="outline" icon="i-lucide-refresh-cw" @click="reload">
            重新读取额度
          </UButton>
        </template>
      </AdminPageHeader>

      <UCard v-if="quotaDraft">
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-sliders" class="size-5 text-primary" />
            <h2 class="font-semibold text-text">成员、题库、存储与提交额度</h2>
          </div>
        </template>

        <form class="space-y-5" @submit.prevent="saveQuota">
          <p class="text-xs text-text-muted leading-relaxed">
            不限制本域额度时，仍受实例上限约束。域管理员只能降低有效额度；提高额度需平台治理权限。降低配额不会清除已有成员或历史记录。
          </p>

          <WorkspaceLimitFields
            v-model="quotaDraft"
            mode="domain_limits"
            :caps="quotas.data.value?.data?.caps"
            :effective="quotas.data.value?.data?.effective"
            :disabled="!context.writable.value || savingQuota"
            @valid="limitsValid = $event"
          />

          <!-- 当前实际资源消耗状态卡片 -->
          <div
            v-if="quotas.data.value?.data"
            class="space-y-3 rounded-lg border border-border bg-bg-sunken/40 p-4 text-xs tabular-nums"
          >
            <div class="flex items-center gap-2 text-text font-semibold">
              <UIcon name="i-lucide-activity" class="size-4 text-primary" />
              <span>当前空间资源实际用量</span>
            </div>

            <div class="grid gap-3 sm:grid-cols-3 pt-1">
              <div class="rounded-md bg-white dark:bg-bg-panel p-3 border border-border">
                <span class="text-text-muted block text-xs">成员用量</span>
                <p class="text-sm font-semibold text-text mt-1">
                  {{ quotas.data.value.data.usage.members }} <span class="text-xs font-normal text-text-muted">人已在班</span>
                </p>
                <span class="text-[11px] text-text-muted block mt-0.5">预约：{{ quotas.data.value.data.usage.reserved_members }} 人</span>
              </div>

              <div class="rounded-md bg-white dark:bg-bg-panel p-3 border border-border">
                <span class="text-text-muted block text-xs">题库条目</span>
                <p class="text-sm font-semibold text-text mt-1">
                  {{ quotas.data.value.data.usage.problems }} <span class="text-xs font-normal text-text-muted">道题</span>
                </p>
                <span class="text-[11px] text-text-muted block mt-0.5">预约：{{ quotas.data.value.data.usage.reserved_problems }} 道</span>
              </div>

              <div class="rounded-md bg-white dark:bg-bg-panel p-3 border border-border">
                <span class="text-text-muted block text-xs">存储空间占用</span>
                <p class="text-sm font-semibold text-text mt-1">
                  {{ (quotas.data.value.data.usage.storage_bytes / 1048576).toFixed(2) }} <span class="text-xs font-normal text-text-muted">MiB</span>
                </p>
                <span class="text-[11px] text-text-muted block mt-0.5">上传预约：{{ quotas.data.value.data.usage.reserved_storage_bytes }} 字节</span>
              </div>
            </div>

            <p class="text-[11px] text-text-muted pt-1">
              注：每分钟提交频次按当前滑动受理窗口限流，此处不将持久历史计数当作窗口用量。
            </p>
          </div>

          <p v-if="quotaError" class="text-sm text-error-text" role="alert">{{ quotaError }}</p>

          <div class="pt-2 flex justify-end">
            <UButton
              type="submit"
              color="primary"
              :loading="savingQuota"
              :disabled="!context.writable.value || !limitsValid || !quotaDirty"
            >
              保存配额配置
            </UButton>
          </div>
        </form>
      </UCard>

      <p v-if="quotas.error.value" class="text-sm text-error-text" role="alert">
        {{ extractApiError(quotas.error.value).message }}
      </p>
    </div>
    <UAlert v-else-if="context.status.value !== 'pending' && context.domain.value" color="neutral" variant="subtle" title="你没有管理此空间配额的权限" />
  </DomainSettingsShell>
</template>
