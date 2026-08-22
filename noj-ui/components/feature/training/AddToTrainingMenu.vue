<script setup lang="ts">
import type { Training } from '~/composables/useTrainings'

const props = defineProps<{ problemId: string }>()

const { listMine, addProblem, createTraining } = useTrainings()
const open = ref(false)
const selected = ref<string[]>([])
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
  selected.value = []
  showCreate.value = false
  newTitle.value = ''
  open.value = true
}

function closeModal() {
  open.value = false
  selected.value = []
  showCreate.value = false
  newTitle.value = ''
}

async function save() {
  if (saving.value) return
  saving.value = true
  try {
    for (const trainingId of selected.value) {
      await addProblem(trainingId, props.problemId)
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
          <label
            v-for="training in mineTrainings"
            :key="training.id"
            class="flex items-center gap-2 text-sm"
          >
            <UCheckbox v-model="selected" :value="training.id" />
            {{ training.title }}
          </label>
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
