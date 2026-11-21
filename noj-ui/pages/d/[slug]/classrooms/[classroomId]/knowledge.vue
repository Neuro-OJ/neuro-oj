<script setup lang="ts">
/**
 * 班级知识点掌握矩阵（P4，教练视角）：行 = 学生，列 = 知识点（按领域分组折叠）。
 *
 * - 权限与 `members.vue` 一致：复用班级详情 + `classroomCan(..., 'progress:read')`（教练/域管理员）；
 * - 总开关关闭（`KNOWLEDGE_DISABLED`）→ 整块隐藏，只显示「本实例未开启知识图谱。」；
 * - 单元格颜色与 `me/mastery` 徽标同口径（`masteryStateColor`），`title` 给中文状态；
 * - 学生或知识点多时横向滚动，首列（学生）粘性固定。
 */
import { classroomCan, educationCacheKey } from '~/utils/education';
import type { ClassroomDetail } from '~/utils/education';
import { extractApiError } from '~/utils/apiError';
import {
  type ClassroomMasteryArea,
  filterMasteryAreas,
  knowledgeNodePath,
  type MasteryState,
  masteryCellState,
  masteryCellTitle,
  masteryCountsText,
  masteryStateColor,
  masteryStudentLabel,
  type ClassroomMasteryView,
} from '~/utils/knowledge';
import { workspacePath } from '~/utils/workspace';

definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'], workspaceWidth: 'workspace' });

const route = useRoute();
const { slug, domain } = useWorkspace();
const education = useEducationApi();
const knowledge = useKnowledge();

const actor = useState<{ id: string } | null>('auth:user', () => null);
const id = computed(() => String(route.params.classroomId));

const base = computed(() => educationCacheKey(slug.value!, actor.value?.id ?? null, id.value, 'knowledge-mastery'));
const room = await useAsyncData<{ data: ClassroomDetail }>(
  () => `${base.value}:classroom`,
  () => education.classroom(slug.value!, id.value),
);
const canRead = computed(() => !!room.data.value && classroomCan(room.data.value.data, 'progress:read'));

const matrix = ref<ClassroomMasteryView | null>(null);
const loading = ref(false);
const failure = ref('');
const onlyLearning = ref(false);
/** 展开过的领域 id；领域默认展开第一个可见领域，其余需手动展开。 */
const expandedAreas = ref<string[]>([]);

/** 领域内容是否展示（默认只展开当前第一个可见领域）。 */
function areaOpen(areaId: string) {
  return expandedAreas.value.length ? expandedAreas.value.includes(areaId) : areaId === areas.value[0]?.id;
}
function toggleArea(areaId: string) {
  const current = new Set(expandedAreas.value.length ? expandedAreas.value : areas.value.slice(0, 1).map((a) => a.id));
  if (current.has(areaId)) current.delete(areaId);
  else current.add(areaId);
  expandedAreas.value = [...current];
}

async function load() {
  const currentSlug = slug.value, classId = id.value;
  if (!currentSlug) return;
  loading.value = true;
  failure.value = '';
  try {
    const view = await knowledge.loadClassroomMastery(currentSlug, classId);
    if (slug.value === currentSlug && id.value === classId) matrix.value = view;
  } catch (e) {
    if (slug.value === currentSlug && id.value === classId) failure.value = extractApiError(e).message;
  } finally {
    if (slug.value === currentSlug && id.value === classId) loading.value = false;
  }
}

const areas = computed<ClassroomMasteryArea[]>(() => filterMasteryAreas(matrix.value?.areas ?? [], onlyLearning.value));
const students = computed(() => matrix.value?.students ?? []);
const noNodes = computed(() => !!matrix.value && matrix.value.areas.length === 0);
const filteredEmpty = computed(() => !!matrix.value && !noNodes.value && areas.value.length === 0);

function cellState(userId: string, nodeId: string): MasteryState {
  return masteryCellState(matrix.value, userId, nodeId);
}
/** 色块：已掌握/学习中用主题色块，未开始为空格（仅内描边，避免满屏色块）。 */
function cellBoxClass(state: MasteryState) {
  const color = masteryStateColor(state);
  return color === 'success'
    ? 'bg-signal'
    : color === 'primary'
      ? 'bg-primary'
      : 'border border-border bg-transparent';
}

useBreadcrumbParams({ classroomId: () => room.data.value?.data.name });
useSeoMeta({ title: '知识点掌握' });

/** 默认展开第一个领域（领域过滤变化后仍保持首个可见领域展开）。 */
// 权限未加载完不发请求；权限变化（如身份切换）时再加载。
watch([() => slug.value, () => id.value, () => actor.value?.id, canRead], () => {
  matrix.value = null;
  if (canRead.value && !knowledge.disabled.value) load();
}, { immediate: true });
</script>

<template>
  <div class="flex flex-col gap-6">
    <ClassroomNavigation :slug="slug!" :classroom-id="id" :classroom="room.data.value?.data" />

    <LibraryPageHeader
      title="知识点掌握"
      :description="room.data.value?.data.name ? `查看「${room.data.value.data.name}」各知识点的学生掌握情况` : '查看班级知识点掌握情况'"
      icon="i-lucide-brain"
    />

    <p v-if="knowledge.disabled.value" class="py-12 text-center text-sm text-text-muted" data-testid="knowledge-disabled">
      本实例未开启知识图谱。
    </p>

    <UAlert
      v-else-if="!canRead"
      color="warning"
      variant="subtle"
      title="仅班级教练可查看知识点掌握情况"
      data-testid="knowledge-forbidden"
    />

    <UAlert v-else-if="failure" color="error" variant="subtle" :title="failure" />

    <template v-else>
      <div class="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-bg-panel p-4">
        <UCheckbox v-model="onlyLearning" label="只看有学生在学的知识点" data-testid="only-learning" />
        <span class="text-xs text-text-muted tabular-nums">
          共 <strong class="text-text font-semibold">{{ students.length }}</strong> 名学生 ·
          <strong class="text-text font-semibold">{{ matrix?.areas.reduce((sum, area) => sum + area.nodes.length, 0) ?? 0 }}</strong> 个知识点
        </span>
      </div>

      <p v-if="loading" class="py-12 text-center text-sm text-text-muted">正在加载掌握数据…</p>
      <p v-else-if="!students.length" class="py-12 text-center text-sm text-text-muted" data-testid="knowledge-empty-students">
        班级暂无在班学生，暂无可统计的掌握数据。
      </p>
      <p v-else-if="noNodes" class="py-12 text-center text-sm text-text-muted" data-testid="knowledge-empty-nodes">
        本域暂无可用知识点（需先为题目挂载知识点或在管理后台导入内容包）。
      </p>
      <p v-else-if="filteredEmpty" class="py-12 text-center text-sm text-text-muted" data-testid="knowledge-empty-filtered">
        当前没有学生在学的知识点，可取消筛选查看全部。
      </p>

      <section v-else class="overflow-hidden rounded-md border border-border bg-bg-panel" data-testid="mastery-matrix">
        <div
          v-for="area in areas"
          :key="area.id"
          class="border-b border-border last:border-b-0"
          :data-testid="`mastery-area-${area.id}`"
        >
          <button
            type="button"
            class="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm font-semibold text-text hover:bg-bg-sunken/40"
            :aria-expanded="areaOpen(area.id)"
            @click="toggleArea(area.id)"
          >
            <UIcon :name="areaOpen(area.id) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-4 shrink-0 text-text-muted" />
            <span>{{ area.name }}</span>
            <span class="text-xs font-normal text-text-muted tabular-nums">{{ area.nodes.length }} 个知识点</span>
          </button>

          <div v-if="areaOpen(area.id)" class="overflow-x-auto overscroll-x-contain">
            <table class="w-full border-collapse text-sm">
              <thead>
                <tr class="border-y border-border bg-bg-sunken/40">
                  <th
                    scope="col"
                    class="sticky left-0 z-10 min-w-40 border-r border-border bg-bg-sunken px-3 py-2 text-left text-xs font-medium text-text-secondary"
                  >
                    学生
                  </th>
                  <th
                    v-for="node in area.nodes"
                    :key="node.id"
                    scope="col"
                    class="min-w-24 px-2 py-2 text-center text-xs font-medium text-text-secondary"
                  >
                    <NuxtLink
                      :to="knowledgeNodePath(slug!, node.id)"
                      class="block truncate no-underline hover:text-primary"
                      :title="node.name"
                    >
                      {{ node.name }}
                    </NuxtLink>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="student in students" :key="student.user_id" class="border-b border-border last:border-b-0">
                  <th
                    scope="row"
                    class="sticky left-0 z-10 min-w-40 border-r border-border bg-bg-panel px-3 py-2 text-left font-normal"
                    :title="student.username"
                  >
                    <span class="block truncate text-text">{{ masteryStudentLabel(student) }}</span>
                    <span v-if="student.display_name" class="block truncate text-[11px] text-text-muted">{{ student.username }}</span>
                  </th>
                  <td v-for="node in area.nodes" :key="node.id" class="px-2 py-1.5 text-center">
                    <span
                      class="mx-auto block size-4 rounded-sm"
                      :class="cellBoxClass(cellState(student.user_id, node.id))"
                      :title="masteryCellTitle(masteryStudentLabel(student), node.name, cellState(student.user_id, node.id))"
                      :data-state="cellState(student.user_id, node.id)"
                      data-testid="mastery-cell"
                    />
                  </td>
                </tr>
              </tbody>
              <tfoot>
                <tr class="border-t border-border bg-bg-sunken/30">
                  <th scope="row" class="sticky left-0 z-10 border-r border-border bg-bg-sunken px-3 py-2 text-left text-xs font-medium text-text-muted">
                    掌握统计
                  </th>
                  <td
                    v-for="node in area.nodes"
                    :key="node.id"
                    class="whitespace-nowrap px-2 py-2 text-center text-[11px] text-text-muted tabular-nums"
                    :data-testid="`mastery-counts-${node.id}`"
                  >
                    {{ masteryCountsText(node.counts) }}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </section>

      <div class="flex flex-wrap items-center gap-4 text-xs text-text-muted">
        <span class="inline-flex items-center gap-1.5"><span class="size-3 rounded-sm bg-signal" />已掌握</span>
        <span class="inline-flex items-center gap-1.5"><span class="size-3 rounded-sm bg-primary" />学习中</span>
        <span class="inline-flex items-center gap-1.5"><span class="size-3 rounded-sm border border-border" />未开始</span>
        <span class="ml-auto">悬停单元格可查看具体状态</span>
      </div>
      <NuxtLink :to="workspacePath(slug!, 'classrooms')" class="sr-only">返回班级列表</NuxtLink>
    </template>
  </div>
</template>
