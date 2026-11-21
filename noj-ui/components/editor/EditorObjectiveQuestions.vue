<script setup lang="ts">
import type { DomainObjectiveSnapshot } from '~/utils/domain-problem-editor';
import type { QuestionDraft } from '~/composables/useObjective';
const questions = defineModel<DomainObjectiveSnapshot[]>({ required: true });
const emit = defineEmits<{ editing: [active: boolean] }>();
const editing = ref<QuestionDraft | null>(null);
watch(() => editing.value !== null, (active) => emit('editing', active));
function edit(index?: number) {
  const source = index === undefined ? null : questions.value[index];
  editing.value = source ? { ...JSON.parse(JSON.stringify(source)), id: source.key } : {
    id: null,
    type: 'single',
    prompt: '',
    options: [{ key: 'A', text: '' }, { key: 'B', text: '' }],
    answer: [],
    explanation: '',
  };
}
function save(next: boolean) {
  const source = editing.value;
  if (!source) return;
  const key = source.id ?? crypto.randomUUID();
  const value: DomainObjectiveSnapshot = {
    key,
    sort_order: 0,
    type: source.type,
    prompt: source.prompt,
    options: source.options,
    answer: source.answer,
    explanation: source.explanation,
  };
  const index = questions.value.findIndex((item) => item.key === key);
  if (index < 0) questions.value.push(value);
  else questions.value[index] = value;
  questions.value.forEach((item, i) => {
    item.sort_order = i;
  });
  if (next) edit();
  else editing.value = null;
}
function remove(index: number) {
  questions.value.splice(index, 1);
  questions.value.forEach((item, i) => {
    item.sort_order = i;
  });
}
function move(index: number, delta: number) {
  const target = index + delta;
  if (target < 0 || target >= questions.value.length) return;
  [questions.value[index], questions.value[target]] = [questions.value[target]!, questions.value[index]!];
  questions.value.forEach((item, i) => {
    item.sort_order = i;
  });
}
</script>
<template>
  <section class="space-y-3">
    <div class="flex justify-between gap-3">
      <h3 class="font-semibold">客观题小题与答案</h3>
      <UButton variant="outline" @click="edit()">添加小题</UButton>
    </div>
    <p class="text-xs text-text-muted">小题修改先保留在本地表单，保存整份草稿后再发布。旧版本和历史答案不会被改写。</p>
    <UCard v-for="(question, index) in questions" :key="question.key">
      <div
        class="mb-2 flex flex-wrap items-center gap-2"><span class="mr-auto text-sm">第 {{ index + 1 }} 题 · {{ { single: '单选', multiple: '多选', judge: '判断' }[question.type] }}</span><UButton size="xs" variant="ghost" @click="edit(index)">编辑</UButton><UButton size="xs" variant="ghost" :disabled="index === 0" @click="move(index, -1)">上移</UButton><UButton size="xs" variant="ghost" :disabled="index === questions.length - 1" @click="move(index, 1)">下移</UButton><UButton size="xs" variant="ghost" color="error" @click="remove(index)">删除</UButton></div>
      <ObjectiveRichText :content="question.prompt" />
    </UCard>
    <ObjectiveQuestionForm v-if="editing" v-model="editing" :saving="false" @save="save" @cancel="editing = null" />
  </section>
</template>
