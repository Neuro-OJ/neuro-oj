<script setup lang="ts">
import { initialDomainSlug } from '~/utils/domain-navigation';
import { workspacePath } from '~/utils/workspace';
definePageMeta({ layout: false });
const auth = useAuth(), workspaces = useWorkspaceApi();
await auth.ensureAuthReady();
const policy = await workspaces.instance();
if (policy.data.access === 'authenticated' && !auth.user.value) {
  await navigateTo({ path: '/login', query: { redirect: '/' } }, { replace: true });
} else {
  const available = auth.user.value ? (await workspaces.list(true)).data : [];
  await navigateTo(workspacePath(initialDomainSlug(policy.data, available)), { replace: true });
}
</script>
<template>
  <div class="flex min-h-screen items-center justify-center text-text-muted" role="status">正在进入工作空间…</div>
</template>
