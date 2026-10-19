<script setup lang="ts">
import { educationCacheKey } from '~/utils/education';
import { workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'], breadcrumbWidth: '72rem' });
const route = useRoute(), { slug, domain } = useWorkspace(), education = useEducationApi(), { dialog } = useDialog();
const actor = useState<{ id: string } | null>('auth:user', () => null),
  id = computed(() => String(route.params.classroomId));
const key = computed(() => educationCacheKey(slug.value!, actor.value?.id ?? null, id.value, 'settings'));
const room = await useAsyncData(() => key.value, () => education.classroom(slug.value!, id.value));
const roster = await useAsyncData(() => `${key.value}:roster`, () => education.members(slug.value!, id.value));
const form = reactive({ name: '', description: '', stage_tag: '' });
const originalRevision = ref(room.data.value?.data.revision ?? 0),
  saving = ref(false),
  saved = ref(false),
  error = ref(''),
  successor = ref('');
function reset() {
  const value = room.data.value?.data;
  if (value) {
    form.name = value.name;
    form.description = value.description;
    form.stage_tag = value.stage_tag;
    originalRevision.value = value.revision;
  }
}
reset();
const loadedIdentity = ref(key.value);
watch([key, room.data], () => {
  if (
    loadedIdentity.value !== key.value && room.data.value?.data.id === id.value &&
    room.data.value.data.domain_id === domain.value?.id
  ) {
    reset();
    loadedIdentity.value = key.value;
  }
});
const writable = computed(() =>
  room.data.value && (room.data.value.data.manages_domain) &&
  room.data.value.data.status === 'active' && domain.value?.status === 'active' &&
  domain.value.configuration.features.classroom
);
const successors = computed(() =>
  roster.data.value?.data.filter((m) =>
    m.effective_active && m.user_id !== room.data.value?.data.primary_coach_id
  ).map((m) => ({ label: m.username, value: m.user_id })) ?? []
);
const capture = useWorkspaceActionScope();
async function save() {
  if (saving.value || !writable.value) return;
  const scope = capture(), classId = id.value;
  saving.value = true;
  error.value = '';
  saved.value = false;
  try {
    await education.updateClassroom(scope.slug, classId, { ...form }, originalRevision.value);
    if (scope.isCurrent() && id.value === classId) {
      await room.refresh();
      reset();
      saved.value = true;
    }
  } catch (e) {
    error.value = extractApiError(e).message;
  } finally {
    saving.value = false;
  }
}
async function lifecycle(action: 'transfer' | 'archive') {
  if (!writable.value || saving.value) return;
  const scope = capture(), classId = id.value, revision = originalRevision.value, userId = successor.value;
  if (
    !await dialog.confirm(
      action === 'transfer'
        ? '更换班级联系人？此操作不改变任何人的域教练权限，历史数据仍属于原班级。'
        : '归档后停止新作业和成员写操作，保留获授权的历史。是否归档？',
    )
  ) return;
  if (!scope.isCurrent() || id.value !== classId || !writable.value) return;
  saving.value = true;
  error.value = '';
  try {
    if (action === 'transfer') await education.transferClassroom(scope.slug, classId, userId, revision);
    else await education.archiveClassroom(scope.slug, classId, revision);
    if (scope.isCurrent() && id.value === classId) {
      await room.refresh();
      reset();
    }
  } catch (e) {
    error.value = extractApiError(e).message;
  } finally {
    saving.value = false;
  }
}
async function reload() {
  const scope = capture(), classId = id.value;
  if (!await dialog.confirm('重新读取会丢弃未保存的班级设置，是否继续？')) return;
  if (scope.isCurrent() && id.value === classId) {
    await room.refresh();
    if (scope.isCurrent() && id.value === classId) reset();
  }
}
watch([() => slug.value, () => id.value, () => actor.value?.id], () => {
  form.name = '';
  form.description = '';
  form.stage_tag = '';
  successor.value = '';
  error.value = '';
  saved.value = false;
});
useSeoMeta({ title: '班级设置' });
</script>
<template>
  <div class="flex flex-col gap-6">
    <ClassroomNavigation :slug="slug!" :classroom-id="id" :classroom="room.data.value?.data" />

    <LibraryPageHeader
      title="班级设置"
      :description="room.data.value?.data.name ? `修改「${room.data.value.data.name}」的基本信息、联系人或归档班级` : '管理班级信息与教学安排'"
      icon="i-lucide-settings"
    >
      <template #actions>
        <UButton variant="outline" color="neutral" icon="i-lucide-refresh-cw" :disabled="saving" :loading="room.status.value === 'pending'" @click="reload">
          重新读取
        </UButton>
      </template>
    </LibraryPageHeader>

    <UAlert
      v-if="error"
      color="error"
      :title="error"
    />

    <AsyncContent
      :status="room.error.value ? 'error' : room.status.value === 'pending' ? 'loading' : room.data.value ? 'data' : 'empty'"
      :error="room.error.value ? extractApiError(room.error.value).message : undefined" @retry="room.refresh()">
    <div v-if="writable" class="space-y-6">
      <!-- 基本信息 -->
      <UCard>
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-edit-3" class="size-5 text-primary" />
            <h2 class="font-semibold text-text">基本信息设置</h2>
          </div>
        </template>

        <form class="max-w-2xl space-y-5" @submit.prevent="save" @input="saved = false">
          <div class="grid gap-5 sm:grid-cols-2">
          <AdminFormField label="班级名称" required>
            <UInput v-model="form.name" class="w-full" required :maxlength="120" aria-label="班级名称" />
          </AdminFormField>
          <AdminFormField label="阶段标签" hint="例如：提高组强化班 / 省选集训队">
            <UInput v-model="form.stage_tag" class="w-full" :maxlength="80" aria-label="阶段标签" />
          </AdminFormField>
          </div>
          <AdminFormField label="班级简介">
            <UTextarea v-model="form.description" class="w-full" :rows="4" :maxlength="10000" aria-label="班级简介" />
          </AdminFormField>
          <div class="flex flex-wrap items-center justify-end gap-3 border-t border-border pt-4">
            <span v-if="saved" role="status" class="text-sm text-success-text">班级设置已保存</span>
            <UButton type="submit" color="primary" :loading="saving" :disabled="!form.name.trim()">保存班级设置</UButton>
          </div>
        </form>
      </UCard>

      <!-- 联系人只承担联络信息，不参与授权 -->
      <UCard>
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-user-check" class="size-5 text-primary" />
            <h2 class="font-semibold text-text">班级联系人</h2>
          </div>
        </template>

        <div class="space-y-3">
          <p class="text-sm text-text-secondary">
            联系人负责班级日常联络，不产生额外权限。教学权限统一来自域负责人和域教练，历史作业与学情保留在当前班级。
          </p>

          <UAlert v-if="roster.error.value" color="error" :title="extractApiError(roster.error.value).message" />

          <div class="flex flex-wrap items-end gap-3 pt-1">
            <AdminFormField label="新联系人" class="w-full sm:w-72">
            <USelect
              v-model="successor"
              :items="successors"
              placeholder="选择班级联系人"
              class="w-full"
              :loading="roster.status.value === 'pending'"
              :disabled="saving || roster.status.value === 'pending' || !!roster.error.value || !successors.length"
              aria-label="新联系人"
            />
            </AdminFormField>
            <UButton
              :disabled="!successor || saving"
              variant="outline"
              color="neutral"
              @click="lifecycle('transfer')"
            >
              确认交接
            </UButton>
          </div>
          <p v-if="roster.status.value === 'success' && !roster.error.value && !successors.length" class="text-sm text-text-muted">
            暂无可选择的联系人。请先在<NuxtLink :to="workspacePath(slug!, `classrooms/${id}/members`)" class="text-primary hover:underline">班级学生</NuxtLink>中添加已有域成员；联系人不产生教学权限。
          </p>
        </div>
      </UCard>

      <!-- 归档班级 -->
      <UCard class="border-warning/40">
        <template #header>
          <div class="flex items-center gap-2 text-warning-text">
            <UIcon name="i-lucide-archive" class="size-5" />
            <h2 class="font-semibold text-text">归档班级</h2>
          </div>
        </template>

        <div class="space-y-4">
          <p class="text-sm text-text-secondary leading-relaxed">
            归档后停止发布新作业与成员变更。获授权的成员仍可查阅历史作业、提交和反馈。
          </p>
          <UButton
            color="warning"
            variant="outline"
            :disabled="saving"
            @click="lifecycle('archive')"
          >
            归档此班级并保留历史
          </UButton>
        </div>
      </UCard>
    </div>

    <UAlert v-else-if="room.data.value" color="warning" title="当前只能读取班级设置，无权修改配置或交接负责人" />
    </AsyncContent>
  </div>
</template>
