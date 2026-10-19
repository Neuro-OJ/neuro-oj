<script setup lang="ts">
import type { ClassroomDetail } from '~/utils/education';
import { assignmentPhase, educationCacheKey } from '~/utils/education';
import type { EducationDashboardData } from '~/utils/education-dashboard';
import { teachingNeedsAttention } from '~/utils/education-dashboard';
import { workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';

definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'], breadcrumbWidth: '72rem' });

const route = useRoute();
const router = useRouter();
const { domain, slug, can } = useWorkspace();
const actor = useState<{ id: string } | null>('auth:user', () => null);
const education = useEducationApi();
const capture = useWorkspaceActionScope();

// 页面基础分页与模态框状态
const roomPage = ref(1);
const taskPage = ref(1);
const open = ref(false);
const saving = ref(false);
const form = reactive({ name: '', description: '', stage_tag: '' });
const createError = ref('');

// 班级列表数据
const { data: roomsData, status: roomsStatus, error: roomsError, refresh: refreshRooms } = await useAsyncData(
  () => educationCacheKey(slug.value ?? '', actor.value?.id ?? null, 'classrooms', roomPage.value),
  () => education.classrooms(slug.value!, roomPage.value),
);

// 判断当前用户是否具备教练/教学管理权限
const isCoachOrManager = computed(() => {
  if (can('classroom:create')) return true;
  const list = roomsData.value?.data ?? [];
  return list.some((item) => {
    // 列表契约未保证任职字段；旧快照或扩展响应中的可选身份仅用于入口展示。
    const r: Partial<ClassroomDetail> = item;
    return r.manages_domain;
  });
});

// 当前激活的视图（带班教学 / 我的学习 / 班级大厅）
const currentView = ref<'teaching' | 'learning' | 'rooms'>('teaching');

// 初始化并监听 URL query 参数同步视图
function syncViewFromQuery() {
  const qv = route.query.view;
  if (qv === 'teaching' || qv === 'learning' || qv === 'rooms') {
    currentView.value = qv;
  } else {
    currentView.value = isCoachOrManager.value ? 'teaching' : 'learning';
  }
}

syncViewFromQuery();

watch(() => route.query.view, () => {
  syncViewFromQuery();
});

watch(currentView, (v) => {
  if (route.query.view !== v) {
    router.replace({ query: { ...route.query, view: v } });
  }
});

// 根据权限动态计算 Tab 选项
const viewTabItems = computed(() => {
  const items = [];
  if (isCoachOrManager.value) {
    items.push({ label: '带班教学', value: 'teaching', icon: 'i-lucide-presentation' });
  }
  items.push({ label: '我的学习', value: 'learning', icon: 'i-lucide-book-open' });
  items.push({
    label: `班级大厅 (${roomsData.value?.data.length ?? 0})`,
    value: 'rooms',
    icon: 'i-lucide-school',
  });
  return items;
});

// 教学大盘数据（按需异步加载）
const teachingKey = computed(() =>
  educationCacheKey(slug.value!, actor.value?.id ?? null, 'hub-teaching', taskPage.value)
);
const { data: teachingData, status: teachingStatus, error: teachingError, refresh: refreshTeaching } =
  await useAsyncData(
    teachingKey,
    () => education.dashboard(slug.value!, 'teaching', taskPage.value),
  );

// 学习大盘数据（按需异步加载）
const learningKey = computed(() =>
  educationCacheKey(slug.value!, actor.value?.id ?? null, 'hub-learning', taskPage.value)
);
const { data: learningData, status: learningStatus, error: learningError, refresh: refreshLearning } =
  await useAsyncData(
    learningKey,
    () => education.dashboard(slug.value!, 'my-learning', taskPage.value),
  );

// 任务过滤状态
const taskFilter = ref('all');
const roomSearch = ref('');
const roomStageFilter = ref('all');

// 统一刷新方法
async function refreshAll() {
  await Promise.all([refreshRooms(), refreshTeaching(), refreshLearning()]);
}

// 轮询评测与 SSE 变更通知
usePolling({
  intervalMs: computed(() => {
    const tTasks = teachingData.value?.data.assignments ?? [];
    const lTasks = learningData.value?.data.assignments ?? [];
    return [...tTasks, ...lTasks].some((task) => task.summary.updating) ? 3000 : null;
  }),
  immediate: false,
  fetcher: () => refreshAll(),
});

useEducationNotifications(() => refreshAll());

// 教学指标统计计算
const visibleTeachingTasks = computed(() => {
  const list = teachingData.value?.data.assignments ?? [];
  return list.filter((task) => {
    if (taskFilter.value === 'attention') return teachingNeedsAttention(task);
    if (taskFilter.value === 'active') return assignmentPhase(task) === '进行中';
    return true;
  });
});

const teachingAttentionCount = computed(() =>
  (teachingData.value?.data.assignments ?? []).filter((task) => teachingNeedsAttention(task)).length
);

const teachingActiveTasksCount = computed(() =>
  (teachingData.value?.data.assignments ?? []).filter((task) => assignmentPhase(task) === '进行中').length
);

const teachingPendingHelp = computed(() =>
  (teachingData.value?.data.help_requests ?? []).filter((r) => r.state === 'open')
);

// 学习指标统计计算
const visibleLearningTasks = computed(() => {
  const list = learningData.value?.data.assignments ?? [];
  return list.filter((task) => {
    if (taskFilter.value === 'active') return assignmentPhase(task) === '进行中';
    return true;
  });
});

const learningActiveTasksCount = computed(() =>
  (learningData.value?.data.assignments ?? []).filter((task) => assignmentPhase(task) === '进行中').length
);

// 班级检索与过滤计算
const stageOptions = computed(() => {
  const stages = new Set<string>();
  for (const r of roomsData.value?.data ?? []) {
    if (r.stage_tag) stages.add(r.stage_tag);
  }
  return [{ label: '全部阶段', value: 'all' }, ...Array.from(stages).map((s) => ({ label: s, value: s }))];
});

const filteredRooms = computed(() => {
  const list = roomsData.value?.data ?? [];
  return list.filter((r) => {
    if (roomSearch.value.trim() && !r.name.toLowerCase().includes(roomSearch.value.trim().toLowerCase())) {
      return false;
    }
    if (roomStageFilter.value !== 'all' && r.stage_tag !== roomStageFilter.value) {
      return false;
    }
    return true;
  });
});

// 创建新班级
async function create() {
  if (saving.value) return;
  const scope = capture();
  saving.value = true;
  createError.value = '';
  try {
    const result = await education.createClassroom(scope.slug, { ...form });
    if (scope.isCurrent()) {
      open.value = false;
      await navigateTo(workspacePath(scope.slug, `classrooms/${result.data.id}`));
    }
  } catch (e) {
    if (scope.isCurrent()) createError.value = extractApiError(e).message;
  } finally {
    saving.value = false;
  }
}

useSeoMeta({ title: '班级研练中心' });
</script>

<template>
  <div class="flex flex-col gap-6">
    <!-- 顶栏：标题与操作 -->
    <LibraryPageHeader
      title="班级研练中心"
      description="统一管理空间教学任务、追踪学员达标进展、诊断资源失效与处理求助反馈。"
      icon="i-lucide-graduation-cap"
    >
      <template #actions>
        <div class="flex flex-wrap items-center gap-2">
          <UButton
            :to="workspacePath(slug!, 'notifications')"
            variant="ghost"
            color="neutral"
            icon="i-lucide-bell"
          >
            教学通知
          </UButton>
          <UButton
            icon="i-lucide-refresh-cw"
            variant="ghost"
            color="neutral"
            aria-label="刷新数据"
            @click="refreshAll()"
          />
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
    </LibraryPageHeader>

    <!-- 研练中枢多视角切换 Tab -->
    <UTabs v-model="currentView" :items="viewTabItems" :content="false" class="w-full sm:w-fit" />

    <!-- 视角 1: 教练带班中枢 (Teaching View) -->
    <div v-show="currentView === 'teaching'" class="space-y-6">
      <!-- 指标大盘卡片行 -->
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3.5">
        <div class="rounded-lg border border-border bg-bg-panel p-4 flex items-center gap-3.5">
          <div class="flex size-11 shrink-0 items-center justify-center rounded-lg bg-primary-bg text-primary">
            <UIcon name="i-lucide-clipboard-check" class="size-5" />
          </div>
          <div class="min-w-0">
            <p class="text-xs text-text-muted truncate">进行中教学任务</p>
            <p class="text-xl font-bold text-text tabular-nums mt-0.5">
              {{ teachingActiveTasksCount }}
              <span class="text-xs font-normal text-text-muted">/ {{ teachingData?.data.total ?? 0 }}</span>
            </p>
          </div>
        </div>

        <div class="rounded-lg border border-border bg-bg-panel p-4 flex items-center gap-3.5">
          <div
            class="flex size-11 shrink-0 items-center justify-center rounded-lg"
            :class="teachingAttentionCount > 0 ? 'bg-warning-bg text-warning' : 'bg-success-bg text-success'"
          >
            <UIcon name="i-lucide-alert-circle" class="size-5" />
          </div>
          <div class="min-w-0">
            <p class="text-xs text-text-muted truncate">需关注学情预警</p>
            <p class="text-xl font-bold text-text tabular-nums mt-0.5">
              {{ teachingAttentionCount }}
            </p>
          </div>
        </div>

        <div class="rounded-lg border border-border bg-bg-panel p-4 flex items-center gap-3.5">
          <div
            class="flex size-11 shrink-0 items-center justify-center rounded-lg"
            :class="teachingPendingHelp.length > 0 ? 'bg-warning-bg text-warning' : 'bg-bg-sunken text-text-secondary'"
          >
            <UIcon name="i-lucide-message-circle-question" class="size-5" />
          </div>
          <div class="min-w-0">
            <p class="text-xs text-text-muted truncate">待答复学员求助</p>
            <p class="text-xl font-bold text-text tabular-nums mt-0.5">
              {{ teachingPendingHelp.length }}
            </p>
          </div>
        </div>

        <div class="rounded-lg border border-border bg-bg-panel p-4 flex items-center gap-3.5">
          <div class="flex size-11 shrink-0 items-center justify-center rounded-lg bg-bg-sunken text-text-secondary">
            <UIcon name="i-lucide-school" class="size-5" />
          </div>
          <div class="min-w-0">
            <p class="text-xs text-text-muted truncate">管理班级总数</p>
            <p class="text-xl font-bold text-text tabular-nums mt-0.5">
              {{ roomsData?.data.length ?? 0 }}
            </p>
          </div>
        </div>
      </div>

      <!-- 紧急待办与求助卡片 (如有未答复求助时突出展示) -->
      <div
        v-if="teachingPendingHelp.length > 0"
        class="rounded-lg border border-warning/30 bg-warning-bg/40 p-4 space-y-3"
      >
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2 text-warning font-semibold text-sm">
            <UIcon name="i-lucide-message-circle-warning" class="size-4 shrink-0" />
            <span>发现 {{ teachingPendingHelp.length }} 条待回复的学员求助</span>
          </div>
        </div>
        <div class="divide-y divide-border/60">
          <div
            v-for="req in teachingPendingHelp.slice(0, 3)"
            :key="req.id"
            class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 py-2 text-xs"
          >
            <span class="text-text font-medium">{{ req.classroom_name }} · {{ req.assignment_title }}</span>
            <UButton
              :to="{ path: workspacePath(slug!, `assignments/${req.assignment_id}`), query: { help: req.id } }"
              variant="outline"
              color="warning"
              size="xs"
              trailing-icon="i-lucide-external-link"
            >
              立即回复
            </UButton>
          </div>
        </div>
      </div>

      <!-- 教学任务列表控制栏 -->
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-layers" class="size-5 text-primary" />
          <h2 class="font-semibold text-text text-base">班级教学任务列表</h2>
          <span class="text-xs text-text-muted tabular-nums">({{ visibleTeachingTasks.length }} 项)</span>
        </div>
        <USelect
          v-model="taskFilter"
          :items="[
            { label: '全部教学任务', value: 'all' },
            { label: '仅看进行中', value: 'active' },
            { label: '仅看需跟进学情', value: 'attention' },
          ]"
          aria-label="教学任务筛选"
          class="w-44"
        />
      </div>

      <!-- 教学任务卡片网格 -->
      <AsyncContent
        :status="teachingError ? 'error' : teachingStatus === 'pending' ? 'loading' : visibleTeachingTasks.length ? 'data' : 'empty'"
        :error="teachingError ? extractApiError(teachingError).message : undefined"
        empty-text="当前没有符合条件的教学任务"
        @retry="refreshTeaching()"
      >
        <div class="grid gap-4 md:grid-cols-2">
          <div
            v-for="task in visibleTeachingTasks"
            :key="task.id"
            class="group flex flex-col justify-between rounded-lg border border-border bg-bg-panel p-5 transition-all hover:border-primary/50"
          >
            <div class="space-y-3">
              <!-- 班级来源与状态徽章 -->
              <div class="flex items-start justify-between gap-2">
                <NuxtLink
                  :to="workspacePath(slug!, `classrooms/${task.classroom_id}`)"
                  class="inline-flex items-center gap-1 text-xs font-medium text-text-secondary hover:text-primary transition-colors max-w-[70%] truncate"
                >
                  <UIcon name="i-lucide-school" class="size-3.5 shrink-0 text-text-muted" />
                  <span class="truncate">{{ task.classroom_name }}</span>
                </NuxtLink>
                <UBadge
                  :color="assignmentPhase(task) === '进行中' ? 'primary' : assignmentPhase(task) === '已截止，可继续练习' ? 'neutral' : 'warning'"
                  variant="subtle"
                  size="sm"
                >
                  {{ assignmentPhase(task) }}
                </UBadge>
              </div>

              <!-- 任务标题 -->
              <NuxtLink
                :to="workspacePath(slug!, `assignments/${task.id}`)"
                class="block font-semibold text-text group-hover:text-primary transition-colors text-base line-clamp-1"
              >
                {{ task.title }}
              </NuxtLink>

              <!-- 时间与题量元信息 -->
              <div class="flex flex-wrap items-center gap-3 text-xs text-text-muted">
                <span class="inline-flex items-center gap-1 tabular-nums">
                  <UIcon name="i-lucide-clock" class="size-3.5" />
                  {{ task.deadline_at ? `截止 ${new Date(task.deadline_at).toLocaleString()}` : '未设置截止时间' }}
                </span>
                <span class="inline-flex items-center gap-1 tabular-nums">
                  <UIcon name="i-lucide-file-code" class="size-3.5" />
                  {{ task.summary.total_items }} 道题目
                </span>
              </div>

              <!-- 评测状态或学情诊断 -->
              <UAlert v-if="task.summary.updating" color="info" title="成绩正在评测更新中..." />
              <div v-else class="rounded-lg bg-bg-sunken p-3 text-xs tabular-nums space-y-1 border border-border/40">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <span v-if="task.summary.total_students != null" class="text-text-secondary">
                    目标学生：<strong class="text-text">{{ task.summary.total_students }}</strong> 人
                  </span>
                  <span
                    v-if="task.summary.below_target_students != null"
                    :class="task.summary.below_target_students > 0 ? 'text-warning font-semibold' : 'text-text-secondary'"
                  >
                    未达标：{{ task.summary.below_target_students }} 人
                  </span>
                  <span v-if="task.summary.achieved_cells != null" class="text-text-muted">
                    达标单元：{{ task.summary.achieved_cells }} 个
                  </span>
                </div>
              </div>

              <UAlert
                v-if="task.summary.unavailable_items > 0"
                color="warning"
                :title="`${task.summary.unavailable_items} 道题目资源不可用，请检查共享状态`"
              />
            </div>

            <!-- 快捷动作底栏 -->
            <div class="mt-4 pt-3.5 border-t border-border flex items-center justify-between gap-2">
              <UButton
                :to="workspacePath(slug!, `classrooms/${task.classroom_id}`)"
                variant="ghost"
                color="neutral"
                size="sm"
              >
                进入班级
              </UButton>
              <UButton
                :to="workspacePath(slug!, `assignments/${task.id}`)"
                variant="outline"
                color="primary"
                size="sm"
                trailing-icon="i-lucide-arrow-right"
              >
                查看学情与批改矩阵
              </UButton>
            </div>
          </div>
        </div>

        <template #empty>
          <div class="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-bg-panel py-12 px-4 text-center">
            <UIcon name="i-lucide-clipboard-check" class="size-10 text-text-muted mb-2" />
            <p class="font-medium text-text">暂无正在进行的教学任务</p>
            <p class="text-xs text-text-muted mt-1">进入具体的班级后，点击「创建作业」即可向学员布置训练任务。</p>
          </div>
        </template>
      </AsyncContent>
    </div>

    <!-- 视角 2: 我的学习大盘 (Learning View) -->
    <div v-show="currentView === 'learning'" class="space-y-6">
      <!-- 个人学习指标卡 -->
      <div class="grid grid-cols-2 md:grid-cols-3 gap-3.5">
        <div class="rounded-lg border border-border bg-bg-panel p-4 flex items-center gap-3.5">
          <div class="flex size-11 shrink-0 items-center justify-center rounded-lg bg-primary-bg text-primary">
            <UIcon name="i-lucide-book-open" class="size-5" />
          </div>
          <div class="min-w-0">
            <p class="text-xs text-text-muted truncate">进行中作业</p>
            <p class="text-xl font-bold text-text tabular-nums mt-0.5">
              {{ learningActiveTasksCount }}
              <span class="text-xs font-normal text-text-muted">/ {{ learningData?.data.total ?? 0 }}</span>
            </p>
          </div>
        </div>

        <div class="rounded-lg border border-border bg-bg-panel p-4 flex items-center gap-3.5">
          <div class="flex size-11 shrink-0 items-center justify-center rounded-lg bg-success-bg text-success">
            <UIcon name="i-lucide-check-circle-2" class="size-5" />
          </div>
          <div class="min-w-0">
            <p class="text-xs text-text-muted truncate">当前页作业总数</p>
            <p class="text-xl font-bold text-text tabular-nums mt-0.5">
              {{ visibleLearningTasks.length }}
            </p>
          </div>
        </div>

        <div class="col-span-2 md:col-span-1 rounded-lg border border-border bg-bg-panel p-4 flex items-center gap-3.5">
          <div class="flex size-11 shrink-0 items-center justify-center rounded-lg bg-bg-sunken text-text-secondary">
            <UIcon name="i-lucide-message-circle-question" class="size-5" />
          </div>
          <div class="min-w-0">
            <p class="text-xs text-text-muted truncate">求助与教练答复</p>
            <p class="text-xl font-bold text-text tabular-nums mt-0.5">
              {{ learningData?.data.help_requests.length ?? 0 }}
            </p>
          </div>
        </div>
      </div>

      <!-- 学生作业卡片网格 -->
      <AsyncContent
        :status="learningError ? 'error' : learningStatus === 'pending' ? 'loading' : visibleLearningTasks.length ? 'data' : 'empty'"
        :error="learningError ? extractApiError(learningError).message : undefined"
        empty-text="当前没有分配给你的作业任务"
        @retry="refreshLearning()"
      >
        <div class="grid gap-4 md:grid-cols-2">
          <div
            v-for="task in visibleLearningTasks"
            :key="task.id"
            class="group flex flex-col justify-between rounded-lg border border-border bg-bg-panel p-5 transition-all hover:border-primary/50"
          >
            <div class="space-y-3">
              <div class="flex items-start justify-between gap-2">
                <NuxtLink
                  :to="workspacePath(slug!, `classrooms/${task.classroom_id}`)"
                  class="inline-flex items-center gap-1 text-xs font-medium text-text-secondary hover:text-primary transition-colors max-w-[70%] truncate"
                >
                  <UIcon name="i-lucide-school" class="size-3.5 shrink-0 text-text-muted" />
                  <span class="truncate">{{ task.classroom_name }}</span>
                </NuxtLink>
                <UBadge
                  :color="assignmentPhase(task) === '进行中' ? 'primary' : assignmentPhase(task) === '已截止，可继续练习' ? 'neutral' : 'warning'"
                  variant="subtle"
                  size="sm"
                >
                  {{ assignmentPhase(task) }}
                </UBadge>
              </div>

              <NuxtLink
                :to="workspacePath(slug!, `assignments/${task.id}`)"
                class="block font-semibold text-text group-hover:text-primary transition-colors text-base line-clamp-1"
              >
                {{ task.title }}
              </NuxtLink>

              <div class="flex flex-wrap items-center gap-3 text-xs text-text-muted">
                <span class="inline-flex items-center gap-1 tabular-nums">
                  <UIcon name="i-lucide-clock" class="size-3.5" />
                  {{ task.deadline_at ? `截止 ${new Date(task.deadline_at).toLocaleString()}` : '未设置截止时间' }}
                </span>
                <span class="inline-flex items-center gap-1 tabular-nums">
                  <UIcon name="i-lucide-file-code" class="size-3.5" />
                  {{ task.summary.total_items }} 道题目
                </span>
              </div>

              <!-- 个人达标进度条 -->
              <div class="rounded-lg bg-bg-sunken p-3 text-xs tabular-nums space-y-1.5 border border-border/40">
                <div class="flex items-center justify-between font-medium">
                  <span class="text-text-secondary">个人达标进度</span>
                  <span class="text-text">
                    已达标 {{ task.summary.achieved_cells ?? 0 }} / {{ task.summary.total_items }} 题
                  </span>
                </div>
                <div class="w-full bg-border/60 rounded-full h-1.5 overflow-hidden">
                  <div
                    class="bg-primary h-full transition-all duration-300"
                    :style="{
                      width: `${Math.min(100, Math.round(((task.summary.achieved_cells ?? 0) / Math.max(1, task.summary.total_items)) * 100))}%`
                    }"
                  />
                </div>
              </div>
            </div>

            <div class="mt-4 pt-3.5 border-t border-border">
              <UButton
                :to="workspacePath(slug!, `assignments/${task.id}`)"
                color="primary"
                size="sm"
                class="w-full justify-center"
                trailing-icon="i-lucide-arrow-right"
              >
                查看作业与答题
              </UButton>
            </div>
          </div>
        </div>

        <template #empty>
          <div class="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-bg-panel py-12 px-4 text-center">
            <UIcon name="i-lucide-book-open" class="size-10 text-text-muted mb-2" />
            <p class="font-medium text-text">暂无正在进行的作业</p>
            <p class="text-xs text-text-muted mt-1">教练布置作业后将在此处实时推送显示。</p>
          </div>
        </template>
      </AsyncContent>

      <!-- 求助回复信箱卡片 -->
      <div v-if="(learningData?.data.help_requests.length ?? 0) > 0" class="rounded-lg border border-border bg-bg-panel p-4 space-y-3">
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-message-circle-question" class="size-5 text-primary" />
          <h3 class="font-semibold text-text text-sm">我的求助与教练回复</h3>
        </div>
        <div class="divide-y divide-border">
          <div
            v-for="req in learningData?.data.help_requests"
            :key="req.id"
            class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 py-2.5 text-xs"
          >
            <div class="flex items-center gap-2">
              <UBadge :color="req.state === 'open' ? 'warning' : 'neutral'" variant="subtle" size="xs">
                {{ req.state === 'open' ? '等待教练答复' : '已回复' }}
              </UBadge>
              <span class="text-text font-medium">{{ req.classroom_name }} · {{ req.assignment_title }}</span>
            </div>
            <UButton
              :to="{ path: workspacePath(slug!, `assignments/${req.assignment_id}`), query: { help: req.id } }"
              variant="outline"
              color="primary"
              size="xs"
              trailing-icon="i-lucide-external-link"
            >
              查看讨论详情
            </UButton>
          </div>
        </div>
      </div>
    </div>

    <!-- 视角 3: 班级大厅列表 (Rooms View) -->
    <div v-show="currentView === 'rooms'" class="space-y-4">
      <!-- 搜索与阶段过滤 -->
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg border border-border bg-bg-panel p-4">
        <div class="flex flex-wrap items-center gap-2">
          <UInput
            v-model="roomSearch"
            icon="i-lucide-search"
            placeholder="按班级名称检索..."
            aria-label="搜索班级名称"
            class="w-full sm:w-56"
          />
          <USelect
            v-model="roomStageFilter"
            :items="stageOptions"
            aria-label="按阶段筛选班级"
            class="w-36"
          />
        </div>

        <div class="text-xs text-text-muted tabular-nums sm:text-right">
          共 <strong class="text-text font-semibold">{{ filteredRooms.length }}</strong> 个班级
        </div>
      </div>

      <!-- 班级卡片网格 -->
      <AsyncContent
        :status="roomsError ? 'error' : roomsStatus === 'pending' ? 'loading' : filteredRooms.length ? 'data' : 'empty'"
        :error="roomsError ? extractApiError(roomsError).message : undefined"
        :empty-text="roomSearch || roomStageFilter !== 'all' ? '未找到符合条件的班级' : '你尚未加入任何班级'"
        @retry="refreshRooms()"
      >
        <div class="grid gap-4 md:grid-cols-2">
          <div
            v-for="room in filteredRooms"
            :key="room.id"
            class="flex flex-col justify-between rounded-lg border border-border bg-bg-panel p-5 transition-all hover:border-primary/50"
          >
            <div>
              <div class="flex items-start justify-between gap-3">
                <div class="flex min-w-0 items-center gap-3">
                  <div class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary-bg text-primary">
                    <UIcon name="i-lucide-school" class="size-5" />
                  </div>
                  <div class="min-w-0">
                    <h2 class="font-semibold text-text break-words">
                      <NuxtLink :to="workspacePath(slug!, `classrooms/${room.id}`)" class="hover:text-primary transition-colors">
                        {{ room.name }}
                      </NuxtLink>
                    </h2>
                    <p v-if="room.stage_tag" class="mt-0.5 text-xs text-text-muted break-words">
                      {{ room.stage_tag }}
                    </p>
                  </div>
                </div>
                <UBadge v-if="room.status === 'archived'" color="neutral" variant="subtle" size="sm" class="shrink-0">
                  已归档
                </UBadge>
                <UBadge v-else color="success" variant="subtle" size="sm" class="shrink-0">
                  正常教学
                </UBadge>
              </div>

              <p class="mt-3 text-sm text-text-secondary line-clamp-2">
                {{ room.description || '暂无班级简介' }}
              </p>
            </div>

            <div class="mt-4 pt-3 border-t border-border flex items-center justify-between gap-2">
              <UButton
                v-if="isCoachOrManager"
                :to="workspacePath(slug!, `classrooms/${room.id}/members`)"
                variant="ghost"
                color="neutral"
                size="sm"
                icon="i-lucide-users"
              >
                成员管理
              </UButton>
              <UButton
                :to="workspacePath(slug!, `classrooms/${room.id}`)"
                variant="outline"
                color="primary"
                size="sm"
                class="ml-auto"
                trailing-icon="i-lucide-arrow-right"
              >
                进入班级
              </UButton>
            </div>
          </div>
        </div>

        <template #empty>
          <div class="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-bg-panel py-12 px-4 text-center">
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
    </div>

    <!-- 创建班级弹窗 -->
    <UModal v-model:open="open" title="创建新班级">
      <template #body>
        <form class="space-y-4" @submit.prevent="create">
          <UAlert v-if="createError" color="error" :title="createError" />
          <AdminFormField label="班级名称" required>
            <UInput
              v-model="form.name"
              class="w-full"
              :maxlength="120"
              required
              aria-label="班级名称"
              placeholder="如：2026春季 NOIP 强化班"
            />
          </AdminFormField>
          <AdminFormField label="阶段标签" hint="如：入门组 / 提高组 / 省选强化">
            <UInput
              v-model="form.stage_tag"
              class="w-full"
              :maxlength="80"
              aria-label="阶段标签"
              placeholder="用于班级分类与快速检索"
            />
          </AdminFormField>
          <AdminFormField label="班级简介">
            <UTextarea
              v-model="form.description"
              class="w-full"
              :maxlength="10000"
              aria-label="班级简介"
              placeholder="说明班级教学目标、课时安排或训练计划"
            />
          </AdminFormField>
          <div class="flex justify-end gap-2 pt-2">
            <UButton variant="ghost" color="neutral" :disabled="saving" @click="open = false">取消</UButton>
            <UButton type="submit" color="primary" :loading="saving" :disabled="!form.name.trim()">
              创建并进入班级
            </UButton>
          </div>
        </form>
      </template>
    </UModal>
  </div>
</template>
