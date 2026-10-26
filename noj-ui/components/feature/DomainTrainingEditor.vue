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
        <AdminFormField label="展示范围">
          <USelect v-model="form.visibility"
            :items="[{ label: '仅作者与管理者', value: 'private' }, { label: '获准进入本域且持有链接', value: 'unlisted' }, { label: '公开展示', value: 'public' }]" />
        </AdminFormField>
        <p
          class="text-xs text-text-muted">公开题单只包含在本域公开展示的公开题。引用题继续显示来源题号，不复制内容。</p>
      </UCard>
      <UCard>
        <DomainProblemChooser v-model="form.problems" :slug="slug" :disabled="saving" />
      </UCard>
    </fieldset>
    <UButton type="submit" :loading="saving"
      :disabled="!form.title.trim() || form.problems.length > 200">保存题单</UButton>
  </form>
</template>
