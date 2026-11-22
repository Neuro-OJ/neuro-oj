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
    <!-- 基本设置卡片 -->
    <UCard>
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-info" class="size-5 text-primary" />
          <h2 class="font-semibold text-text">空间基本信息</h2>
        </div>
      </template>

      <form class="space-y-5" @submit.prevent="save">
        <AdminFormField label="空间名称" required hint="在导航栏、题库与空间目录中公开展示">
          <UInput
            v-model="form.name"
            class="w-full"
            maxlength="100"
            required
            aria-label="空间名称"
            placeholder="空间显示名称"
          />
        </AdminFormField>

        <AdminFormField label="空间简介" hint="向成员与访客介绍空间的教学定位或竞赛主题">
          <UTextarea
            v-model="form.description"
            class="w-full"
            maxlength="2000"
            aria-label="空间简介"
            placeholder="空间简介描述"
          />
        </AdminFormField>

        <!-- 访问政策快捷概览 -->
        <div class="rounded-lg border border-border bg-bg-sunken/40 p-4 text-xs space-y-2">
          <div class="flex items-center justify-between">
            <span class="font-semibold text-text flex items-center gap-1.5">
              <UIcon name="i-lucide-door-open" class="size-4 text-primary" />
              当前访问与加入政策
            </span>
            <NuxtLink
              :to="workspacePath(domain.slug, 'settings/access')"
              class="text-primary hover:underline font-medium inline-flex items-center gap-1"
            >
              前往专页配置
              <UIcon name="i-lucide-arrow-right" class="size-3" />
            </NuxtLink>
          </div>
          <p class="text-text-secondary">
            访问控制：<strong>{{ domain.configuration.access === 'public' ? '公开访问' : '仅成员进入' }}</strong> ·
            加入方式：<strong>{{ domain.configuration.join_policy === 'open' ? '直接加入' : domain.configuration.join_policy === 'approval' ? '申请审核' : '接受邀请' }}</strong> ·
            展示状态：<strong>{{ domain.configuration.discoverable ? '在公开目录展示' : '不在公开目录展示' }}</strong>
          </p>
        </div>

        <!-- 域类型信息 -->
        <div class="rounded-lg border border-border bg-bg-sunken/40 p-4 text-xs space-y-1.5">
          <div class="flex items-center gap-2">
            <span class="font-semibold text-text">域类型：</span>
            <UBadge color="primary" variant="subtle" size="xs">
              {{ WORKSPACE_PRESETS.find((p) => p.value === domain.preset)!.label }}
            </UBadge>
            <span class="text-text-muted">（创建后不可更改）</span>
          </div>
          <p class="text-text-secondary leading-relaxed">
            三种域均提供题库、题单、比赛、社区与域排行。教学域额外提供班级、作业与教练工作台。
          </p>
          <p v-if="!modules.community || !modules.classroom || !modules.assignment || !modules.analytics" class="text-text-muted pt-1">
            部分能力受实例全局政策限制，需联系系统管理员开启对应模块。
          </p>
        </div>

        <p v-if="error" class="text-sm text-error-text" role="alert">
          {{ error }} 未保存的修改仍保留在表单中。
        </p>

        <div class="pt-2 flex justify-end">
          <UButton
            type="submit"
            color="primary"
            :loading="saving"
            :disabled="domain.status !== 'active' || disabled || !dirty"
          >
            保存基本设置
          </UButton>
        </div>
      </form>
    </UCard>

    <!-- 空间生命周期治理卡片 -->
    <UCard v-if="canArchive && domain.slug !== 'main'" class="border-warning/30">
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-shield-alert" class="size-5 text-warning" />
          <h2 class="font-semibold text-text">空间生命周期状态</h2>
        </div>
      </template>

      <div class="space-y-4">
        <p class="text-sm text-text-secondary">
          当前空间状态：
          <UBadge :color="domain.status === 'active' ? 'success' : domain.status === 'archived' ? 'neutral' : 'error'" variant="subtle">
            {{ domain.status === 'active' ? '正常运行中' : domain.status === 'archived' ? '已归档' : '已暂停' }}
          </UBadge>
        </p>

        <div class="flex flex-wrap gap-3">
          <UButton v-if="domain.status !== 'active'" variant="outline" color="primary" @click="setStatus('active')">
            恢复使用
          </UButton>
          <UButton v-if="domain.status === 'active'" color="neutral" variant="outline" @click="setStatus('archived')">
            归档空间
          </UButton>
          <UButton v-if="domain.platform_admin && domain.status !== 'suspended'" color="error" variant="outline" @click="setStatus('suspended')">
            暂停空间
          </UButton>
        </div>
      </div>
    </UCard>
  </div>
</template>
