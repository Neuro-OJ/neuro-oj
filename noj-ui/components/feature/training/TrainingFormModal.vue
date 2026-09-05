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

watch(
  () => props.training,
  (t) => {
    if (!t) return
    title.value = t.title
    description.value = t.description
    visibility.value = t.visibility
  },
  { immediate: true },
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
            :items="[
              { label: '私有', value: 'private' },
              { label: '链接可见', value: 'unlisted' },
              { label: '公开', value: 'public' },
            ]"
          />
        </UFormField>
        <div class="flex justify-end gap-3">
          <UButton color="neutral" @click="emit('update:modelValue', false)">取消</UButton>
          <UButton type="submit" :loading="saving">{{ isEdit ? '保存' : '创建' }}</UButton>
        </div>
      </UForm>
    </template>
  </UModal>
</template>
