<script setup lang="ts">
import { extractApiError } from '~/utils/apiError';
import { WORKSPACE_PRESETS } from '~/utils/workspace';
import { useToast } from '~/composables/useToast';

definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const context = useWorkspace();
const captureAction = useWorkspaceActionScope();
const workspaces = useWorkspaceApi();
const { toast } = useToast();
const { dialog } = useDialog();

const permitted = computed(() =>
  !!context.domain.value &&
  (context.domain.value.platform_admin || context.domain.value.permissions.includes('domain:settings'))
);

const form = reactive({
  access: context.domain.value?.configuration.access ?? 'members',
  join_policy: context.domain.value?.configuration.join_policy ?? 'invite',
  discoverable: context.domain.value?.configuration.discoverable ?? false,
});

const baseRevision = ref(context.domain.value?.revision ?? 0);
const savedSnapshot = ref(JSON.stringify(form));
const dirty = computed(() => JSON.stringify(form) !== savedSnapshot.value);

useUnsavedChanges(() => dirty.value);

watch(
  () => context.domain.value,
  (val) => {
    if (val && !dirty.value) {
      form.access = val.configuration.access;
      form.join_policy = val.configuration.join_policy;
      form.discoverable = val.configuration.discoverable;
      baseRevision.value = val.revision;
      savedSnapshot.value = JSON.stringify(form);
    }
  },
  { immediate: true },
);

const saving = ref(false);
const error = ref('');

async function save() {
  if (saving.value || !context.writable.value) return;
  saving.value = true;
  error.value = '';
  const action = captureAction();
  try {
    await workspaces.update(
      action.slug,
      {
        configuration: {
          access: form.access,
          join_policy: form.join_policy,
          discoverable: form.discoverable,
        },
      },
      baseRevision.value,
    );
    if (!action.isCurrent()) return;
    savedSnapshot.value = JSON.stringify(form);
    toast.success('访问与加入政策已保存');
    await context.refresh();
  } catch (cause) {
    error.value = extractApiError(cause).message;
  } finally {
    saving.value = false;
  }
}

async function reload() {
  if (dirty.value && !await dialog.confirm('重新读取会替换本页尚未保存的修改。', { title: '重新读取政策' })) return;
  await context.refresh();
  if (context.domain.value) {
    form.access = context.domain.value.configuration.access;
    form.join_policy = context.domain.value.configuration.join_policy;
    form.discoverable = context.domain.value.configuration.discoverable;
    baseRevision.value = context.domain.value.revision;
    savedSnapshot.value = JSON.stringify(form);
  }
}

useSeoMeta({ title: '访问控制 - 域设置' });
</script>

<template>
  <DomainSettingsShell>
    <div v-if="permitted && context.domain.value" class="space-y-6 max-w-[768px]">
      <AdminPageHeader
        title="访问与加入政策"
        description="设置空间的访客可见性、新成员加入审核策略与探索发现性。"
        icon="i-lucide-door-open"
      >
        <template #actions>
          <UButton color="neutral" variant="outline" icon="i-lucide-refresh-cw" @click="reload">
            重新读取
          </UButton>
        </template>
      </AdminPageHeader>

      <UCard>
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-shield-check" class="size-5 text-primary" />
            <h2 class="font-semibold text-text">访问权限与加入规则</h2>
          </div>
        </template>

        <form class="space-y-5" @submit.prevent="save">
          <AdminFormField label="空间访问范围" hint="决定哪些用户可以浏览本空间内的题目、比赛与社区内容">
            <USelect
              v-model="form.access"
              :items="[
                { label: '公开访问（游客与全站登录用户均可浏览）', value: 'public' },
                { label: '仅成员进入（仅限已加入本空间的成员访问）', value: 'members' }
              ]"
              class="w-full"
              aria-label="空间访问方式"
            />
          </AdminFormField>

          <AdminFormField label="新成员加入政策" hint="控制新用户加入本空间时的审批流程">
            <USelect
              v-model="form.join_policy"
              :items="[
                { label: '直接加入（用户点击即可自动加入）', value: 'open' },
                { label: '申请审核（需管理员或助教在审核列表批准）', value: 'approval' },
                { label: '仅凭邀请（必须持有管理员生成的邀请码或邀请链接）', value: 'invite' }
              ]"
              class="w-full"
              aria-label="加入方式"
            />
          </AdminFormField>

          <div class="rounded-lg border border-border bg-bg-sunken/40 p-4">
            <UCheckbox
              v-model="form.discoverable"
              label="在平台公开目录与探索推荐中展示此空间"
              help="未勾选时，访客只能通过直接输入空间 URL 访问，不会在广场或推荐列表曝光。"
            />
          </div>

          <div class="rounded-lg border border-border bg-bg-sunken/40 p-3.5 text-xs space-y-1">
            <p class="font-medium text-text">
              当前域类型：{{ WORKSPACE_PRESETS.find((p) => p.value === context.domain.value?.preset)?.label ?? context.domain.value?.preset }}（创建后固定）
            </p>
            <p class="text-text-secondary leading-relaxed">
              所有类型域均提供题库、题单、比赛、社区与排行；教学域额外提供班级与教练作业工作台。
            </p>
          </div>

          <p v-if="error" class="text-sm text-error-text" role="alert">{{ error }} 未保存的修改仍保留在表单中。</p>

          <div class="pt-2 flex justify-end">
            <UButton
              type="submit"
              color="primary"
              :loading="saving"
              :disabled="!context.writable.value || !dirty"
            >
              保存访问控制政策
            </UButton>
          </div>
        </form>
      </UCard>
    </div>
    <UAlert v-else-if="context.status.value !== 'pending' && context.domain.value" color="neutral" variant="subtle" title="你没有管理此域访问设置的权限" />
  </DomainSettingsShell>
</template>
