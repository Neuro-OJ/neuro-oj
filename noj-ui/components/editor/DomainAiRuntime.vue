<script setup lang="ts">
import type { DomainAiRuntime, DomainEditorContent } from '~/utils/domain-problem-editor';
const content = defineModel<DomainEditorContent>({ required: true });
defineProps<{ published: boolean }>();
const { user } = useAuth(), api = useDomainProblemEditor();
const { slug } = useWorkspace();
const { api: http } = useApi();
const runtime = computed(() => content.value.runtime_config as DomainAiRuntime);
const prediction = computed(() => content.value.submission_mode === 'prediction');
const aliases = await useAsyncData(
  () => `domain-llm-capabilities:${slug.value}:${user.value?.id}`,
  () => http.get<{ data: { alias: string; description: string }[] }>(
    `/api/v1/domains/${encodeURIComponent(slug.value!)}/problems/llm-model-aliases`, { silent: true },
  ),
);
const selectedModels = computed({
  get: () => content.value.llm_config?.models ?? ['default'],
  set: (models: string[]) => { if (content.value.llm_config) content.value.llm_config.models = models; },
});
const artifactSize = computed({
  get: () => content.value.artifact_max_size_mb ?? undefined,
  set: (value: number | undefined) => {
    content.value.artifact_max_size_mb = value ?? null;
  },
});
const template = computed({
  get: () => content.value.template_content ?? '',
  set: (value: string) => {
    content.value.template_content = value;
  },
});
const can = (capability: string) =>
  user.value?.is_admin || user.value?.permissions?.includes('admin:full_access') ||
  user.value?.permissions?.includes(capability);
const images = await useAsyncData(() => `instance-judge-images:${user.value?.id}`, () => api.images());
const imageItems = (kind: string) =>
  images.data.value?.data.filter((item) => item.kind === kind).map((item) => item.image) ?? [];
function llm(enabled: boolean) {
  content.value.llm_config = enabled ? {} : null;
  if (enabled) runtime.value.evaluator.network.enabled = true;
}
</script>
<template>
  <section class="space-y-4">
    <h3 class="font-semibold">AI 评测与提交方式</h3>
    <div class="grid gap-4 sm:grid-cols-2">
      <AdminFormField label="提交方式">
        <USelect v-model="content.submission_mode" :disabled="published"
          :items="[{ label: '代码', value: 'code' }, { label: '产物 ZIP', value: 'artifact' }, { label: '预测单文件', value: 'prediction' }, { label: '界面题', value: 'ui' }]" />
      </AdminFormField>
      <AdminFormField v-if="content.submission_mode === 'artifact' || prediction" label="提交文件大小上限（MiB）">
        <UInput v-model.number="artifactSize" type="number" min="1" />
      </AdminFormField>
    </div>
    <div class="grid gap-4 sm:grid-cols-2">
      <AdminFormField label="Evaluator 镜像">
        <USelect v-model="runtime.evaluator.image" :items="imageItems('evaluator')"
          placeholder="选择实例已允许的镜像" />
      </AdminFormField>
      <AdminFormField v-if="!prediction" label="Solution 镜像">
        <USelect v-model="runtime.solution.image" :items="imageItems('solution')" placeholder="选择实例已允许的镜像" />
      </AdminFormField>
    </div>
    <AdminFormField label="Evaluator 命令"
      :hint="can('problem:field_evaluator_command') ? undefined : '修改命令需要实例授权'">
      <UInput v-model="runtime.evaluator.command" :disabled="!can('problem:field_evaluator_command')"
        class="w-full font-mono" />
    </AdminFormField>
    <div class="grid gap-4 sm:grid-cols-2">
      <AdminFormField label="Evaluator 总时间（ms）">
        <UInput v-model.number="runtime.evaluator.time_limit_ms" type="number" min="1" />
      </AdminFormField>
      <AdminFormField label="Evaluator 内存（MiB）">
        <UInput v-model.number="runtime.evaluator.memory_limit_mb" type="number" min="1" />
      </AdminFormField>
      <AdminFormField v-if="!prediction" label="Solution 单次调用时间（ms）">
        <UInput v-model.number="runtime.solution.call_timeout_ms" type="number" min="1" />
      </AdminFormField>
      <AdminFormField v-if="!prediction" label="Solution 内存（MiB）">
        <UInput v-model.number="runtime.solution.memory_limit_mb" type="number" min="1" />
      </AdminFormField>
    </div>
    <AdminFormField v-if="prediction" label="预测评测工作区（MiB）" hint="留空采用 Judge 默认，允许 512–16384 MiB">
      <UInput v-model.number="runtime.evaluator.workspace_size_mb" type="number" min="512" max="16384" />
    </AdminFormField>
    <p v-if="prediction" class="text-xs text-text-muted">只运行 Evaluator，接收选手的预测文件。切换前请先移除此题的 LLM 配置。</p>
    <UCheckbox v-model="runtime.evaluator.network.enabled" label="允许 Evaluator 联网"
      :disabled="!can('problem:field_evaluator_network') || !!content.llm_config" />
    <UCheckbox :model-value="content.llm_config != null" label="此题允许 LLM 调用"
      :disabled="prediction || !can('problem:field_evaluator_network') && !runtime.evaluator.network.enabled"
      @update:model-value="value => llm(!!value)" />
    <div v-if="content.llm_config" class="grid gap-4 sm:grid-cols-2">
      <AdminFormField label="单次评测最大 LLM 调用次数">
        <UInput v-model.number="content.llm_config.max_calls" type="number" min="1"
          placeholder="留空使用实例默认预算" />
      </AdminFormField>
      <AdminFormField label="单次评测最大 Token">
        <UInput v-model.number="content.llm_config.max_tokens" type="number" min="1"
          placeholder="留空使用实例默认预算" />
      </AdminFormField>
    </div>
    <AdminFormField v-if="content.llm_config && !prediction" label="可调用的模型能力" hint="别名的实际模型与 Provider 由使用域配置">
      <UAlert v-if="aliases.error.value" color="error" title="读取本域模型能力失败" />
      <USelectMenu v-model="selectedModels" :items="aliases.data.value?.data ?? []" value-key="alias" label-key="alias" multiple />
    </AdminFormField>
    <p v-if="content.llm_config" class="text-xs text-text-muted">题目只声明能力与预算，Provider 和模型由使用域配置。</p>
    <AdminFormField v-if="content.submission_mode === 'code' || content.submission_mode === 'ui'" label="代码模板">
      <ClientOnly>
        <MonacoEditor v-model="template" language="python" :min-height="220" />
      </ClientOnly>
    </AdminFormField>
  </section>
</template>
