<script setup lang="ts">
import { classroomCan, educationCacheKey } from '~/utils/education';
import type { ClassroomMember } from '~/utils/education';
import { workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
import { useCopyText } from '~/composables/useCopyText';
import InvitationManager from '~/components/workspace/InvitationManager.vue';
import ClassroomImport from '~/components/education/ClassroomImport.vue';
import ClassroomJoinRequests from '~/components/education/ClassroomJoinRequests.vue';

definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });

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
      label: `班级花名册 (${rosterStats.value.total})`,
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

const canViewTraining = computed(() =>
  !!room.data.value &&
  (classroomCan(room.data.value.data, 'submissions:read') || classroomCan(room.data.value.data, 'progress:read'))
);

function studentTrainingPath(member: ClassroomMember) {
  return workspacePath(slug.value!, `classrooms/${id.value}/students/${member.user_id}`);
}

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

// 面包屑动态层用班级名回填，避免把 classroomId 的原始 UUID 暴露给用户。
useBreadcrumbParams({ classroomId: () => room.data.value?.data.name });
useSeoMeta({ title: '班级成员' });
</script>

<template>
  <div class="flex flex-col gap-6">
    <ClassroomNavigation :slug="slug!" :classroom-id="id" :classroom="room.data.value?.data" />

    <LibraryPageHeader
      title="班级成员"
      :description="room.data.value?.data.name ? `查看「${room.data.value.data.name}」学员训练进展并管理班级名单` : '管理班级成员与学员训练'"
      icon="i-lucide-user-check"
    />

    <UAlert v-if="error" color="error" variant="subtle" :title="error" />

    <!-- 成员管理三段式 Tab 导航 -->
    <UTabs v-model="activeTab" :items="tabItems" :content="false" class="w-full sm:w-fit" />

    <!-- Tab 1: 班级花名册 -->
    <div v-show="activeTab === 'roster'" class="space-y-4">
      <!-- 搜索、筛选与统计栏 -->
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-md border border-border bg-bg-panel p-3 sm:p-4">
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
        <div class="divide-y divide-border rounded-md border border-border bg-bg-panel">
          <div
            v-for="member in filteredRoster"
            :key="member.id"
            class="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5 transition-colors hover:bg-bg-sunken/40"
          >
            <NuxtLink
              v-if="member.role === 'student' && canViewTraining"
              :to="studentTrainingPath(member)"
              class="group flex min-w-0 flex-1 items-center justify-between gap-3 rounded focus-visible:outline-2 focus-visible:outline-primary"
            >
              <div class="flex min-w-0 items-center gap-3">
                <div class="flex size-9 shrink-0 items-center justify-center rounded-full bg-bg-sunken text-text-secondary font-semibold text-sm group-hover:bg-primary-bg group-hover:text-primary transition-colors">
                  {{ member.username.slice(0, 1).toUpperCase() }}
                </div>
                <div class="flex min-w-0 flex-wrap items-center gap-2">
                  <span class="break-all font-medium text-text group-hover:text-primary transition-colors">{{ member.username }}</span>
                  <UBadge color="neutral" variant="subtle" size="sm">{{ member.role === 'student' ? '学生' : member.role }}</UBadge>
                  <UBadge
                    :color="member.effective_active ? 'success' : 'neutral'"
                    variant="subtle"
                    size="sm"
                  >
                    {{ member.effective_active ? '在班' : '历史/已移出' }}
                  </UBadge>
                </div>
              </div>
              <span class="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary sm:text-sm">
                训练详情
                <UIcon name="i-lucide-arrow-right" class="size-4 transition-transform group-hover:translate-x-0.5" />
              </span>
            </NuxtLink>

            <div v-else class="flex min-w-0 flex-1 items-center gap-3">
              <div class="flex size-9 shrink-0 items-center justify-center rounded-full bg-bg-sunken text-text-secondary font-semibold text-sm">
                {{ member.username.slice(0, 1).toUpperCase() }}
              </div>
              <div class="flex min-w-0 flex-wrap items-center gap-2">
                <span class="break-all font-medium text-text">{{ member.username }}</span>
                <UBadge color="neutral" variant="subtle" size="sm">{{ member.role === 'student' ? '学生' : member.role }}</UBadge>
                <UBadge
                  :color="member.effective_active ? 'success' : 'neutral'"
                  variant="subtle"
                  size="sm"
                >
                  {{ member.effective_active ? '在班' : '历史/已移出' }}
                </UBadge>
              </div>
            </div>

            <div v-if="writable && member.effective_active" class="flex items-center justify-end sm:shrink-0 sm:border-l sm:border-border sm:pl-3">
              <UButton
                variant="ghost"
                color="neutral"
                size="xs"
                class="text-text-muted hover:bg-red-50 hover:text-error-text"
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
        class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-md border border-primary/20 bg-primary-bg px-5 py-4"
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
