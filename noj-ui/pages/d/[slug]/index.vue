<script setup lang="ts">
import { WORKSPACE_PRESETS, workspacePath } from '~/utils/workspace';
import { workspaceNavigation } from '~/utils/workspace-navigation';
import { useToast } from '~/composables/useToast';
definePageMeta({ layout: 'workspace', middleware: 'workspace-context' });
const { domain, refresh } = useWorkspace();
const { isLoggedIn } = useAuth();
const workspace = useWorkspaceApi();
const { toast } = useToast();
const joining = ref(false);
const reason = ref('');
const shortcuts = computed(() =>
  domain.value
    ? workspaceNavigation(domain.value).filter((entry) =>
      (domain.value!.preset === 'education'
        ? ['my-learning', 'teaching', 'classrooms', 'problems']
        : ['problems', 'trainings', 'contests', 'community']).includes(entry.section)
    )
    : []
);
async function join() {
  if (!domain.value || joining.value) return;
  joining.value = true;
  try {
    const response = await workspace.join(domain.value.slug, reason.value);
    toast.success(response.data.request ? '加入申请已提交' : '已加入此空间');
    await refresh();
  } finally {
    joining.value = false;
  }
}
useSeoMeta({ title: () => domain.value?.name ?? '空间' });
</script>

<template>
  <div v-if="domain" class="grid gap-4 md:grid-cols-2">
    <AdminPageHeader class="md:col-span-2" :title="domain.name" :description="domain.description" icon="i-lucide-home" />
    <UCard class="md:col-span-2">
      <h2 class="mb-3 font-semibold text-text">开始使用</h2>
      <div class="flex flex-wrap gap-3">
        <UButton v-for="entry in shortcuts" :key="entry.to" :to="entry.to" :icon="entry.icon"
          variant="outline">{{ entry.label }}</UButton>
      </div>
    </UCard>
    <DomainHomeContent class="md:col-span-2" />
    <UCard>
      <h2 class="mb-3 font-semibold text-text">空间信息</h2>
      <dl class="grid grid-cols-2 gap-3 text-sm">
        <dt class="text-text-muted">域类型</dt>
        <dd>{{ WORKSPACE_PRESETS.find((p) => p.value === domain?.preset)?.label ?? '旧自定义域（待转换）' }}</dd>
        <dt class="text-text-muted">访问方式</dt>
        <dd>{{ domain.configuration.access === 'public' ? '公开访问' : '仅成员' }}</dd>
        <dt class="text-text-muted">加入方式</dt>
        <dd>{{ ({ open: '直接加入', approval: '申请审核', invite: '接受邀请' })[domain.configuration.join_policy] }}</dd>
      </dl>
    </UCard>
    <UCard v-if="domain.is_member">
      <h2 class="mb-3 font-semibold text-text">我的身份</h2>
      <p class="text-sm text-text-secondary">你已是此空间成员。成员权限以当前设置为准。</p>
      <UButton v-if="domain.platform_admin || domain.permissions.includes('domain:members')" class="mt-4"
        :to="workspacePath(domain.slug, 'members')" variant="outline">管理成员</UButton>
    </UCard>
    <UCard v-else-if="domain.status === 'active' && domain.configuration.join_policy !== 'invite'">
      <h2 class="mb-3 font-semibold text-text">加入空间</h2>
      <template v-if="isLoggedIn">
        <UTextarea v-if="domain.configuration.join_policy === 'approval'" v-model="reason" class="mb-3 w-full"
          placeholder="简要说明加入理由" aria-label="加入理由" />
        <UButton :loading="joining"
          @click="join">{{ domain.configuration.join_policy === 'approval' ? '提交申请' : '加入此空间' }}</UButton>
      </template>
      <UButton v-else :to="{ path: '/login', query: { redirect: workspacePath(domain.slug) } }">登录后加入</UButton>
    </UCard>
  </div>
</template>
