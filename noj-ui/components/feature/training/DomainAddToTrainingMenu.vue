<script setup lang="ts">
import type { DomainProblemReference } from '~/utils/domain-problems';
import { extractApiError } from '~/utils/apiError';
import { workspacePath } from '~/utils/workspace';
import { useToast } from '~/composables/useToast';

const props = defineProps<{ slug: string; problem: DomainProblemReference }>();
const api = useDomainTrainings();
const capture = useWorkspaceActionScope();
const { can } = useWorkspace();
const { toast } = useToast();
const open = ref(false), page = ref(1), loading = ref(false), saving = ref(false), failure = ref('');
const title = ref('');
const result = ref<Awaited<ReturnType<typeof api.list>> | null>(null);
const editable = computed(() => result.value?.items.filter((item) => item.can_edit) ?? []);

async function load(nextPage = 1) {
  const scope = capture();
  open.value = true;
  loading.value = true;
  failure.value = '';
  try {
    const list = await api.list(props.slug, nextPage);
    if (scope.isCurrent()) {
      result.value = list;
      page.value = nextPage;
    }
  } catch (error) {
    if (scope.isCurrent()) failure.value = extractApiError(error).message;
  } finally {
    if (scope.isCurrent()) loading.value = false;
  }
}

async function add(trainingId?: string) {
  if (saving.value) return;
  const scope = capture();
  const problem = props.problem;
  saving.value = true;
  failure.value = '';
  try {
    if (trainingId) {
      const { data } = await api.detail(scope.slug, trainingId);
      if (!data.items.some((item) => item.problem_id === problem.problem_id)) {
        await api.save(scope.slug, {
          title: data.title, description: data.description, visibility: data.visibility,
          problems: [...data.items.map((item) => item.display_ref), problem.display_ref],
        }, { id: data.id, revision: data.revision });
      }
    } else {
      await api.save(scope.slug, { title: title.value.trim(), description: '', visibility: 'private', problems: [problem.display_ref] });
    }
    if (scope.isCurrent()) {
      toast.success('已加入题单');
      open.value = false;
      title.value = '';
    }
  } catch (error) {
    if (scope.isCurrent()) failure.value = extractApiError(error).message;
  } finally {
    if (scope.isCurrent()) saving.value = false;
  }
}
</script>

<template>
  <div class="flex">
    <UButton size="lg" icon="i-lucide-list-plus" @click="load()">加入题单</UButton>
    <UModal v-model:open="open" title="加入题单" description="选择当前域中可编辑的题单，或新建一份。">
      <template #body>
        <div class="space-y-4">
          <UAlert v-if="failure" color="error" :title="failure" />
          <p v-if="loading" class="text-sm text-text-muted" role="status">正在读取题单…</p>
          <ul v-else-if="editable.length" class="divide-y divide-border">
            <li v-for="training in editable" :key="training.id" class="flex items-center justify-between gap-3 py-3">
              <NuxtLink :to="workspacePath(slug, `trainings/${training.id}`)" class="min-w-0 break-words text-sm text-text no-underline hover:text-primary">{{ training.title }}</NuxtLink>
              <UButton variant="outline" size="sm" :loading="saving" @click="add(training.id)">加入</UButton>
            </li>
          </ul>
          <p v-else-if="!failure" class="text-sm text-text-muted">本页暂无可编辑的题单。</p>
          <PaginationNav v-if="result && result.total > result.limit" :current-page="page" :total-pages="Math.ceil(result.total / result.limit)" @page-change="load($event)" />
          <form v-if="can('training:create')" class="flex flex-wrap gap-2 border-t border-border pt-4" @submit.prevent="add()">
            <UInput v-model="title" class="min-w-0 flex-1" placeholder="新题单名称" aria-label="新题单名称" required />
            <UButton type="submit" :loading="saving" :disabled="!title.trim()">新建并加入</UButton>
          </form>
        </div>
      </template>
    </UModal>
  </div>
</template>
