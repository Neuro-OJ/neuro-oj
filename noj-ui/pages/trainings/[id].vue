<script setup lang="ts">
import type { Training, TrainingProblem } from '~/composables/useTrainings'
import { useTrainings } from '~/composables/useTrainings'

const route = useRoute()
const router = useRouter()
const trainingId = route.params.id as string
const { user } = useAuth()
const { deleteTraining } = useTrainings()
const { dialog } = useDialog()
const { toast } = useToast()

const { data: trainingData, pending, error, refresh } = await useFetch<{ data: Training }>(
  `/api/v1/trainings/${trainingId}`,
  { silent: true },
)
const { data: problemsData, refresh: refreshProblems } = await useFetch<{ data: TrainingProblem[] }>(
  `/api/v1/trainings/${trainingId}/problems`,
  { silent: true },
)
const training = computed(() => trainingData.value?.data)
const problems = computed(() => problemsData.value?.data ?? [])
const isOwner = computed(() => training.value?.created_by === user.value?.id)
const showEdit = ref(false)

// issue #311：题单缺少删除入口，补上带二次确认的删除按钮
async function handleDeleteTraining() {
  const ok = await dialog.confirm(
    '确定删除该题单？删除后题目关联也会一并清除，且无法恢复。',
    { title: '删除题单', confirmText: '删除', danger: true },
  )
  if (!ok) return
  try {
    await deleteTraining(trainingId)
    toast.success('题单已删除')
    router.push('/trainings')
  } catch {
    // useApi 已弹错误
  }
}
</script>

<template>
  <div class="min-h-full bg-bg-page py-10">
    <div class="mx-auto max-w-[960px] space-y-7 px-4 sm:px-7">
      <AsyncContent
        :status="pending ? 'loading' : error ? 'error' : 'data'"
        error="题单加载失败"
        @retry="refresh"
      >
        <section class="rounded-2xl bg-bg-dark px-8 py-8 text-white shadow-card">
          <div class="flex items-center gap-3">
            <h1 class="text-3xl font-bold">{{ training?.title }}</h1>
            <span
              v-if="training?.visibility === 'private'"
              class="rounded-full bg-white/10 px-3 py-1 text-xs"
            >私有</span>
            <span
              v-else-if="training?.visibility === 'unlisted'"
              class="rounded-full bg-white/10 px-3 py-1 text-xs"
            >链接可见</span>
            <span v-else class="rounded-full bg-white/10 px-3 py-1 text-xs">公开</span>
            <UButton
              v-if="isOwner"
              icon="i-lucide-pencil"
              size="xs"
              color="white"
              variant="ghost"
              class="ml-auto text-white/80 hover:text-white"
              @click="showEdit = true"
            >
              编辑
            </UButton>
            <UButton
              v-if="isOwner"
              icon="i-lucide-trash-2"
              size="xs"
              color="red"
              variant="ghost"
              class="text-white/80 hover:text-white"
              @click="handleDeleteTraining"
            >
              删除
            </UButton>
          </div>
          <p class="mt-4 whitespace-pre-line text-sm leading-6 text-slate-300">
            {{ training?.description }}
          </p>
        </section>

        <TrainingProblemList :problems="problems" />

        <TrainingProblemManager
          v-if="isOwner"
          :training-id="trainingId"
          :problems="problems"
          @changed="refreshProblems"
        />

        <TrainingFormModal
          v-if="isOwner"
          v-model="showEdit"
          :training="training"
          @saved="refresh"
        />
      </AsyncContent>
    </div>
  </div>
</template>
