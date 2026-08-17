<script setup lang="ts">
import type { TrainingProblem } from '~/composables/useTrainings'

const props = defineProps<{
  trainingId: string
  problems: TrainingProblem[]
}>()
const emit = defineEmits<{ changed: [] }>()

const { addProblem, removeProblem, reorderProblems } = useTrainings()
const newProblemId = ref('')
const busy = ref(false)

async function add() {
  const problemId = newProblemId.value.trim()
  if (!problemId || busy.value) return
  busy.value = true
  try {
    await addProblem(props.trainingId, problemId)
    newProblemId.value = ''
    emit('changed')
  } finally {
    busy.value = false
  }
}

async function remove(problemId: string) {
  if (busy.value) return
  busy.value = true
  try {
    await removeProblem(props.trainingId, problemId)
    emit('changed')
  } finally {
    busy.value = false
  }
}

async function move(problemId: string, direction: -1 | 1) {
  if (busy.value) return
  const index = props.problems.findIndex((p) => p.problem_id === problemId)
  const target = index + direction
  if (index < 0 || target < 0 || target >= props.problems.length) return
  const next = [...props.problems]
  const [item] = next.splice(index, 1)
  next.splice(target, 0, item)
  busy.value = true
  try {
    await reorderProblems(
      props.trainingId,
      next.map((p, i) => ({ problem_id: p.problem_id, position: i })),
    )
    emit('changed')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="rounded-xl border border-border bg-white p-5">
    <h2 class="mb-4 text-lg font-bold">管理题目</h2>
    <div class="mb-4 flex gap-2">
      <UInput
        v-model="newProblemId"
        placeholder="输入题目 ID 或 display_id"
        class="flex-1"
        :disabled="busy"
      />
      <UButton icon="i-lucide-plus" :loading="busy" @click="add">加入</UButton>
    </div>
    <div class="space-y-2">
      <div
        v-for="(problem, index) in problems"
        :key="problem.problem_id"
        class="flex items-center gap-3 rounded-lg border border-border px-4 py-2"
      >
        <span>{{ index + 1 }}</span>
        <span class="flex-1">{{ problem.display_id }} · {{ problem.title }}</span>
        <UButton
          icon="i-lucide-chevron-up"
          size="xs"
          variant="ghost"
          :disabled="busy || index === 0"
          @click="move(problem.problem_id, -1)"
        />
        <UButton
          icon="i-lucide-chevron-down"
          size="xs"
          variant="ghost"
          :disabled="busy || index === problems.length - 1"
          @click="move(problem.problem_id, 1)"
        />
        <UButton
          icon="i-lucide-trash"
          size="xs"
          color="red"
          variant="ghost"
          :disabled="busy"
          @click="remove(problem.problem_id)"
        />
      </div>
    </div>
  </section>
</template>
