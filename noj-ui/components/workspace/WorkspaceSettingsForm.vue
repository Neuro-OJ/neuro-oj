<script setup lang="ts">
import { extractApiError } from '~/utils/apiError';
import { WORKSPACE_PRESETS } from '~/utils/workspace';
import type { WorkspaceConfiguration, WorkspaceDetail, WorkspacePreset } from '~/utils/workspace';
import { useToast } from '~/composables/useToast';
import { onScopeDispose } from 'vue';
const props = defineProps<
  { domain: WorkspaceDetail; modules: WorkspaceConfiguration['features']; canArchive: boolean }
>();
const emit = defineEmits<{ saved: [] }>();
const workspaces = useWorkspaceApi();
const { toast } = useToast();
const { dialog } = useDialog();
const target = { slug: props.domain.slug, actor: props.domain.actor_id };
let mounted = true;
onScopeDispose(() => {
  mounted = false;
});
const isCurrent = () => mounted && props.domain.slug === target.slug && props.domain.actor_id === target.actor;
const form = reactive({
  name: props.domain.name,
  description: props.domain.description,
  configuration: { ...props.domain.configuration, features: { ...props.domain.configuration.features } },
});
const baseRevision = ref(props.domain.revision);
const savedSnapshot = ref(JSON.stringify(form));
useUnsavedChanges(() => JSON.stringify(form) !== savedSnapshot.value);
const saving = ref(false);
const error = ref('');
const preset = ref<WorkspacePreset>(props.domain.preset);
const preview = ref<{ revision: number; changes: Array<{ key: string; before: unknown; after: unknown }> } | null>(
  null,
);
const featureOptions = [{ key: 'community', label: '社区' }, { key: 'classroom', label: '班级' }, {
  key: 'assignment',
  label: '作业',
}, { key: 'analytics', label: '教学学情' }] as const;
const fieldLabels: Record<string, string> = {
  access: '访问方式',
  discoverable: '公开目录',
  join_policy: '加入方式',
  homepage: '首页',
  'features.community': '社区',
  'features.classroom': '班级',
  'features.assignment': '作业',
  'features.analytics': '教学学情',
};
const valueLabels: Record<string, string> = {
  public: '公开',
  members: '仅成员',
  open: '直接加入',
  approval: '申请审核',
  invite: '邀请',
  overview: '概览',
  community: '社区',
  teaching: '教学工作台',
  training: '题单',
};
const valueText = (value: unknown) =>
  typeof value === 'boolean' ? value ? '启用' : '关闭' : valueLabels[String(value)] ?? String(value);
function dependencies() {
  if (!form.configuration.features.classroom) form.configuration.features.assignment = false;
  if (!form.configuration.features.assignment) form.configuration.features.analytics = false;
}
async function save() {
  if (saving.value) return;
  saving.value = true;
  error.value = '';
  dependencies();
  try {
    await workspaces.update(target.slug, form, baseRevision.value);
    if (!isCurrent()) return;
    savedSnapshot.value = JSON.stringify(form);
    toast.success('空间设置已保存');
    emit('saved');
  } catch (cause) {
    error.value = extractApiError(cause).message;
  } finally {
    saving.value = false;
  }
}
async function previewPreset() {
  const selected = preset.value;
  const response = await workspaces.previewPreset(target.slug, selected);
  if (isCurrent() && preset.value === selected) preview.value = response.data;
}
async function applyPreset() {
  const selected = preset.value;
  const selection = preview.value;
  if (
    !preview.value ||
    !await dialog.confirm('按预览差异修改空间配置？成员、资源和已有历史不会被删除。', { title: '应用初始模板' })
  ) return;
  if (!selection || !isCurrent() || preset.value !== selected || preview.value !== selection) return;
  await workspaces.applyPreset(target.slug, selected, selection.revision);
  if (!isCurrent()) return;
  preview.value = null;
  emit('saved');
  toast.success('模板配置已应用');
}
async function setStatus(status: WorkspaceDetail['status']) {
  const revision = props.domain.revision;
  if (
    !await dialog.confirm(
      status === 'archived'
        ? '归档后保留授权历史读取，停止新业务写入。'
        : status === 'suspended'
        ? '暂停后普通成员不能进入此空间。'
        : '恢复此空间的正常使用？',
      { title: status === 'active' ? '恢复空间' : status === 'archived' ? '归档空间' : '暂停空间' },
    )
  ) return;
  if (!isCurrent()) return;
  await workspaces.status(target.slug, status, revision);
  if (!isCurrent()) return;
  emit('saved');
}
</script>

<template>
  <div class="space-y-6">
    <UCard class="rounded">
      <form class="space-y-4" @submit.prevent="save">
        <h2 class="font-semibold text-text">基本设置</h2>
        <AdminFormField label="名称" required>
          <UInput v-model="form.name" class="w-full" maxlength="100" required aria-label="空间名称" />
        </AdminFormField>
        <AdminFormField label="简介">
          <UTextarea v-model="form.description" class="w-full" maxlength="2000" aria-label="空间简介" />
        </AdminFormField>
        <div class="grid gap-4 sm:grid-cols-2">
          <AdminFormField label="访问方式">
            <USelect v-model="form.configuration.access"
              :items="[{ label: '公开访问', value: 'public' }, { label: '仅成员进入', value: 'members' }]"
              class="w-full" aria-label="空间访问方式" />
          </AdminFormField>
          <AdminFormField label="加入方式">
            <USelect v-model="form.configuration.join_policy"
              :items="[{ label: '直接加入', value: 'open' }, { label: '申请审核', value: 'approval' }, { label: '接受邀请', value: 'invite' }]"
              class="w-full" aria-label="加入方式" />
          </AdminFormField>
        </div>
        <UCheckbox v-model="form.configuration.discoverable" label="在公开目录展示此空间" />
        <fieldset class="space-y-2">
          <legend class="mb-2 text-sm font-semibold text-text">可选功能</legend>
          <UCheckbox v-for="feature in featureOptions" :key="feature.key"
            v-model="form.configuration.features[feature.key]" :label="feature.label" :disabled="!modules[feature.key]"
            @update:model-value="dependencies" />
        </fieldset>
        <AdminFormField label="首页">
          <USelect v-model="form.configuration.homepage"
            :items="[{ label: '概览', value: 'overview' }, { label: '社区', value: 'community' }, { label: '教学工作台', value: 'teaching' }, { label: '题单', value: 'training' }]"
            class="w-full" aria-label="空间首页" />
        </AdminFormField>
        <p v-if="error" class="text-sm text-error-text" role="alert">{{ error }} 未保存的修改仍保留在表单中。</p>
        <UButton type="submit" :loading="saving" :disabled="domain.status !== 'active'">保存设置</UButton>
      </form>
    </UCard>
    <UCard v-if="domain.status === 'active'" class="rounded">
      <h2 class="mb-3 font-semibold text-text">重新应用模板</h2>
      <div class="flex flex-wrap gap-3">
        <USelect v-model="preset" :items="WORKSPACE_PRESETS.map(p => ({ label: p.label, value: p.value }))"
          class="min-w-56" aria-label="重新应用模板" @update:model-value="preview = null" />
        <UButton color="neutral" variant="outline" @click="previewPreset">预览差异</UButton>
      </div>
      <div v-if="preview" class="mt-4 space-y-2">
        <p v-if="!preview.changes.length" class="text-sm text-text-muted">配置没有差异。</p>
        <p v-for="change in preview.changes" :key="change.key"
          class="text-sm text-text-secondary">{{ fieldLabels[change.key] ?? change.key }}：{{ valueText(change.before) }} → {{ valueText(change.after) }}</p>
        <UButton :disabled="!preview.changes.length" @click="applyPreset">应用这些修改</UButton>
      </div>
    </UCard>
    <UCard v-if="canArchive" class="rounded">
      <h2 class="mb-3 font-semibold text-text">空间状态</h2>
      <div class="flex flex-wrap gap-3">
        <UButton v-if="domain.status !== 'active'" variant="outline" @click="setStatus('active')">恢复使用</UButton>
        <UButton v-if="domain.status === 'active' && domain.slug !== 'main'" color="neutral" variant="outline"
          @click="setStatus('archived')">归档</UButton>
        <UButton v-if="domain.platform_admin && domain.status !== 'suspended' && domain.slug !== 'main'" color="error"
          variant="outline" @click="setStatus('suspended')">暂停</UButton>
      </div>
    </UCard>
  </div>
</template>
