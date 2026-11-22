<script setup lang="ts">
import type { ObjectiveQuestionType, QuestionDraft } from '~/composables/useObjective'

/**
 * 客观题小题编辑表单（在小题列表中原地展开）。
 * 草稿通过 v-model 双向绑定，保存 / 取消由父组件处理（含接口调用与未保存确认）。
 */
const draft = defineModel<QuestionDraft>({ required: true })

defineProps<{
  saving: boolean
}>()

const emit = defineEmits<{
  /** next=true：保存后继续添加下一题 */
  save: [next: boolean]
  cancel: []
}>()

const TYPE_ITEMS: { label: string; value: ObjectiveQuestionType }[] = [
  { label: '单选', value: 'single' },
  { label: '多选', value: 'multiple' },
  { label: '判断', value: 'judge' },
]

const showPreview = ref(true)

function optionKey(index: number): string {
  return String.fromCharCode(65 + index)
}

// 切换题型时旧答案不再适用（单选 ↔ 多选 ↔ 判断），清空避免残留
watch(() => draft.value.type, (next, prev) => {
  if (next === prev) return
  draft.value.answer = []
  if (next !== 'judge' && draft.value.options.length === 0) {
    draft.value.options = [0, 1, 2, 3].map((i) => ({ key: optionKey(i), text: '' }))
  }
})

function addOption() {
  draft.value.options.push({ key: optionKey(draft.value.options.length), text: '' })
}

// 删除后按顺序重排键名（A/B/C…），并同步迁移已勾选的答案
function removeOption(idx: number) {
  const removedKey = draft.value.options[idx]?.key
  const remaining = draft.value.options.filter((_, i) => i !== idx)
  const keyMap = new Map(remaining.map((o, i) => [o.key, optionKey(i)]))
  draft.value.options = remaining.map((o, i) => ({ key: optionKey(i), text: o.text }))
  draft.value.answer = draft.value.answer
    .filter((a) => a !== removedKey)
    .map((a) => (typeof a === 'string' ? keyMap.get(a) ?? a : a))
}

function toggleAnswer(key: string) {
  const d = draft.value
  if (d.type === 'judge') {
    d.answer = [key === 'true']
    return
  }
  if (d.type === 'single') {
    d.answer = [key]
    return
  }
  d.answer = d.answer.includes(key) ? d.answer.filter((a) => a !== key) : [...d.answer, key]
}

function isAnswer(key: string): boolean {
  const d = draft.value
  if (d.type === 'judge') return d.answer.includes(key === 'true')
  // 单选只允许一个答案被勾选
  if (d.type === 'single') return d.answer.length === 1 && d.answer[0] === key
  return d.answer.includes(key)
}
</script>

<template>
  <div
    id="objective-question-editor"
    class="flex flex-col gap-4 rounded-lg border border-primary/40 bg-white p-4 shadow-card"
    @keydown.meta.enter.prevent="emit('save', false)"
    @keydown.ctrl.enter.prevent="emit('save', false)"
  >
    <!-- 题型：分段切换 -->
    <div class="flex flex-wrap items-center gap-3">
      <span class="text-xs font-semibold text-text">题型</span>
      <div class="inline-flex gap-1 rounded-md border border-border p-0.5">
        <UButton
          v-for="t in TYPE_ITEMS"
          :key="t.value"
          size="xs"
          :color="draft.type === t.value ? 'primary' : 'neutral'"
          :variant="draft.type === t.value ? 'solid' : 'ghost'"
          @click="draft.type = t.value"
        >
          {{ t.label }}
        </UButton>
      </div>
      <span class="ml-auto text-11px text-text-muted">支持 Markdown（含表格）与 LaTeX：行内 $...$，独立行 $$...$$</span>
    </div>

    <UFormField label="题干" required>
      <UTextarea
        v-model="draft.prompt"
        class="w-full"
        :rows="3"
        autoresize
        :maxrows="30"
        placeholder="输入题目内容"
      />
    </UFormField>

    <!-- 选项与答案：左侧勾选正确答案 -->
    <UFormField
      v-if="draft.type !== 'judge'"
      :label="draft.type === 'single' ? '选项（勾选唯一正确答案）' : '选项（勾选全部正确答案）'"
      required
    >
      <div class="flex flex-col gap-2">
        <div
          v-for="(opt, i) in draft.options"
          :key="i"
          class="flex items-start gap-2 rounded-md border px-2 py-1.5 transition-colors"
          :class="isAnswer(opt.key) ? 'border-success-text/50 bg-success-text/5' : 'border-transparent'"
        >
          <label class="mt-2 flex shrink-0 cursor-pointer items-center gap-1.5" :title="`将 ${opt.key} 设为正确答案`">
            <input
              :type="draft.type === 'single' ? 'radio' : 'checkbox'"
              :checked="isAnswer(opt.key)"
              class="accent-primary"
              @change="toggleAnswer(opt.key)"
            />
            <span class="w-4 text-sm font-semibold">{{ opt.key }}</span>
          </label>
          <UTextarea
            v-model="opt.text"
            class="min-w-0 flex-1"
            :rows="1"
            autoresize
            :maxrows="12"
            :placeholder="`选项 ${opt.key} 内容`"
          />
          <UButton
            class="mt-0.5"
            color="neutral"
            variant="ghost"
            size="sm"
            icon="i-lucide-x"
            :aria-label="`删除选项 ${opt.key}`"
            @click="removeOption(i)"
          />
        </div>
        <div>
          <UButton size="xs" variant="outline" icon="i-lucide-plus" :disabled="draft.options.length >= 26" @click="addOption">
            添加选项
          </UButton>
        </div>
      </div>
    </UFormField>

    <!-- 判断题答案 -->
    <UFormField v-else label="正确答案" required>
      <div class="flex gap-4">
        <label class="flex cursor-pointer items-center gap-1.5 text-sm">
          <input type="radio" class="accent-primary" :checked="isAnswer('true')" @change="toggleAnswer('true')" />
          正确
        </label>
        <label class="flex cursor-pointer items-center gap-1.5 text-sm">
          <input type="radio" class="accent-primary" :checked="isAnswer('false')" @change="toggleAnswer('false')" />
          错误
        </label>
      </div>
    </UFormField>

    <UFormField label="解析（判卷后展示，可选）">
      <UTextarea
        v-model="draft.explanation"
        class="w-full"
        :rows="2"
        autoresize
        :maxrows="20"
        placeholder="答案解析"
      />
    </UFormField>

    <!-- 实时预览：与答题页一致的渲染效果 -->
    <div class="flex flex-col gap-2">
      <label class="flex w-fit cursor-pointer items-center gap-2 text-xs text-text-secondary">
        <USwitch v-model="showPreview" size="sm" />
        实时预览
      </label>
      <div v-if="showPreview" class="rounded-lg border border-dashed border-border bg-bg-page p-4">
        <ObjectiveRichText v-if="draft.prompt.trim()" class="mb-3" :content="draft.prompt" />
        <p v-else class="mb-3 text-sm text-text-muted">（题干为空）</p>
        <div v-if="draft.type !== 'judge'" class="flex flex-col gap-1.5">
          <div
            v-for="(opt, i) in draft.options"
            :key="i"
            class="flex items-start gap-2 rounded px-2 py-1 text-sm"
            :class="isAnswer(opt.key) ? 'bg-success-text/10' : ''"
          >
            <span class="shrink-0 font-medium">{{ opt.key }}.</span>
            <ObjectiveRichText class="flex-1" :content="opt.text" />
          </div>
        </div>
        <div v-if="draft.explanation.trim()" class="mt-3 border-t border-border pt-2 text-text-secondary">
          <div class="mb-1 text-xs font-medium">解析</div>
          <ObjectiveRichText :content="draft.explanation" />
        </div>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <UButton color="primary" :loading="saving" :disabled="saving" @click="emit('save', false)">保存小题</UButton>
      <UButton
        v-if="draft.id === null"
        color="primary"
        variant="outline"
        :disabled="saving"
        @click="emit('save', true)"
      >
        保存并继续添加
      </UButton>
      <UButton color="neutral" variant="ghost" :disabled="saving" @click="emit('cancel')">取消</UButton>
      <span class="ml-auto text-11px text-text-muted">⌘/Ctrl + Enter 保存</span>
    </div>
  </div>
</template>
