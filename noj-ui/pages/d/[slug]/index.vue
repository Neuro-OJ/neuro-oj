<script setup lang="ts">
import { workspacePath } from '~/utils/workspace';
import { useToast } from '~/composables/useToast';
definePageMeta({ layout: 'workspace', middleware: 'workspace-context', workspaceWidth: 'home' });
const { domain, refresh } = useWorkspace();
const { user, isLoggedIn } = useAuth();
const workspace = useWorkspaceApi(), { toast } = useToast();
const joining = ref(false), reason = ref('');
async function join() {
  if (!domain.value || joining.value) return;
  joining.value = true;
  try {
    const response = await workspace.join(domain.value.slug, reason.value);
    toast.success(response.data.request ? '加入申请已提交' : '已加入此域');
    await refresh();
  } finally { joining.value = false; }
}
useSeoMeta({ title: () => domain.value?.name ?? 'Neuro OJ' });
</script>
<template>
  <div v-if="domain" :key="domain.id + ':' + (user?.id ?? 'guest')" class="overflow-hidden rounded border border-border bg-bg-panel shadow-card">
    <div class="flex min-h-[320px] flex-col lg:flex-row">
      <Carousel :domain-slug="domain.slug" :title="domain.name" :description="domain.description" />
      <HomepageCheckIn />
    </div>
    <AnnouncementSection :domain-slug="domain.slug" />
    <DomainHomeContent />
    <div v-if="!domain.is_member && domain.status === 'active' && domain.configuration.join_policy !== 'invite'"
      class="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 text-sm sm:px-6">
      <span class="text-text-secondary">加入 {{ domain.name }}</span>
      <template v-if="isLoggedIn">
        <UInput v-if="domain.configuration.join_policy === 'approval'" v-model="reason" placeholder="简要说明加入理由" aria-label="加入理由" />
        <UButton size="sm" variant="outline" :loading="joining" @click="join">{{ domain.configuration.join_policy === 'approval' ? '申请加入' : '加入此域' }}</UButton>
      </template>
      <UButton v-else size="sm" variant="outline" :to="{ path: '/login', query: { redirect: workspacePath(domain.slug) } }">登录后加入</UButton>
    </div>
    <div class="grid grid-cols-1 gap-4 p-4 lg:grid-cols-2">
      <RandomProblems :domain-slug="domain.slug" />
      <LatestSubmissions :domain-slug="domain.slug" />
      <FollowingFeed v-if="domain.configuration.features.community" class="min-h-48 lg:col-span-full" />
    </div>
  </div>
</template>
