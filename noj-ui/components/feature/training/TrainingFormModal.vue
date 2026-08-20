<script setup lang="ts">
import type { TrainingPayload } from '~/composables/useTrainings'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [boolean]; saved: [] }>()

const { createTraining } = useTrainings()
const title = ref('')
const description = ref('')
const visibility = ref<'private' | 'unlisted'>('private')
const saving = ref(false)

async function submit() {
  if (!title.value.trim()) return
  saving.value = true
  try {
    const body: TrainingPayload = {
      title: title.value.trim(),
      description: description.value,
      visibility: visibility.value,
    }
    await createTraining(body)
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
    title="新建题单"
    :unmount-on-hide="true"
    @update:open="emit('update:modelValue', $event)"
  >
    <UForm :state="{ title, description, visibility }" class="space-y-4" @submit="submit">
      <UFormGroup label="标题" required>
        <UInput v-model="title" placeholder="题单标题" />
      </UFormGroup>
      <UFormGroup label="简介">
        <UTextarea v-model="description" placeholder="题单简介" />
      </UFormGroup>
      <UFormGroup label="可见性">
        <USelect
          v-model="visibility"
          :items="[
            { label: '私有', value: 'private' },
            { label: '链接可见', value: 'unlisted' },
          ]"
        />
      </UFormGroup>
      <div class="flex justify-end gap-3">
        <UButton color="gray" @click="emit('update:modelValue', false)">取消</UButton>
        <UButton type="submit" :loading="saving">创建</UButton>
      </div>
    </UForm>
  </UModal>
</template>
