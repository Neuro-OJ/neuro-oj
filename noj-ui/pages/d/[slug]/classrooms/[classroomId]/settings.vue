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
  <div class="space-y-5">
    <UButton :to="workspacePath(slug!, `classrooms/${id}`)" variant="ghost"
      icon="i-lucide-arrow-left">返回班级</UButton>
    <AdminPageHeader title="班级设置" :description="room.data.value?.data.name">
      <template #actions>
        <UButton variant="outline" @click="reload">重新读取</UButton>
      </template>
    </AdminPageHeader>
    <UAlert v-if="error || room.error.value" color="error"
      :title="error || extractApiError(room.error.value).message" />
    <template v-if="writable">
      <UCard>
        <form class="space-y-4" @submit.prevent="save">
          <AdminFormField label="班级名称" required>
            <UInput v-model="form.name" class="w-full" required :maxlength="120" aria-label="班级名称" />
          </AdminFormField>
          <AdminFormField label="阶段标签">
            <UInput v-model="form.stage_tag" class="w-full" :maxlength="80" aria-label="阶段标签" />
          </AdminFormField>
          <AdminFormField label="班级简介">
            <UTextarea v-model="form.description" class="w-full" :maxlength="10000" aria-label="班级简介" />
          </AdminFormField>
          <UButton type="submit" :loading="saving">保存设置</UButton>
        </form>
      </UCard>
      <UCard>
        <h2 class="mb-3 font-semibold">主教练交接</h2>
        <p class="mb-3 text-sm text-text-muted">先在班级成员中任命接任教练，再完成交接。</p>
        <UAlert v-if="roster.error.value" color="error" :title="extractApiError(roster.error.value).message" />
        <div class="flex gap-2">
          <USelect v-model="successor" :items="successors" class="grow" aria-label="接任主教练" />
          <UButton :disabled="!successor || saving" variant="outline" @click="lifecycle('transfer')">交接</UButton>
        </div>
      </UCard>
      <UCard>
        <h2 class="mb-3 font-semibold">归档班级</h2>
        <UButton color="warning" variant="outline" :disabled="saving"
          @click="lifecycle('archive')">归档并保留历史</UButton>
      </UCard>
    </template>
    <UAlert v-else-if="room.data.value" color="warning" title="当前只能读取班级设置" />
  </div>
</template>
