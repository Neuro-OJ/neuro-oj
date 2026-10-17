<script setup lang="ts">
import { classroomCan, educationCacheKey, TEACHING_CAPABILITY_LABELS } from '~/utils/education';
import type { ClassroomMember, TeachingCapability } from '~/utils/education';
import { workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
import InvitationManager from '~/components/workspace/InvitationManager.vue';

definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'], breadcrumbWidth: '72rem' });

const route = useRoute(), { slug, domain } = useWorkspace(), education = useEducationApi(), { dialog } = useDialog();
const actor = useState<{ id: string } | null>('auth:user', () => null),
  id = computed(() => String(route.params.classroomId));

const base = computed(() => educationCacheKey(slug.value!, actor.value?.id ?? null, id.value, 'members'));
const room = await useAsyncData(() => `${base.value}:classroom`, () => education.classroom(slug.value!, id.value));
const roster = await useAsyncData(() => `${base.value}:list`, () => education.members(slug.value!, id.value));

const manage = computed(() => !!room.data.value && classroomCan(room.data.value.data, 'students:manage'));
const coach = computed(() =>
  room.data.value?.data.manages_domain || room.data.value?.data.membership?.role === 'coach'
);
const writable = computed(() =>
  manage.value && room.data.value?.data.status === 'active' && domain.value?.status === 'active' &&
  domain.value.configuration.features.classroom
);

const error = ref(''), saving = ref(false), open = ref(false);
const selected = ref<ClassroomMember | null>(null), role = ref<ClassroomMember['role']>('student');
const grants = ref<TeachingCapability[]>([]), originalRevision = ref(0), capture = useWorkspaceActionScope();

async function refresh() {
  await Promise.all([room.refresh(), roster.refresh()]);
}

function edit(member: ClassroomMember) {
  selected.value = member;
  role.value = member.role;
  grants.value = [...(member.capabilities ?? [])];
  originalRevision.value = room.data.value!.data.revision;
  error.value = '';
  open.value = true;
}

async function save() {
  if (saving.value || !selected.value || !writable.value) return;
  const scope = capture(), classId = id.value, userId = selected.value.user_id;
  saving.value = true;
  error.value = '';
  try {
    await education.setMember(
      scope.slug,
      classId,
      userId,
      role.value,
      role.value === 'assistant' ? grants.value : [],
      originalRevision.value,
    );
    if (scope.isCurrent() && id.value === classId) {
      open.value = false;
      await refresh();
    }
  } catch (e) {
    error.value = extractApiError(e).message;
  } finally {
    saving.value = false;
  }
}

async function remove(member: ClassroomMember) {
  const scope = capture(), classId = id.value, revision = room.data.value!.data.revision;
  if (!await dialog.confirm(`移除 ${member.username} 的当前班级身份？已有作业和反馈会保留。`)) return;
  if (!scope.isCurrent() || id.value !== classId || !writable.value) return;
  saving.value = true;
  error.value = '';
  try {
    await education.removeMember(scope.slug, classId, member.user_id, revision);
    if (scope.isCurrent() && id.value === classId) await refresh();
  } catch (e) {
    error.value = extractApiError(e).message;
  } finally {
    saving.value = false;
  }
}

watch([() => slug.value, () => id.value, () => actor.value?.id], () => {
  error.value = '';
  open.value = false;
});

useSeoMeta({ title: '班级成员' });
</script>

<template>
  <div class="space-y-6">
    <ClassroomNavigation :slug="slug!" :classroom-id="id" :classroom="room.data.value?.data" />

    <LibraryPageHeader
      title="班级成员"
      :description="room.data.value?.data.name ? `管理「${room.data.value.data.name}」的教练、助教与学生名单` : '管理班级成员与权限分配'"
      icon="i-lucide-user-check"
    />

    <!-- 申请链接横幅 -->
    <div
      v-if="manage"
      class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg border border-primary/20 bg-primary-bg px-4 py-3 text-sm"
    >
      <div class="flex items-center gap-2 text-text">
        <UIcon name="i-lucide-link" class="size-4 text-primary shrink-0" />
        <span>本域成员可通过班级申请链接提交入班审核。</span>
      </div>
      <UButton
        :to="workspacePath(slug!, `classrooms/${id}/join`)"
        variant="ghost"
        color="primary"
        size="sm"
        trailing-icon="i-lucide-arrow-right"
      >
        查看申请页面
      </UButton>
    </div>

    <UAlert v-if="error" color="error" :title="error" />

    <!-- 成员名单列表 -->
    <AsyncContent
      :status="room.error.value || roster.error.value ? 'error' : room.status.value === 'pending' || roster.status.value === 'pending' ? 'loading' : roster.data.value?.data.length ? 'data' : 'empty'"
      :error="room.error.value || roster.error.value ? extractApiError(room.error.value || roster.error.value).message : undefined"
      empty-text="暂无成员"
      @retry="refresh()"
    >
      <div class="divide-y divide-border rounded-lg border border-border bg-bg-panel">
        <div
          v-for="member in roster.data.value?.data"
          :key="member.id"
          class="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5"
        >
          <div class="flex min-w-0 items-start gap-3">
            <div class="flex size-10 shrink-0 items-center justify-center rounded-full bg-bg-sunken text-text-secondary font-semibold text-sm">
              {{ member.username.slice(0, 1).toUpperCase() }}
            </div>
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <span class="break-all font-medium text-text">{{ member.username }}</span>
                <UBadge
                  :color="member.role === 'coach' ? 'primary' : member.role === 'assistant' ? 'info' : 'neutral'"
                  variant="subtle"
                  size="sm"
                >
                  {{ ({ coach: '教练', assistant: '助教', student: '学生' })[member.role] }}
                </UBadge>
                <UBadge
                  :color="member.effective_active ? 'success' : 'neutral'"
                  variant="subtle"
                  size="sm"
                >
                  {{ member.effective_active ? '在班' : '历史/已移出' }}
                </UBadge>
              </div>

              <div v-if="member.role === 'assistant' && member.capabilities?.length" class="mt-2 flex flex-wrap gap-1">
                <span
                  v-for="cap in member.capabilities"
                  :key="cap"
                  class="rounded bg-bg-sunken px-1.5 py-0.5 text-xs text-text-muted"
                >
                  {{ TEACHING_CAPABILITY_LABELS[cap] }}
                </span>
              </div>
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-2 sm:justify-end sm:shrink-0">
            <UButton
              v-if="member.role === 'student' && room.data.value && (classroomCan(room.data.value.data, 'submissions:read') || classroomCan(room.data.value.data, 'progress:read'))"
              :to="workspacePath(slug!, `classrooms/${id}/students/${member.user_id}`)"
              variant="outline"
              color="neutral"
              size="sm"
              icon="i-lucide-activity"
            >
              训练详情
            </UButton>
            <UButton
              v-if="writable && (coach || member.role === 'student')"
              variant="outline"
              color="neutral"
              size="sm"
              :disabled="saving"
              @click="edit(member)"
            >
              调整身份
            </UButton>
            <UButton
              v-if="writable && member.effective_active && member.user_id !== room.data.value?.data.primary_coach_id && (coach || member.role === 'student')"
              variant="ghost"
              color="error"
              size="sm"
              :disabled="saving"
              @click="remove(member)"
            >
              移出班级
            </UButton>
          </div>
        </div>
      </div>
    </AsyncContent>

    <!-- 成员导入与邀请管理 -->
    <ClassroomImport
      v-if="manage"
      :key="base"
      :slug="slug!"
      :classroom-id="id"
      :writable="!!writable"
      @changed="refresh()"
    />

    <ClassroomJoinRequests
      v-if="manage && room.data.value"
      :key="`${base}:requests`"
      :slug="slug!"
      :classroom-id="id"
      :revision="room.data.value.data.revision"
      :writable="!!writable"
      @changed="refresh()"
    />

    <InvitationManager
      v-if="manage"
      :domain-slug="slug!"
      :classroom-id="id"
      :writable="!!writable"
    />

    <!-- 调整身份弹窗 -->
    <UModal v-model:open="open" title="调整班级身份与授权">
      <template #body>
        <form class="space-y-4" @submit.prevent="save">
          <div class="rounded-lg bg-bg-sunken p-3 text-sm">
            <span class="text-text-muted">当前调整成员：</span>
            <strong class="text-text">{{ selected?.username }}</strong>
          </div>

          <UAlert v-if="error" color="error" :title="error" />

          <AdminFormField label="班级角色">
            <USelect
              v-model="role"
              :items="coach ? [{ label: '学生', value: 'student' }, { label: '助教', value: 'assistant' }, { label: '教练', value: 'coach' }] : [{ label: '学生', value: 'student' }]"
              aria-label="班级角色"
              class="w-full"
            />
          </AdminFormField>

          <div v-if="role === 'assistant'" class="space-y-2 rounded-lg border border-border p-3.5">
            <span class="text-sm font-semibold text-text">助教授权权限</span>
            <div class="grid gap-2 sm:grid-cols-2 pt-1">
              <UCheckbox
                v-for="(label, capability) in TEACHING_CAPABILITY_LABELS"
                :key="capability"
                :label="label"
                :model-value="grants.includes(capability)"
                @update:model-value="v => grants = v ? [...grants, capability] : grants.filter(c => c !== capability)"
              />
            </div>
          </div>

          <div class="flex justify-end gap-2 pt-2">
            <UButton variant="ghost" color="neutral" @click="open = false">取消</UButton>
            <UButton type="submit" color="primary" :loading="saving">保存身份配置</UButton>
          </div>
        </form>
      </template>
    </UModal>
  </div>
</template>
