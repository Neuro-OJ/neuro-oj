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
  <div class="space-y-6">
    <AdminPageHeader
      title="我的班级"
      description="在所属班级中查看作业、学习进度和教学反馈。"
      icon="i-lucide-graduation-cap"
    >
      <template #actions>
        <div class="flex flex-wrap items-center gap-2">
          <UButton
            :to="workspacePath(slug!, 'teaching')"
            variant="outline"
            color="neutral"
            icon="i-lucide-presentation"
          >
            教学工作台
          </UButton>
          <UButton
            :to="workspacePath(slug!, 'my-learning')"
            variant="outline"
            color="neutral"
            icon="i-lucide-book-open"
          >
            我的学习
          </UButton>
          <UButton
            :to="workspacePath(slug!, 'notifications')"
            variant="outline"
            color="neutral"
            icon="i-lucide-bell"
          >
            教学通知
          </UButton>
          <UButton
            v-if="can('classroom:create') && domain?.status === 'active' && domain.configuration.features.classroom"
            color="primary"
            icon="i-lucide-plus"
            @click="open = true"
          >
            创建班级
          </UButton>
        </div>
      </template>
    </AdminPageHeader>

    <AsyncContent
      :status="error ? 'error' : status === 'pending' ? 'loading' : data?.data.length ? 'data' : 'empty'"
      :error="error ? extractApiError(error).message : undefined"
      empty-text="你尚未加入任何班级"
      @retry="refresh()"
    >
      <div class="grid gap-4 md:grid-cols-2">
        <div
          v-for="room in data?.data"
          :key="room.id"
          class="group flex flex-col justify-between rounded-lg border border-border bg-white p-5 shadow-card transition-all hover:border-primary/50 hover:shadow-dropdown dark:bg-bg-panel"
        >
          <div>
            <div class="flex items-start justify-between gap-3">
              <div class="flex items-center gap-3">
                <div class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary-bg text-primary">
                  <UIcon name="i-lucide-school" class="size-5" />
                </div>
                <div>
                  <h2 class="font-semibold text-text group-hover:text-primary transition-colors line-clamp-1">
                    {{ room.name }}
                  </h2>
                  <p v-if="room.stage_tag" class="mt-0.5 text-xs text-text-muted">
                    {{ room.stage_tag }}
                  </p>
                </div>
              </div>
              <UBadge v-if="room.status === 'archived'" color="neutral" variant="subtle" size="sm">
                已归档
              </UBadge>
              <UBadge v-else color="success" variant="subtle" size="sm">
                正常教学
              </UBadge>
            </div>

            <p class="mt-3.5 text-sm text-text-secondary line-clamp-2 min-h-[2.5rem]">
              {{ room.description || '暂无班级简介' }}
            </p>
          </div>

          <div class="mt-5 pt-3.5 border-t border-border flex items-center justify-between">
            <span class="text-xs text-text-muted">
              {{ room.status === 'archived' ? '历史班级' : '活跃班级' }}
            </span>
            <UButton
              :to="workspacePath(slug!, `classrooms/${room.id}`)"
              variant="outline"
              color="primary"
              size="sm"
              trailing-icon="i-lucide-arrow-right"
            >
              进入班级
            </UButton>
          </div>
        </div>
      </div>

      <template #empty>
        <div class="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-white dark:bg-bg-panel py-12 px-4 text-center shadow-card">
          <div class="flex size-12 items-center justify-center rounded-full bg-primary-bg text-primary mb-3">
            <UIcon name="i-lucide-graduation-cap" class="size-6" />
          </div>
          <h3 class="font-semibold text-text">你尚未加入任何班级</h3>
          <p class="mt-1 text-sm text-text-muted max-w-sm">
            可以通过班级邀请链接加入，或由教练统一导入名单。拥有权限时亦可直接创建新班级。
          </p>
          <UButton
            v-if="can('classroom:create') && domain?.status === 'active' && domain.configuration.features.classroom"
            class="mt-4"
            color="primary"
            icon="i-lucide-plus"
            @click="open = true"
          >
            创建第一个班级
          </UButton>
        </div>
      </template>
    </AsyncContent>

    <!-- 分页 -->
    <div
      v-if="data?.data.length || page > 1"
      class="flex items-center justify-between rounded-lg border border-border bg-white dark:bg-bg-panel px-4 py-3 shadow-card text-sm"
    >
      <span class="text-text-muted">第 <strong class="text-text tabular-nums">{{ page }}</strong> 页</span>
      <div class="flex items-center gap-2">
        <UButton :disabled="page <= 1" variant="outline" color="neutral" size="sm" @click="page--">
          上一页
        </UButton>
        <UButton :disabled="(data?.data.length ?? 0) < 50" variant="outline" color="neutral" size="sm" @click="page++">
          下一页
        </UButton>
      </div>
    </div>

    <!-- 创建班级弹窗 -->
    <UModal v-model:open="open" title="创建新班级">
      <template #body>
        <form class="space-y-4" @submit.prevent="create">
          <AdminFormField label="班级名称" required>
            <UInput v-model="form.name" class="w-full" :maxlength="120" required aria-label="班级名称" placeholder="如：2026春季 NOIP 强化班" />
          </AdminFormField>
          <AdminFormField label="阶段标签" hint="如：入门组 / 提高组 / 省选强化">
            <UInput v-model="form.stage_tag" class="w-full" :maxlength="80" aria-label="阶段标签" placeholder="用于班级分类与快速检索" />
          </AdminFormField>
          <AdminFormField label="班级简介">
            <UTextarea v-model="form.description" class="w-full" :maxlength="10000" aria-label="班级简介" placeholder="说明班级教学目标、课时安排或训练计划" />
          </AdminFormField>
          <div class="flex justify-end gap-2 pt-2">
            <UButton variant="ghost" color="neutral" @click="open = false">取消</UButton>
            <UButton type="submit" color="primary" :loading="saving" :disabled="!form.name.trim()">创建并进入班级</UButton>
          </div>
        </form>
      </template>
    </UModal>
  </div>
</template>
