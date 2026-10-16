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
  } finally {
    joining.value = false;
  }
}
useSeoMeta({ title: () => domain.value?.name ?? 'Neuro OJ' });
</script>
<template>
  <div v-if="domain" :key="domain.id + ':' + (user?.id ?? 'guest')" class="space-y-6">
    <!-- 头部核心区：轮播与签到 -->
    <section class="overflow-hidden rounded-lg border border-border bg-bg-panel shadow-card">
      <div class="flex min-h-[320px] flex-col lg:flex-row">
        <Carousel :domain-slug="domain.slug" :title="domain.name" :description="domain.description" />
        <HomepageCheckIn />
      </div>
    </section>

    <!-- 加入空间引导条（非成员且非仅邀请） -->
    <section
      v-if="!domain.is_member && domain.status === 'active' && domain.configuration.join_policy !== 'invite'"
      class="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-primary/20 bg-primary-bg/40 px-5 py-3.5 text-sm shadow-xs"
      aria-label="加入空间"
    >
      <div class="flex items-center gap-2.5">
        <UIcon name="i-lucide-user-plus" class="size-4 text-primary shrink-0" />
        <span class="text-text font-medium">加入 {{ domain.name }} 开启本空间解题、教学与竞赛权限</span>
      </div>
      <div class="flex items-center gap-2.5">
        <template v-if="isLoggedIn">
          <UInput
            v-if="domain.configuration.join_policy === 'approval'"
            v-model="reason"
            size="sm"
            placeholder="简要说明加入理由"
            aria-label="加入理由"
            class="w-56"
          />
          <UButton
            size="sm"
            color="primary"
            :loading="joining"
            @click="join"
          >
            {{ domain.configuration.join_policy === 'approval' ? '申请加入' : '加入此空间' }}
          </UButton>
        </template>
        <UButton
          v-else
          size="sm"
          color="primary"
          :to="{ path: '/login', query: { redirect: workspacePath(domain.slug) } }"
        >
          登录后加入
        </UButton>
      </div>
    </section>

    <!-- 空间公告 -->
    <div class="overflow-hidden rounded-lg border border-border bg-bg-panel shadow-card">
      <AnnouncementSection :domain-slug="domain.slug" />
    </div>

    <!-- 教学待办与进行中任务 -->
    <div class="overflow-hidden rounded-lg border border-border bg-bg-panel shadow-card">
      <DomainHomeContent />
    </div>

    <!-- 推荐与实时动态网格 -->
    <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <RandomProblems :domain-slug="domain.slug" />
      <LatestSubmissions :domain-slug="domain.slug" />
      <FollowingFeed v-if="domain.configuration.features.community" class="min-h-48 lg:col-span-full" />
    </div>
  </div>
</template>
