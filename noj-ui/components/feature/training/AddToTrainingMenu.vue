<script setup lang="ts">
import type { Training } from '~/composables/useTrainings'

const props = defineProps<{ problemId: string }>()

const { listMine, listContainingProblem, addProblem, removeProblem, createTraining } = useTrainings()
const open = ref(false)
const selected = ref<string[]>([])
/** 弹窗打开时已含该题的题单（用于对比：取消勾选 → 从题单删除） */
const initiallyContaining = ref<string[]>([])
const saving = ref(false)
const showCreate = ref(false)
const newTitle = ref('')

async function load() {
  const res = await listMine({ page: 1, per_page: 100 }, { silent: true })
  return res.data
}

const mineTrainings = ref<Training[]>([])

async function openModal() {
  mineTrainings.value = await load()
  // 预勾选：查当前用户哪些题单已含该题
  const containing = await listContainingProblem(props.problemId, { silent: true })
  initiallyContaining.value = containing.data
  selected.value = [...containing.data]
  showCreate.value = false
  newTitle.value = ''
  open.value = true
}

function closeModal() {
  open.value = false
  selected.value = []
  initiallyContaining.value = []
  showCreate.value = false
  newTitle.value = ''
}

async function save() {
  if (saving.value) return
  saving.value = true
  try {
    const selectedSet = new Set(selected.value)
    const initialSet = new Set(initiallyContaining.value)
    // 新增勾选 → 加入
    for (const trainingId of selected.value) {
      if (!initialSet.has(trainingId)) {
        await addProblem(trainingId, props.problemId)
      }
    }
    // 取消勾选（原本已含但不再选中）→ 从题单删除
    for (const trainingId of initiallyContaining.value) {
      if (!selectedSet.has(trainingId)) {
        await removeProblem(trainingId, props.problemId)
      }
    }
    closeModal()
  } finally {
    saving.value = false
  }
}

async function createAndAdd() {
  const title = newTitle.value.trim()
  if (!title || saving.value) return
  saving.value = true
  try {
    const created = await createTraining({ title, visibility: 'private' })
    await addProblem(created.data.id, props.problemId)
    closeModal()
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div>
    <UButton icon="i-lucide-list-plus" @click="openModal">加入题单</UButton>

    <UModal
      v-model:open="open"
      title="加入题单"
      :unmount-on-hide="true"
      @after:leave="closeModal"
    >
      <template #body>
        <div class="space-y-3 p-4">
        <div class="space-y-2">
          <!-- issue #311：必须用 UCheckboxGroup 才能让 v-model 作为多选数组，
               单独使用 UCheckbox v-model="selected" 会被 Reka 当成布尔值切换，
               导致“选择一个题单后全部勾选/按钮状态异常”。 -->
          <UCheckboxGroup
            v-model="selected"
            :items="mineTrainings.map((t) => ({ label: t.title, value: t.id }))"
          />
          <p v-if="mineTrainings.length === 0" class="text-sm text-text-secondary">
            你还没有题单，可以新建一个。
          </p>
        </div>

        <div v-if="showCreate" class="flex gap-2">
          <UInput v-model="newTitle" placeholder="新题单标题" class="flex-1" />
          <UButton size="sm" :loading="saving" @click="createAndAdd">新建并加入</UButton>
        </div>
        <UButton
          v-else
          size="xs"
          variant="ghost"
          @click="showCreate = true"
        >
          新建题单
        </UButton>

        <div class="flex justify-end gap-3 pt-2">
          <UButton color="gray" @click="closeModal">取消</UButton>
          <UButton color="primary" :loading="saving" :disabled="selected.length === 0" @click="save">
            加入选中题单
          </UButton>
        </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
