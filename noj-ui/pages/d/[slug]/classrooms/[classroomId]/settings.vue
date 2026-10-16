<script setup lang="ts">
import { educationCacheKey } from '~/utils/education';
import { workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const route = useRoute(), { slug, domain } = useWorkspace(), education = useEducationApi(), { dialog } = useDialog();
const actor = useState<{ id: string } | null>('auth:user', () => null),
  id = computed(() => String(route.params.classroomId));
const key = computed(() => educationCacheKey(slug.value!, actor.value?.id ?? null, id.value, 'settings'));
const room = await useAsyncData(() => key.value, () => education.classroom(slug.value!, id.value));
const roster = await useAsyncData(() => `${key.value}:roster`, () => education.members(slug.value!, id.value));
const form = reactive({ name: '', description: '', stage_tag: '' });
const originalRevision = ref(room.data.value?.data.revision ?? 0),
  saving = ref(false),
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
  room.data.value && (room.data.value.data.manages_domain || room.data.value.data.membership?.role === 'coach') &&
  room.data.value.data.status === 'active' && domain.value?.status === 'active' &&
  domain.value.configuration.features.classroom
);
const successors = computed(() =>
  roster.data.value?.data.filter((m) =>
    m.role === 'coach' && m.effective_active && m.user_id !== room.data.value?.data.primary_coach_id
  ).map((m) => ({ label: m.username, value: m.user_id })) ?? []
);
const capture = useWorkspaceActionScope();
async function save() {
  if (saving.value || !writable.value) return;
  const scope = capture(), classId = id.value;
  saving.value = true;
  error.value = '';
  try {
    await education.updateClassroom(scope.slug, classId, { ...form }, originalRevision.value);
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
async function lifecycle(action: 'transfer' | 'archive') {
  if (!writable.value || saving.value) return;
  const scope = capture(), classId = id.value, revision = originalRevision.value, userId = successor.value;
  if (
    !await dialog.confirm(
      action === 'transfer'
        ? '把主教练交接给所选教练？历史数据仍属于原班级。'
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
});
useSeoMeta({ title: '班级设置' });
</script>
<template>
  <div class="space-y-6">
    <!-- 顶部面包屑与返回 -->
    <div class="flex items-center gap-2 text-sm text-text-muted">
      <NuxtLink
        :to="workspacePath(slug!, `classrooms/${id}`)"
        class="inline-flex items-center gap-1 text-text-secondary hover:text-primary transition-colors font-medium"
      >
        <UIcon name="i-lucide-arrow-left" class="size-4" />
        <span>返回班级</span>
      </NuxtLink>
      <span class="text-border">/</span>
      <span class="text-text font-medium truncate max-w-xs">{{ room.data.value?.data.name ?? '班级' }}</span>
      <span class="text-border">/</span>
      <span class="text-text-muted">班级设置</span>
    </div>

    <AdminPageHeader
      title="班级设置"
      :description="room.data.value?.data.name ? `修改「${room.data.value.data.name}」基本信息、主教练交接或班级生命周期` : '管理班级基本设置与生命周期'"
      icon="i-lucide-settings"
    >
      <template #actions>
        <UButton variant="outline" color="neutral" icon="i-lucide-refresh-cw" @click="reload">
          重新读取
        </UButton>
      </template>
    </AdminPageHeader>

    <UAlert
      v-if="error || room.error.value"
      color="error"
      :title="error || extractApiError(room.error.value).message"
    />

    <template v-if="writable">
      <!-- 基本信息 -->
      <UCard>
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-edit-3" class="size-5 text-primary" />
            <h2 class="font-semibold text-text">基本信息设置</h2>
          </div>
        </template>

        <form class="space-y-4" @submit.prevent="save">
          <AdminFormField label="班级名称" required>
            <UInput v-model="form.name" class="w-full" required :maxlength="120" aria-label="班级名称" />
          </AdminFormField>
          <AdminFormField label="阶段标签" hint="例如：提高组强化班 / 省选集训队">
            <UInput v-model="form.stage_tag" class="w-full" :maxlength="80" aria-label="阶段标签" />
          </AdminFormField>
          <AdminFormField label="班级简介">
            <UTextarea v-model="form.description" class="w-full" :maxlength="10000" aria-label="班级简介" />
          </AdminFormField>
          <div class="pt-2 flex justify-end">
            <UButton type="submit" color="primary" :loading="saving">保存班级设置</UButton>
          </div>
        </form>
      </UCard>

      <!-- 主教练交接 -->
      <UCard>
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-user-check" class="size-5 text-primary" />
            <h2 class="font-semibold text-text">主教练交接</h2>
          </div>
        </template>

        <div class="space-y-3">
          <p class="text-sm text-text-secondary">
            将主教练权限交接给班级内其他已被任命为教练身份的成员。历史作业与学情数据仍保留在当前班级。
          </p>

          <UAlert v-if="roster.error.value" color="error" :title="extractApiError(roster.error.value).message" />

          <div class="flex flex-wrap items-center gap-3 pt-1">
            <USelect
              v-model="successor"
              :items="successors"
              placeholder="选择接任的主教练"
              class="w-full sm:w-72"
              aria-label="接任主教练"
            />
            <UButton
              :disabled="!successor || saving"
              variant="outline"
              color="neutral"
              @click="lifecycle('transfer')"
            >
              确认交接
            </UButton>
          </div>
        </div>
      </UCard>

      <!-- 归档班级 -->
      <UCard class="border-warning/40">
        <template #header>
          <div class="flex items-center gap-2 text-warning">
            <UIcon name="i-lucide-archive" class="size-5" />
            <h2 class="font-semibold text-text">归档班级</h2>
          </div>
        </template>

        <div class="space-y-4">
          <p class="text-sm text-text-secondary leading-relaxed">
            归档后班级将进入只读状态，停止发布新作业与新成员加入。学生和助教仍可随时查阅已布置作业的历史提交、答题表现与教练反馈。
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
    </template>

    <UAlert v-else-if="room.data.value" color="warning" title="当前只能读取班级设置，无权修改配置或交接负责人" />
  </div>
</template>
