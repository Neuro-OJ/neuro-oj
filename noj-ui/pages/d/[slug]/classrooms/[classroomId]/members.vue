<script setup lang="ts">
import { classroomCan, educationCacheKey } from '~/utils/education';
import type { ClassroomMember } from '~/utils/education';
import { workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
import InvitationManager from '~/components/workspace/InvitationManager.vue';
import ClassroomImport from '~/components/education/ClassroomImport.vue';
import ClassroomJoinRequests from '~/components/education/ClassroomJoinRequests.vue';

definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'], breadcrumbWidth: '72rem' });
const route = useRoute(), { slug, domain } = useWorkspace();
const education = useEducationApi(), { dialog } = useDialog(), { copyText } = useCopyText();
const actor = useState<{ id: string } | null>('auth:user', () => null);
const id = computed(() => String(route.params.classroomId));
const base = computed(() => educationCacheKey(slug.value!, actor.value?.id ?? null, id.value, 'members'));
const room = await useAsyncData(() => `${base.value}:classroom`, () => education.classroom(slug.value!, id.value));
const roster = await useAsyncData(() => `${base.value}:list`, () => education.members(slug.value!, id.value));
const manage = computed(() => !!room.data.value && classroomCan(room.data.value.data, 'students:manage'));
const writable = computed(() => manage.value && room.data.value?.data.status === 'active' && domain.value?.status === 'active');
const activeTab = ref('roster'), pendingCount = ref(0), search = ref(''), activeFilter = ref('active');
const saving = ref(false), failure = ref(''), capture = useWorkspaceActionScope();
const tabItems = computed(() => [
  { label: '学生名册', value: 'roster', icon: 'i-lucide-users' },
  ...(manage.value ? [
    { label: pendingCount.value ? `入班申请 (${pendingCount.value})` : '入班申请', value: 'requests', icon: 'i-lucide-user-plus' },
    { label: '导入与邀请', value: 'enrollment', icon: 'i-lucide-mail-plus' },
  ] : []),
]);
const filteredRoster = computed(() => (roster.data.value?.data ?? []).filter((m) =>
  m.username.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()) &&
  (activeFilter.value === 'all' || m.effective_active === (activeFilter.value === 'active'))
));
async function refresh() { await Promise.all([room.refresh(), roster.refresh()]); }
async function remove(member: ClassroomMember) {
  const scope = capture(), classId = id.value, revision = room.data.value!.data.revision;
  if (!await dialog.confirm(`将 ${member.username} 移出班级？已有作业和反馈会保留。`)) return;
  if (!scope.isCurrent() || id.value !== classId || !writable.value || saving.value) return;
  saving.value = true; failure.value = '';
  try {
    await education.removeMember(scope.slug, classId, member.user_id, revision);
    if (scope.isCurrent() && id.value === classId) await refresh();
  } catch (e) { if (scope.isCurrent()) failure.value = extractApiError(e).message; }
  finally { saving.value = false; }
}
function copyJoinLink() {
  const path = workspacePath(slug.value!, `classrooms/${id.value}/join`);
  copyText(import.meta.client ? `${window.location.origin}${path}` : path, '入班申请链接');
}
watch([slug, id, () => actor.value?.id], () => { failure.value = ''; search.value = ''; activeTab.value = 'roster'; });
useSeoMeta({ title: '班级学生' });
</script>
<template>
  <div class="space-y-6">
    <ClassroomNavigation :slug="slug!" :classroom-id="id" :classroom="room.data.value?.data" />
    <LibraryPageHeader title="班级学生" :description="room.data.value?.data.name ? `管理「${room.data.value.data.name}」的学生归属。域教练共同负责全部班级。` : '查看学生名册与入班申请'" icon="i-lucide-users" />
    <UAlert v-if="failure" color="error" :title="failure" />
    <UTabs v-model="activeTab" :items="tabItems" :content="false" class="w-full sm:w-fit" />
    <section v-if="activeTab === 'roster'" class="space-y-4">
      <div class="flex flex-wrap items-center gap-3">
        <UInput v-model="search" icon="i-lucide-search" placeholder="搜索用户名" aria-label="搜索学生用户名" class="w-full sm:w-64" />
        <USelect v-model="activeFilter" :items="[{ label: '在班学生', value: 'active' }, { label: '历史学生', value: 'archived' }, { label: '全部状态', value: 'all' }]" aria-label="学生状态" />
      </div>
      <AsyncContent :status="room.error.value || roster.error.value ? 'error' : room.status.value === 'pending' || roster.status.value === 'pending' ? 'loading' : filteredRoster.length ? 'data' : 'empty'" :error="room.error.value || roster.error.value ? extractApiError(room.error.value || roster.error.value).message : undefined" empty-text="暂无匹配的学生" @retry="refresh()">
        <ul class="divide-y divide-border border-y border-border">
          <li v-for="member in filteredRoster" :key="member.id" class="flex flex-wrap items-center justify-between gap-3 py-4">
            <UserIdentity :user="member.user ?? { id: member.user_id, username: member.username, avatar_url: member.avatar_url }" :domain="slug!" size="sm" />
            <div class="flex items-center gap-2">
              <UBadge :color="member.effective_active ? 'success' : 'neutral'" variant="subtle" size="xs">{{ member.effective_active ? '在班' : '历史学生' }}</UBadge>
              <UButton v-if="manage" :to="workspacePath(slug!, `classrooms/${id}/students/${member.user_id}`)" variant="outline" color="neutral" size="sm">训练详情</UButton>
              <UButton v-if="writable && member.effective_active" variant="ghost" color="error" size="sm" :disabled="saving" @click="remove(member)">移出班级</UButton>
            </div>
          </li>
        </ul>
      </AsyncContent>
    </section>
    <ClassroomJoinRequests v-else-if="activeTab === 'requests' && manage && room.data.value" :key="`${base}:requests`" :slug="slug!" :classroom-id="id" :revision="room.data.value.data.revision" :writable="!!writable" @pending-count="(count) => pendingCount = count" @changed="refresh()" />
    <section v-else-if="activeTab === 'enrollment' && manage" class="space-y-6">
      <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <p class="text-sm text-text-secondary">已有域成员可申请入班；新成员请先联系域负责人加入。</p>
        <UButton variant="outline" icon="i-lucide-copy" @click="copyJoinLink">复制入班申请链接</UButton>
      </div>
      <ClassroomImport :key="base" :slug="slug!" :classroom-id="id" :writable="!!writable" @changed="refresh()" />
      <InvitationManager :domain-slug="slug!" :classroom-id="id" :writable="!!writable" />
    </section>
  </div>
</template>
