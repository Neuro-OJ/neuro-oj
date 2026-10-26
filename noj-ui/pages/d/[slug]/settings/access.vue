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
      <AdminPageHeader title="访问与加入" description="设置空间的访问范围、加入方式与发现性。" icon="i-lucide-door-open">
        <template #actions>
          <UButton color="neutral" variant="outline" @click="reload">重新读取设置</UButton>
        </template>
      </AdminPageHeader>

      <UCard class="rounded">
        <form class="space-y-5" @submit.prevent="save">
          <AdminFormField label="访问方式" hint="决定哪些用户可以浏览此空间的内容">
            <USelect
              v-model="form.access"
              :items="[
                { label: '公开访问（游客与所有登录用户可浏览）', value: 'public' },
                { label: '仅成员进入（只有获准加入空间的成员可访问）', value: 'members' }
              ]"
              class="w-full max-w-[400px]"
              aria-label="空间访问方式"
            />
          </AdminFormField>

          <AdminFormField label="加入方式" hint="决定新成员如何加入本空间">
            <USelect
              v-model="form.join_policy"
              :items="[
                { label: '直接加入（用户点击加入即可成为成员）', value: 'open' },
                { label: '申请审核（用户需提交申请，经管理者审核批准后加入）', value: 'approval' },
                { label: '接受邀请（仅能通过管理员签发的邀请链接加入）', value: 'invite' }
              ]"
              class="w-full max-w-[400px]"
              aria-label="加入方式"
            />
          </AdminFormField>

          <div class="pt-2">
            <UCheckbox v-model="form.discoverable" label="在公开目录展示此空间（未勾选时不在探索列表显示）" />
          </div>

          <div class="rounded border border-border bg-bg-sunken p-3 text-sm">
            <p class="font-medium text-text">
              域类型：{{ WORKSPACE_PRESETS.find((p) => p.value === context.domain.value?.preset)?.label ?? context.domain.value?.preset }} · 创建后固定
            </p>
            <p class="mt-1 text-text-secondary">
              三种域均提供题库、题单、比赛、社区与域排行。教学域额外提供班级、作业与教练工作台。
            </p>
          </div>

          <p v-if="error" class="text-sm text-error-text" role="alert">{{ error }} 未保存的修改仍保留在表单中。</p>

          <UButton type="submit" :loading="saving" :disabled="!context.writable.value">
            保存访问控制
          </UButton>
        </form>
      </UCard>
    </div>
    <UAlert v-else-if="context.status.value !== 'pending' && context.domain.value" color="neutral" variant="subtle" title="你没有管理此域访问设置的权限" />
  </DomainSettingsShell>
</template>
