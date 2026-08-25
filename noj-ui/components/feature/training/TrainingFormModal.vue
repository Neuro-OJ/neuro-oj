<script setup lang="ts">
import type { Training, TrainingPayload } from '~/composables/useTrainings'

const props = defineProps<{
  modelValue: boolean
  /** 传入 training 时进入编辑模式 */
  training?: Training | null
}>()
const emit = defineEmits<{ 'update:modelValue': [boolean]; saved: [] }>()

const { createTraining, updateTraining } = useTrainings()
const title = ref('')
const description = ref('')
const visibility = ref<'private' | 'unlisted' | 'public'>('private')
const saving = ref(false)

const isEdit = computed(() => !!props.training)

// 可见性选项：创建模式仅 private/unlisted（题单规范），编辑已有 public 题单时才提供 public（P2）
const visibilityOptions = computed(() => {
  const options: { label: string; value: 'private' | 'unlisted' | 'public' }[] = [
    { label: '私有', value: 'private' },
    { label: '链接可见', value: 'unlisted' },
  ]
  if (isEdit.value && props.training?.visibility === 'public') {
    options.push({ label: '公开', value: 'public' })
  }
  return options
})

function resetForm() {
  title.value = ''
  description.value = ''
  visibility.value = 'private'
}

watch(
  () => props.training,
  (t) => {
    if (t) {
      title.value = t.title
      description.value = t.description
      visibility.value = t.visibility
    } else {
      // 新建模式：重置为默认值，避免复用上次创建/取消的输入（P2）
      resetForm()
    }
  },
  { immediate: true },
)

// 弹窗关闭时重置，确保下次打开是干净状态（新建组件持续挂载）
watch(
  () => props.modelValue,
  (open) => {
    if (!open) resetForm()
  },
)

async function submit() {
  if (!title.value.trim()) return
  saving.value = true
  try {
    const body: TrainingPayload = {
      title: title.value.trim(),
      description: description.value,
      visibility: visibility.value,
    }
    if (props.training) {
      await updateTraining(props.training.id, body)
    } else {
      await createTraining(body)
    }
    emit('update:modelValue', false)
    emit('saved')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    :open="props.modelValue"
    :title="isEdit ? '编辑题单' : '新建题单'"
    :unmount-on-hide="true"
    @update:open="emit('update:modelValue', $event)"
  >
    <template #body>
      <UForm :state="{ title, description, visibility }" class="space-y-4" @submit="submit">
        <UFormField label="标题" required>
          <UInput v-model="title" placeholder="题单标题" />
        </UFormField>
        <UFormField label="简介">
          <UTextarea v-model="description" placeholder="题单简介" />
        </UFormField>
        <UFormField label="可见性">
          <USelect
            v-model="visibility"
            :items="visibilityOptions"
          />
        </UFormField>
        <div class="flex justify-end gap-3">
          <UButton color="gray" @click="emit('update:modelValue', false)">取消</UButton>
          <UButton type="submit" :loading="saving">{{ isEdit ? '保存' : '创建' }}</UButton>
        </div>
      </UForm>
    </template>
  </UModal>
</template>
