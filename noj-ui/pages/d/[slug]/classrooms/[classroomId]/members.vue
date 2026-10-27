<script setup lang="ts">
import { classroomCan, educationCacheKey } from '~/utils/education';
import type { ClassroomMember } from '~/utils/education';
import { workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
import { useCopyText } from '~/composables/useCopyText';
import InvitationManager from '~/components/workspace/InvitationManager.vue';
import ClassroomImport from '~/components/education/ClassroomImport.vue';
import ClassroomJoinRequests from '~/components/education/ClassroomJoinRequests.vue';

definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'], breadcrumbWidth: '72rem' });

const route = useRoute();
const { slug, domain } = useWorkspace();
const education = useEducationApi();
const { dialog } = useDialog();
const { copyText } = useCopyText();

const actor = useState<{ id: string } | null>('auth:user', () => null);
const id = computed(() => String(route.params.classroomId));

const base = computed(() => educationCacheKey(slug.value!, actor.value?.id ?? null, id.value, 'members'));
const room = await useAsyncData(() => `${base.value}:classroom`, () => education.classroom(slug.value!, id.value));
const roster = await useAsyncData(() => `${base.value}:list`, () => education.members(slug.value!, id.value));

const manage = computed(() => !!room.data.value && classroomCan(room.data.value.data, 'students:manage'));
const writable = computed(() =>
  manage.value && room.data.value?.data.status === 'active' && domain.value?.status === 'active' &&
  domain.value.configuration.features.classroom
);

// Tab 切换与徽标管理
const activeTab = ref<'roster' | 'requests' | 'enrollment'>('roster');
const pendingCount = ref(0);

const tabItems = computed(() => {
  const items = [
    {
      label: `班级花名册 (${roster.data.value?.data.length ?? 0})`,
      value: 'roster',
      icon: 'i-lucide-users',
    },
  ];
  if (manage.value) {
    items.push({
      label: pendingCount.value > 0 ? `入班申请 (${pendingCount.value})` : '入班申请',
      value: 'requests',
      icon: 'i-lucide-user-plus',
    });
    items.push({
      label: '批量入班与邀请',
      value: 'enrollment',
      icon: 'i-lucide-mail-plus',
    });
  }
  return items;
});

// 花名册检索与筛选
const search = ref('');
const activeFilter = ref<'all' | 'active' | 'archived'>('active');

const filteredRoster = computed(() => {
  const list = roster.data.value?.data ?? [];
  return list.filter((m) => {
    if (search.value.trim() && !m.username.toLowerCase().includes(search.value.trim().toLowerCase())) {
      return false;
    }
    if (activeFilter.value === 'active' && !m.effective_active) {
      return false;
    }
    if (activeFilter.value === 'archived' && m.effective_active) {
      return false;
    }
    return true;
  });
});

const rosterStats = computed(() => {
  const list = roster.data.value?.data ?? [];
  const activeList = list.filter((m) => m.effective_active);
  const students = activeList.filter((m) => m.role === 'student').length;
  return { total: activeList.length, students };
});

const error = ref('');
const saving = ref(false);
const capture = useWorkspaceActionScope();

async function refresh() {
  await Promise.all([room.refresh(), roster.refresh()]);
}

async function remove(member: ClassroomMember) {
  const scope = capture();
  const classId = id.value;
  const revision = room.data.value!.data.revision;
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

function copyJoinLink() {
  const path = workspacePath(slug.value!, `classrooms/${id.value}/join`);
  const fullUrl = import.meta.client ? `${window.location.origin}${path}` : path;
  copyText(fullUrl, '入班申请链接');
}

watch([() => slug.value, () => id.value, () => actor.value?.id], () => {
  error.value = '';
});

useSeoMeta({ title: '班级成员' });
</script>

<template>
  <div class="flex flex-col gap-6">
    <ClassroomNavigation :slug="slug!" :classroom-id="id" :classroom="room.data.value?.data" />

    <LibraryPageHeader
      title="班级成员"
      :description="room.data.value?.data.name ? `管理「${room.data.value.data.name}」的学生名单` : '管理班级学生名单'"
      icon="i-lucide-user-check"
    />

    <UAlert v-if="error" color="error" :title="error" />

    <!-- 成员管理三段式 Tab 导航 -->
    <UTabs v-model="activeTab" :items="tabItems" :content="false" class="w-full sm:w-fit" />

    <!-- Tab 1: 班级花名册 -->
    <div v-show="activeTab === 'roster'" class="space-y-4">
      <!-- 搜索、筛选与统计栏 -->
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg border border-border bg-bg-panel p-4">
        <div class="flex flex-wrap items-center gap-2">
          <UInput
            v-model="search"
            icon="i-lucide-search"
            placeholder="搜索用户名..."
            aria-label="搜索成员用户名"
            class="w-full sm:w-56"
          />
          <USelect
            v-model="activeFilter"
            :items="[
              { label: '在班成员', value: 'active' },
              { label: '历史/已移出', value: 'archived' },
              { label: '全部状态', value: 'all' },
            ]"
            aria-label="按有效状态过滤"
            class="w-32"
          />
        </div>

        <div class="text-xs text-text-muted tabular-nums sm:text-right">
          共 <strong class="text-text font-semibold">{{ rosterStats.total }}</strong> 名在班成员
        </div>
      </div>

      <!-- 成员列表内容区 -->
      <AsyncContent
        :status="room.error.value || roster.error.value ? 'error' : room.status.value === 'pending' || roster.status.value === 'pending' ? 'loading' : filteredRoster.length ? 'data' : 'empty'"
        :error="room.error.value || roster.error.value ? extractApiError(room.error.value || roster.error.value).message : undefined"
        :empty-text="search ? '未找到匹配的成员' : '暂无成员'"
        @retry="refresh()"
      >
        <div class="divide-y divide-border rounded-lg border border-border bg-bg-panel">
          <div
            v-for="member in filteredRoster"
            :key="member.id"
            class="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5 transition-colors hover:bg-bg-sunken/40"
          >
            <div class="flex min-w-0 items-start gap-3">
              <div class="flex size-10 shrink-0 items-center justify-center rounded-full bg-bg-sunken text-text-secondary font-semibold text-sm">
                {{ member.username.slice(0, 1).toUpperCase() }}
              </div>
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="break-all font-medium text-text">{{ member.username }}</span>
                  <UBadge color="neutral" variant="subtle" size="sm">学生</UBadge>
                  <UBadge
                    :color="member.effective_active ? 'success' : 'neutral'"
                    variant="subtle"
                    size="sm"
                  >
                    {{ member.effective_active ? '在班' : '历史/已移出' }}
                  </UBadge>
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
                v-if="writable && member.effective_active"
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
    </div>

    <!-- Tab 2: 入班申请审核 -->
    <div v-show="activeTab === 'requests'">
      <ClassroomJoinRequests
        v-if="manage && room.data.value"
        :key="`${base}:requests`"
        :slug="slug!"
        :classroom-id="id"
        :revision="room.data.value.data.revision"
        :writable="!!writable"
        @pending-count="(count) => pendingCount = count"
        @changed="refresh()"
      />
    </div>

    <!-- Tab 3: 批量入班与邀请 -->
    <div v-show="activeTab === 'enrollment'" class="space-y-6">
      <!-- 班级公开申请链接面板 -->
      <div
        v-if="manage"
        class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-lg border border-primary/20 bg-primary-bg px-5 py-4"
      >
        <div class="space-y-1">
          <div class="flex items-center gap-2 font-medium text-text">
            <UIcon name="i-lucide-link-2" class="size-4 text-primary shrink-0" />
            <span>班级公开申请链接</span>
          </div>
          <p class="text-xs text-text-secondary">
            本域成员访问此链接可提交入班审核；教练在「入班申请」标签页中审批。
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2 shrink-0">
          <UButton
            variant="outline"
            color="primary"
            size="sm"
            icon="i-lucide-copy"
            @click="copyJoinLink"
          >
            复制申请链接
          </UButton>
          <UButton
            :to="workspacePath(slug!, `classrooms/${id}/join`)"
            target="_blank"
            variant="ghost"
            color="primary"
            size="sm"
            trailing-icon="i-lucide-external-link"
          >
            打开申请页
          </UButton>
        </div>
      </div>

      <!-- 批量名单导入 -->
      <ClassroomImport
        v-if="manage"
        :key="base"
        :slug="slug!"
        :classroom-id="id"
        :writable="!!writable"
        @changed="refresh()"
      />

      <!-- 班级邀请码管理 -->
      <InvitationManager
        v-if="manage"
        :domain-slug="slug!"
        :classroom-id="id"
        :existing-members-only="!domain?.platform_admin && !domain?.permissions?.includes('domain:invitations')"
        :writable="!!writable"
      />
    </div>

  </div>
</template>
