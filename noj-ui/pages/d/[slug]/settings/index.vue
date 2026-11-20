<script setup lang="ts">
import { extractApiError } from '~/utils/apiError';
import { workspaceCacheKey, workspacePath } from '~/utils/workspace';
import type { WorkspaceConfiguration } from '~/utils/workspace';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const context = useWorkspace();
const route = useRoute();
const { user } = useAuth();
const workspaces = useWorkspaceApi();
const { dialog } = useDialog();
const general = ref<{ dirty: boolean } | null>(null);
const formVersion = ref(0);

const permitted = computed(() =>
  !!context.domain.value &&
  (context.domain.value.platform_admin || context.domain.value.permissions.includes('domain:settings'))
);

watch(
  () => route.hash,
  (hash) => {
    if (hash === '#access' && context.slug.value) {
      navigateTo(workspacePath(context.slug.value, 'settings/access'), { replace: true });
    } else if (hash === '#limits' && context.slug.value) {
      navigateTo(workspacePath(context.slug.value, 'settings/limits'), { replace: true });
    }
  },
  { immediate: true },
);

const key = computed(() => workspaceCacheKey(context.slug.value ?? '', user.value?.id ?? null, 'settings-policy'));
const policy = await useAsyncData<{ data: { modules: WorkspaceConfiguration['features'] } | null }>(
  key,
  () => permitted.value ? workspaces.instance() : Promise.resolve({ data: null }),
  { watch: [permitted] },
);

useUnsavedChanges(() => !!general.value?.dirty);

async function refreshGeneral() {
  await context.refresh();
  if (!context.error.value) {
    formVersion.value++;
  }
}

async function reload() {
  if (
    general.value?.dirty &&
    !await dialog.confirm('重新读取会替换本页尚未保存的修改。', { title: '重新读取设置' })
  ) return;
  await context.refresh();
  if (!context.error.value) {
    formVersion.value++;
  }
}

useSeoMeta({ title: '基本信息 - 域设置' });
</script>

<template>
  <DomainSettingsShell>
    <div v-if="permitted && context.domain.value" class="space-y-6">
      <AdminPageHeader title="基本信息" description="空间名称与简介。" icon="i-lucide-settings">
        <template #actions>
          <UButton color="neutral" variant="outline" @click="reload">重新读取设置</UButton>
        </template>
      </AdminPageHeader>
      <UAlert v-if="policy.error.value" color="error" :title="extractApiError(policy.error.value).message" />
      <WorkspaceSettingsForm v-if="policy.data.value?.data" ref="general"
        :key="`${context.domain.value.id}:${context.domain.value.actor_id}:${formVersion}`"
        :domain="context.domain.value" :modules="policy.data.value.data.modules"
        :can-archive="false" :disabled="!context.writable.value" @saved="refreshGeneral" />
    </div>
    <UAlert v-else-if="context.status.value !== 'pending' && context.domain.value" color="neutral" variant="subtle" title="你没有管理此域设置的权限" />
  </DomainSettingsShell>
</template>
