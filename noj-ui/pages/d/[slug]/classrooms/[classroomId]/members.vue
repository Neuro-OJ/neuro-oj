<script setup lang="ts">
import { classroomCan, educationCacheKey, TEACHING_CAPABILITY_LABELS } from '~/utils/education';
import type { ClassroomMember, TeachingCapability } from '~/utils/education';
import { workspaceInvitationLink, workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
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
const invitations = await useAsyncData(
  () => `${base.value}:invites:${manage.value}`,
  () => manage.value ? education.invitations(slug.value!, id.value) : Promise.resolve(null),
);
const email = ref(''), link = ref(''), error = ref(''), saving = ref(false), open = ref(false);
const selected = ref<ClassroomMember | null>(null), role = ref<ClassroomMember['role']>('student');
const grants = ref<TeachingCapability[]>([]), originalRevision = ref(0), capture = useWorkspaceActionScope();
async function refresh() {
  await Promise.all([room.refresh(), roster.refresh(), invitations.refresh()]);
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
async function invite() {
  if (saving.value || !writable.value) return;
  const scope = capture(), classId = id.value;
  saving.value = true;
  error.value = '';
  link.value = '';
  try {
    const result = await education.invite(scope.slug, classId, email.value.trim());
    if (!scope.isCurrent() || id.value !== classId) return;
    link.value = workspaceInvitationLink(window.location.origin, result.data.token);
    email.value = '';
    await invitations.refresh();
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
async function revoke(inviteId: string) {
  const scope = capture(), classId = id.value;
  saving.value = true;
  error.value = '';
  try {
    await education.revokeInvitation(scope.slug, classId, inviteId);
    if (scope.isCurrent() && id.value === classId) await invitations.refresh();
  } catch (e) {
    error.value = extractApiError(e).message;
  } finally {
    saving.value = false;
  }
}
watch(() => [slug.value, id.value, actor.value?.id], () => {
  link.value = '';
  email.value = '';
  error.value = '';
  open.value = false;
});
useSeoMeta({ title: '班级成员' });
</script>
<template>
  <div class="space-y-5">
    <UButton :to="workspacePath(slug!, `classrooms/${id}`)" variant="ghost"
      icon="i-lucide-arrow-left">返回班级</UButton>
    <AdminPageHeader title="班级成员" :description="room.data.value?.data.name" />
    <p v-if="manage"
      class="text-sm text-text-muted">本域成员可以通过 <NuxtLink class="text-primary" :to="workspacePath(slug!, `classrooms/${id}/join`)">班级申请链接</NuxtLink> 提交申请。</p>
    <UAlert v-if="error" color="error" :title="error" />
    <AsyncContent
      :status="roster.error.value ? 'error' : roster.status.value === 'pending' ? 'loading' : roster.data.value ? 'data' : 'empty'"
      :error="roster.error.value ? extractApiError(roster.error.value).message : undefined" @retry="refresh()">
      <div class="space-y-3">
        <UCard v-for="member in roster.data.value?.data" :key="member.id">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p class="font-medium">{{ member.username }}</p>
              <p
                class="mt-1 text-sm text-text-muted">{{ ({ coach: '教练', assistant: '助教', student: '学生' })[member.role] }} · {{ member.effective_active ? '当前成员' : '历史／停用成员' }}</p>
              <p v-if="member.capabilities?.length"
                class="mt-1 text-xs text-text-secondary">{{ member.capabilities.map((c) => TEACHING_CAPABILITY_LABELS[c]).join('、') }}</p>
            </div>
            <div v-if="writable && (coach || member.role === 'student')" class="flex gap-2">
              <UButton variant="outline" :disabled="saving" @click="edit(member)">调整身份</UButton>
              <UButton v-if="member.effective_active && member.user_id !== room.data.value?.data.primary_coach_id"
                variant="ghost" color="error" :disabled="saving" @click="remove(member)">移出班级</UButton>
            </div>
            <UButton
              v-if="member.role === 'student' && room.data.value && (classroomCan(room.data.value.data, 'submissions:read') || classroomCan(room.data.value.data, 'progress:read'))"
              :to="workspacePath(slug!, `classrooms/${id}/students/${member.user_id}`)"
              variant="outline">训练详情</UButton>
          </div>
        </UCard>
      </div>
    </AsyncContent>
    <ClassroomImport v-if="manage" :key="base" :slug="slug!" :classroom-id="id" :writable="!!writable"
      @changed="refresh()" />
    <ClassroomJoinRequests v-if="manage && room.data.value" :key="`${base}:requests`" :slug="slug!" :classroom-id="id"
      :revision="room.data.value.data.revision" :writable="!!writable" @changed="refresh()" />
    <UCard v-if="writable">
      <h2 class="mb-3 font-semibold">邀请学生</h2>
      <p
        class="mb-3 text-sm text-text-muted">学生接受邀请后加入本域和本班。有账号的学生先登录，新账号按实例注册政策处理。</p>
      <form class="flex flex-wrap gap-2" @submit.prevent="invite">
        <UInput v-model="email" type="email" class="grow" required placeholder="学生邮箱" aria-label="学生邀请邮箱" />
        <UButton type="submit" :loading="saving">生成邀请链接</UButton>
      </form>
      <UInput v-if="link" class="mt-3 w-full" :model-value="link" readonly aria-label="学生邀请链接" />
    </UCard>
    <UCard v-if="manage">
      <h2 class="mb-3 font-semibold">已有邀请</h2>
      <UAlert v-if="invitations.error.value" color="error" :title="extractApiError(invitations.error.value).message" />
      <div v-for="invitation in invitations.data.value?.data" :key="invitation.id"
        class="flex flex-wrap items-center justify-between gap-2 border-b border-border py-3">
        <div>
          <p class="text-sm">{{ invitation.email }}</p>
          <p
            class="text-xs text-text-muted">{{ invitation.used_at ? '已使用' : invitation.revoked_at ? '已撤销' : new Date(invitation.expires_at).getTime() <= Date.now() ? '已过期' : '待接受' }}</p>
        </div>
        <UButton v-if="writable && !invitation.used_at && !invitation.revoked_at" variant="ghost" color="error"
          :disabled="saving" @click="revoke(invitation.id)">撤销</UButton>
      </div>
    </UCard>
    <UModal v-model:open="open" title="调整班级身份">
      <template #body>
        <form class="space-y-4" @submit.prevent="save">
          <p class="font-medium">{{ selected?.username }}</p>
          <UAlert v-if="error" color="error" :title="error" />
          <USelect v-model="role"
            :items="coach ? [{ label: '学生', value: 'student' }, { label: '助教', value: 'assistant' }, { label: '教练', value: 'coach' }] : [{ label: '学生', value: 'student' }]"
            aria-label="班级角色" />
          <div v-if="role === 'assistant'" class="grid gap-2">
            <UCheckbox v-for="(label, capability) in TEACHING_CAPABILITY_LABELS" :key="capability" :label="label"
              :model-value="grants.includes(capability)"
              @update:model-value="v => grants = v ? [...grants, capability] : grants.filter(c => c !== capability)" />
          </div>
          <UButton type="submit" :loading="saving">保存身份与授权</UButton>
        </form>
      </template>
    </UModal>
  </div>
</template>
