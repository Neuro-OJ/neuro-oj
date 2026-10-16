<script setup lang="ts">
import { extractApiError } from '~/utils/apiError';
import { WORKSPACE_PRESETS, workspacePath } from '~/utils/workspace';
import type { WorkspaceConfiguration, WorkspaceDetail } from '~/utils/workspace';
import { useToast } from '~/composables/useToast';
import { computed, onScopeDispose } from 'vue';
const props = withDefaults(
  defineProps<{
    domain: WorkspaceDetail;
    modules: WorkspaceConfiguration['features'];
    canArchive: boolean;
    disabled?: boolean;
  }>(),
  {
    disabled: false,
  },
);
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
});
const baseRevision = ref(props.domain.revision);
const savedSnapshot = ref(JSON.stringify(form));
const dirty = computed(() => JSON.stringify(form) !== savedSnapshot.value);
defineExpose({ dirty });
const saving = ref(false);
const error = ref('');
async function save() {
  if (saving.value || props.disabled || props.domain.status !== 'active') return;
  saving.value = true;
  error.value = '';
  try {
    await workspaces.update(target.slug, { name: form.name, description: form.description }, baseRevision.value);
    if (!isCurrent()) return;
    savedSnapshot.value = JSON.stringify(form);
    toast.success('基本设置已保存');
    emit('saved');
  } catch (cause) {
    error.value = extractApiError(cause).message;
  } finally {
    saving.value = false;
  }
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
        <div class="rounded border border-border bg-bg-sunken p-3 text-xs space-y-1.5">
          <div class="flex items-center justify-between">
            <span class="font-medium text-text">访问与加入政策</span>
            <NuxtLink
              :to="workspacePath(domain.slug, 'settings/access')"
              class="text-primary hover:underline font-medium inline-flex items-center gap-1"
            >
              前往专页配置
              <UIcon name="i-lucide-arrow-right" class="size-3" />
            </NuxtLink>
          </div>
          <p class="text-text-secondary">
            当前配置：{{ domain.configuration.access === 'public' ? '公开访问' : '仅成员进入' }} ·
            {{ domain.configuration.join_policy === 'open' ? '直接加入' : domain.configuration.join_policy === 'approval' ? '申请审核' : '接受邀请' }} ·
            {{ domain.configuration.discoverable ? '在公开目录展示' : '不在公开目录展示' }}
          </p>
        </div>
        <div class="rounded border border-border bg-bg-sunken p-3 text-sm">
          <p
            class="font-medium">域类型：{{ WORKSPACE_PRESETS.find((p) => p.value === domain.preset)!.label }} · 创建后固定</p>
          <p
            class="mt-2 text-text-secondary">三种域均提供题库、题单、比赛、社区与域排行。教学域额外提供班级、作业与教练工作台。</p>
          <p v-if="!modules.community || !modules.classroom || !modules.assignment || !modules.analytics"
            class="mt-2 text-text-muted">部分能力受实例政策限制，需联系实例管理员。</p>
        </div>
        <p v-if="error" class="text-sm text-error-text" role="alert">{{ error }} 未保存的修改仍保留在表单中。</p>
        <UButton type="submit" :loading="saving" :disabled="domain.status !== 'active' || disabled">保存基本设置</UButton>
      </form>
    </UCard>
    <UCard v-if="canArchive && domain.slug !== 'main'" class="rounded">
      <h2 class="mb-3 font-semibold text-text">空间状态</h2>
      <div class="flex flex-wrap gap-3">
        <UButton v-if="domain.status !== 'active'" variant="outline" @click="setStatus('active')">恢复使用</UButton>
        <UButton v-if="domain.status === 'active'" color="neutral" variant="outline"
          @click="setStatus('archived')">归档</UButton>
        <UButton v-if="domain.platform_admin && domain.status !== 'suspended'" color="error"
          variant="outline" @click="setStatus('suspended')">暂停</UButton>
      </div>
    </UCard>
  </div>
</template>
