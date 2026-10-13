<script setup lang="ts">
import { extractApiError } from '~/utils/apiError';
definePageMeta({ layout: 'admin', middleware: 'admin', ssr: false });
const api = useInstanceAdmin(), { user } = useAuth();
const generation = ref(0);
const settings = await useAsyncData(() => `instance-settings:${user.value?.id}`, () => api.settings());
async function reload() {
  await settings.refresh();
  if (!settings.error.value) generation.value++;
}
useSeoMeta({ title: '实例政策与空间治理' });
</script>
<template>
  <div class="space-y-6">
    <AdminPageHeader title="实例政策与空间治理"
      description="实例访问、注册、模块和资源上限；平台治理操作明确指向目标空间。" icon="i-lucide-building-2">
      <template #actions>
        <UButton variant="outline" @click="reload">重新读取政策</UButton>
      </template>
    </AdminPageHeader>
    <p class="text-sm text-text-muted">重新读取政策会替换当前政策表单，请先保存需要保留的修改。</p>
    <AsyncContent
      :status="settings.error.value ? 'error' : settings.status.value === 'pending' ? 'loading' : settings.data.value ? 'data' : 'empty'"
      :error="settings.error.value ? extractApiError(settings.error.value).message : undefined"
      @retry="settings.refresh()">
      <InstancePolicyForm v-if="settings.data.value" :key="`${user?.id}:${generation}`"
        :initial="settings.data.value.data" />
    </AsyncContent>
    <InstanceDomainGovernance :key="user?.id" />
  </div>
</template>
