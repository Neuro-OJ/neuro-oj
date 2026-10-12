<script setup lang="ts">
import { educationCacheKey } from '~/utils/education';
import { workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const { domain, slug, can } = useWorkspace();
const actor = useState<{ id: string } | null>('auth:user', () => null);
const education = useEducationApi(), capture = useWorkspaceActionScope();
const page = ref(1), open = ref(false), saving = ref(false);
const form = reactive({ name: '', description: '', stage_tag: '' });
const { data, status, error, refresh } = await useAsyncData(
  () => educationCacheKey(slug.value ?? '', actor.value?.id ?? null, 'classrooms', page.value),
  () => education.classrooms(slug.value!, page.value),
);
async function create() {
  if (saving.value) return;
  const scope = capture();
  saving.value = true;
  try {
    const result = await education.createClassroom(scope.slug, { ...form });
    if (scope.isCurrent()) {
      open.value = false;
      await navigateTo(workspacePath(scope.slug, `classrooms/${result.data.id}`));
    }
  } finally {
    saving.value = false;
  }
}
useSeoMeta({ title: '我的班级' });
</script>
<template>
  <div class="space-y-5">
    <AdminPageHeader title="我的班级" description="在所属班级中查看作业、学习进度和反馈。"
      icon="i-lucide-graduation-cap">
      <template #actions>
        <UButton :to="workspacePath(slug!, 'notifications')" variant="outline" icon="i-lucide-bell">教学通知</UButton>
        <UButton
          v-if="can('classroom:create') && domain?.status === 'active' && domain.configuration.features.classroom"
          icon="i-lucide-plus" @click="open = true">创建班级</UButton>
      </template>
    </AdminPageHeader>
    <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : data?.data.length ? 'data' : 'empty'"
      :error="error ? extractApiError(error).message : undefined" empty-text="你尚未加入任何班级" @retry="refresh()">
      <div class="grid gap-4 md:grid-cols-2">
        <UCard v-for="room in data?.data" :key="room.id">
          <div class="flex items-center justify-between gap-2">
            <h2 class="font-semibold">{{ room.name }}</h2>
            <UBadge v-if="room.status === 'archived'" color="neutral" variant="subtle">已归档</UBadge>
          </div>
          <p class="mt-2 text-sm text-text-secondary">{{ room.description }}</p>
          <p class="mt-2 text-xs text-text-muted">{{ room.stage_tag }}</p>
          <UButton class="mt-4" :to="workspacePath(slug!, `classrooms/${room.id}`)" variant="outline">进入班级</UButton>
        </UCard>
      </div>
    </AsyncContent>
    <div
      class="flex items-center gap-3"><UButton :disabled="page <= 1" variant="ghost" @click="page--">上一页</UButton><span class="text-sm tabular-nums">{{ page }}</span><UButton :disabled="(data?.data.length ?? 0) < 50" variant="ghost" @click="page++">下一页</UButton></div>
    <UModal v-model:open="open" title="创建班级">
      <template #body>
        <form class="space-y-4" @submit.prevent="create">
          <AdminFormField label="班级名称" required>
            <UInput v-model="form.name" class="w-full" :maxlength="120" required aria-label="班级名称" />
          </AdminFormField>
          <AdminFormField label="阶段标签">
            <UInput v-model="form.stage_tag" class="w-full" :maxlength="80" aria-label="阶段标签" />
          </AdminFormField>
          <AdminFormField label="班级简介">
            <UTextarea v-model="form.description" class="w-full" :maxlength="10000" aria-label="班级简介" />
          </AdminFormField>
          <UButton type="submit" :loading="saving" :disabled="!form.name.trim()">创建并进入</UButton>
        </form>
      </template>
    </UModal>
  </div>
</template>
