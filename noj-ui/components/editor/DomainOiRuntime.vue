<script setup lang="ts">
import type { DomainOiRuntime } from '~/utils/domain-problem-editor';
const runtime = defineModel<DomainOiRuntime>({ required: true });
function addSubtask() {
  runtime.value.subtasks.push({
    id: `subtask_${crypto.randomUUID()}`,
    score: 0,
    scoring: 'min',
    depends_on: [],
    cases: [],
  });
}
function addCase(index: number) {
  const task = runtime.value.subtasks[index]!;
  task.cases.push({ id: `case_${crypto.randomUUID()}`, input: '', output: '' });
}
</script>
<template>
  <section class="space-y-4">
    <h3 class="font-semibold">OI 评测配置</h3>
    <div class="grid gap-4 sm:grid-cols-3">
      <AdminFormField label="执行后端">
        <USelect v-model="runtime.backend"
          :items="[{ label: 'WASM', value: 'wasm' }, { label: '原生', value: 'native' }]" />
      </AdminFormField>
      <AdminFormField label="时间限制（ms）">
        <UInput v-model.number="runtime.time_limit_ms" type="number" min="1" />
      </AdminFormField>
      <AdminFormField label="内存限制（MiB）">
        <UInput v-model.number="runtime.memory_limit_mb" type="number" min="1" />
      </AdminFormField>
    </div>
    <AdminFormField label="允许提交语言">
      <USelectMenu v-model="runtime.languages" multiple
        :items="[{ label: 'C99', value: 'c' }, { label: 'C++11', value: 'cc' }]" value-key="value" />
    </AdminFormField>
    <div class="grid gap-4 sm:grid-cols-2">
      <AdminFormField label="比较器">
        <USelect v-model="runtime.checker.type"
          :items="[{ label: '忽略空白 token', value: 'default' }, { label: '严格逐字节', value: 'strict' }, { label: 'testlib', value: 'testlib' }]" />
      </AdminFormField>
      <AdminFormField v-if="runtime.checker.type === 'testlib'" label="checker 相对路径">
        <UInput v-model="runtime.checker.path" />
      </AdminFormField>
    </div>
    <div class="flex justify-between gap-3">
      <h4 class="font-semibold">子任务与测试点</h4>
      <UButton variant="outline" @click="addSubtask">添加子任务</UButton>
    </div>
    <p
      class="text-xs text-text-muted">输入、答案和 checker 路径相对于题目数据根目录。保存草稿不发布，文件存在性在发布预检中确认。</p>
    <UCard v-for="(task, index) in runtime.subtasks" :key="index">
      <div class="grid gap-3 sm:grid-cols-3">
        <AdminFormField label="子任务标识">
          <UInput v-model="task.id" />
        </AdminFormField>
        <AdminFormField label="子任务分数">
          <UInput v-model.number="task.score" type="number" min="0" />
        </AdminFormField>
        <AdminFormField label="聚合方式">
          <USelect v-model="task.scoring" :items="['min', 'max', 'sum']" />
        </AdminFormField>
      </div>
      <AdminFormField label="前置子任务" class="mt-3">
        <USelectMenu v-model="task.depends_on" multiple
          :items="runtime.subtasks.filter((entry) => entry !== task).map((entry) => entry.id)" />
      </AdminFormField>
      <div v-for="(test, caseIndex) in task.cases" :key="caseIndex"
        class="mt-3 grid items-end gap-2 sm:grid-cols-[1fr_2fr_2fr_auto]">
        <AdminFormField label="测试点标识">
          <UInput v-model="test.id" />
        </AdminFormField>
        <AdminFormField label="输入路径">
          <UInput v-model="test.input" placeholder="testdata/1.in" />
        </AdminFormField>
        <AdminFormField label="答案路径">
          <UInput v-model="test.output" placeholder="testdata/1.out" />
        </AdminFormField>
        <UButton size="sm" color="error" variant="ghost" @click="task.cases.splice(caseIndex, 1)">删除</UButton>
      </div>
      <div class="mt-3 flex gap-3">
        <UButton variant="outline" size="sm" @click="addCase(index)">添加测试点</UButton>
        <UButton color="error" variant="ghost" size="sm" :disabled="runtime.subtasks.length === 1"
          @click="runtime.subtasks.splice(index, 1)">删除子任务</UButton>
      </div>
    </UCard>
  </section>
</template>
