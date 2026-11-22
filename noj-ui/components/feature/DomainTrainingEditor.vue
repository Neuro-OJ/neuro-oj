<script setup lang="ts">
import type { DomainTrainingDetail, DomainTrainingInput } from '~/composables/useDomainTrainings';
import { extractApiError } from '~/utils/apiError';
const props = defineProps<{ slug: string; initial?: DomainTrainingDetail }>();
const emit = defineEmits<{ saved: [id: string] }>();
const api = useDomainTrainings(), capture = useWorkspaceActionScope(), { dialog } = useDialog();
const form = ref<DomainTrainingInput>({
  title: props.initial?.title ?? '',
  description: props.initial?.description ?? '',
  visibility: props.initial?.visibility ?? 'private',
  state: props.initial?.state ?? 'draft',
  problems: props.initial?.items.map((item) => item.display_ref) ?? [],
});
const original = JSON.stringify(form.value), saving = ref(false), failure = ref('');
const dirty = computed(() => JSON.stringify(form.value) !== original);
async function save() {
  if (saving.value || !form.value.title.trim()) return;
  const scope = capture(), input = JSON.parse(JSON.stringify(form.value)) as DomainTrainingInput;
  saving.value = true;
  failure.value = '';
  try {
    const response = await api.save(
      scope.slug,
      input,
      props.initial ? { id: props.initial.id, revision: props.initial.revision } : undefined,
    );
    if (scope.isCurrent()) {
      saved.value = true;
      emit('saved', response.data.id);
    }
  } catch (error) {
    if (scope.isCurrent()) failure.value = `${extractApiError(error).message}。当前编辑内容保留。`;
  } finally {
    if (scope.isCurrent()) saving.value = false;
  }
}
const saved = ref(false);
onBeforeRouteLeave(async () =>
  saved.value || !dirty.value || await dialog.confirm('离开编辑器？题单修改尚未保存。', { title: '未保存的题单' })
);
</script>
<template>
  <form class="space-y-5" @submit.prevent="save">
    <UAlert v-if="failure" color="error" :title="failure" />
    <fieldset :disabled="saving" class="space-y-5">
      <UCard class="space-y-4">
        <AdminFormField label="题单标题" required>
          <UInput v-model="form.title" required maxlength="100" class="w-full" />
        </AdminFormField>
        <AdminFormField label="说明">
          <MarkdownEditor v-model="form.description" />
        </AdminFormField>
        <AdminFormField label="准备状态">
          <USelect v-model="form.state"
            :items="[{ label: '草稿', value: 'draft' }, { label: '已发布', value: 'published' }]" />
        </AdminFormField>
        <p
          class="text-xs text-text-muted">发布后的访问范围由所属域决定。跨域复用须先复制为本域独立题目；比赛保护仍逐题生效。</p>
      </UCard>
      <UCard>
        <DomainProblemChooser v-model="form.problems" :slug="slug" :disabled="saving" />
      </UCard>
    </fieldset>
    <UButton type="submit" :loading="saving"
      :disabled="!form.title.trim() || form.problems.length > 200">保存题单</UButton>
  </form>
</template>
