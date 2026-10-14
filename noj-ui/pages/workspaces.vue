<script setup lang="ts">
import { extractApiError } from '~/utils/apiError';
import { WORKSPACE_PRESETS, workspaceCacheKey, workspacePath } from '~/utils/workspace';
import type { WorkspacePreset } from '~/utils/workspace';
import { useToast } from '~/composables/useToast';
const { user } = useAuth();
const workspaces = useWorkspaceApi();
const { toast } = useToast();
const key = computed(() => workspaceCacheKey('', user.value?.id ?? null, 'directory'));
const { data, status, error, refresh } = await useAsyncData(key, async () => {
  const results = await Promise.allSettled([
    workspaces.list(),
    user.value ? workspaces.list(true) : Promise.resolve({ data: [] }),
    workspaces.instance(),
  ]);
  const discover = results[0];
  const mine = results[1];
  const policy = results[2];
  if (discover.status === 'rejected' && (!user.value || mine.status === 'rejected')) throw discover.reason;
  return {
    discovered: discover.status === 'fulfilled' ? discover.value.data : [],
    mine: mine.status === 'fulfilled' ? mine.value.data : [],
    policy: policy.status === 'fulfilled' ? policy.value.data : null,
  };
});
const canCreate = computed(() =>
  !!user.value && (user.value.is_admin || data.value?.policy?.domain_creation_policy === 'open')
);
const canRequest = computed(() =>
  !!user.value && data.value?.policy?.domain_creation_policy === 'approval' && !canCreate.value
);
const form = reactive({ slug: '', name: '', preset: 'community' as WorkspacePreset, description: '', reason: '' });
const creating = ref(false);
const showCreate = ref(false);
const createError = ref('');
async function create() {
  if (creating.value) return;
  creating.value = true;
  createError.value = '';
  try {
    if (canRequest.value) {
      await workspaces.requestCreation({ slug: form.slug, name: form.name, preset: form.preset, reason: form.reason });
      toast.success('创建申请已提交');
      showCreate.value = false;
    } else {
      const response = await workspaces.create({
        slug: form.slug,
        name: form.name,
        preset: form.preset,
        description: form.description,
      });
      await navigateTo(workspacePath(response.data.slug));
    }
  } catch (cause) {
    createError.value = extractApiError(cause).message;
  } finally {
    creating.value = false;
  }
}
async function enter(slug: string) {
  if (user.value) await workspaces.remember(slug);
  await navigateTo(workspacePath(slug));
}
useSeoMeta({ title: '空间' });
</script>

<template>
  <div class="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
    <AdminPageHeader title="空间" description="在不同社区、学校或团队中使用各自的资源与身份。"
      icon="i-lucide-building-2">
      <template #actions>
        <UButton v-if="canCreate || canRequest" icon="i-lucide-plus"
          @click="showCreate = true">{{ canRequest ? '申请创建' : '创建空间' }}</UButton>
      </template>
    </AdminPageHeader>
    <AsyncContent class="mt-6" :status="status === 'pending' ? 'loading' : error ? 'error' : 'data'"
      :error="error ? extractApiError(error).message : undefined" @retry="refresh()">
      <section v-if="user" class="mb-8">
        <h2 class="mb-4 text-lg font-semibold text-text">我的空间</h2>
        <p v-if="!data?.mine.length" class="text-sm text-text-muted">你还没有加入空间，可以接受邀请或浏览公开入口。</p>
        <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <UCard v-for="space in data?.mine" :key="space.id">
            <h3 class="font-semibold text-text">{{ space.name }}</h3>
            <p class="mt-2 text-sm text-text-secondary">{{ space.description }}</p>
            <UButton class="mt-4" variant="outline" @click="enter(space.slug)">进入空间</UButton>
          </UCard>
        </div>
      </section>
      <section>
        <h2 class="mb-4 text-lg font-semibold text-text">发现空间</h2>
        <p v-if="!data?.discovered.length" class="text-sm text-text-muted">暂无可发现的空间。</p>
        <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <UCard v-for="space in data?.discovered" :key="space.id">
            <h3 class="font-semibold text-text">{{ space.name }}</h3>
            <p class="mt-2 text-sm text-text-secondary">{{ space.description }}</p>
            <UButton class="mt-4" :to="workspacePath(space.slug)" color="neutral" variant="outline">查看空间</UButton>
          </UCard>
        </div>
      </section>
    </AsyncContent>
    <UModal v-model:open="showCreate" :title="canRequest ? '申请创建空间' : '创建空间'">
      <template #body>
        <form class="space-y-4" @submit.prevent="create">
          <AdminFormField label="名称" required>
            <UInput v-model="form.name" class="w-full" maxlength="100" required aria-label="空间名称" />
          </AdminFormField>
          <AdminFormField label="网址标识" required hint="3–32 位小写字母、数字或连字符，创建后固定。">
            <UInput v-model="form.slug" class="w-full" required pattern="[a-z][a-z0-9-]{1,30}[a-z0-9]"
              aria-label="空间网址标识" />
          </AdminFormField>
          <AdminFormField label="域类型（创建后固定）">
            <USelect v-model="form.preset" :items="WORKSPACE_PRESETS.map(p => ({ label: p.label, value: p.value }))"
              class="w-full" aria-label="域类型" />
          </AdminFormField>
          <AdminFormField :label="canRequest ? '申请理由' : '简介'">
            <UTextarea v-if="canRequest" v-model="form.reason" class="w-full" required aria-label="创建申请理由" />
            <UTextarea v-else v-model="form.description" class="w-full" maxlength="2000" aria-label="空间简介" />
          </AdminFormField>
          <p v-if="createError" class="text-sm text-error-text" role="alert">{{ createError }}</p>
          <UButton type="submit" :loading="creating">{{ canRequest ? '提交申请' : '创建' }}</UButton>
        </form>
      </template>
    </UModal>
  </div>
</template>
