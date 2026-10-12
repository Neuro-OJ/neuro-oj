<script setup lang="ts">
interface Tag {
  id: string
  name: string
  kind: 'problem' | 'algorithm'
}

interface Props {
  keyword: string
  difficulty: string
  tagId: string | null
  problemType: string
  judgeType?: string
  judgeBackend?: string
  tags: Tag[]
}

const props = defineProps<Props>()
const emit = defineEmits<{
  'update:keyword': [value: string]
  'update:difficulty': [value: string]
  'update:tagId': [value: string | null]
  'update:problemType': [value: string]
  'update:judgeType': [value: string]
  'update:judgeBackend': [value: string]
  reset: []
}>()

const searchInput = ref(props.keyword)
let debounceTimer: ReturnType<typeof setTimeout> | undefined

watch(searchInput, (val) => {
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    emit('update:keyword', val)
  }, 300)
})

watch(() => props.keyword, (val) => {
  if (val !== searchInput.value) {
    clearTimeout(debounceTimer)
    searchInput.value = val
  }
})

onUnmounted(() => {
  clearTimeout(debounceTimer)
})

const allFilterValue = '__all__'

function filterValue(value: string | undefined): string {
  return value === allFilterValue ? '' : value ?? ''
}

const difficulties = [
  { value: allFilterValue, label: '全部' },
  { value: 'easy', label: '简单' },
  { value: 'medium', label: '中等' },
  { value: 'hard', label: '困难' },
]

const types = [
  { value: 'P', label: '主题库' },
  { value: 'U', label: '用户题库' },
]
const judgeTypes = [
  { value: allFilterValue, label: '全部' },
  { value: 'oi', label: 'OI 题' },
  { value: 'dual', label: 'AI 题' },
  { value: 'objective', label: '客观题' },
]
const judgeBackends = [
  { value: allFilterValue, label: '全部' },
  { value: 'dual', label: 'dual' },
  { value: 'oi-native', label: 'oi-native' },
  { value: 'oi-wasm', label: 'oi-wasm' },
]

// 标签选项：按 kind 排序（题目标签在前），label 带 kind 前缀区分
const tagItems = computed(() =>
  [
    { label: '全部标签', value: allFilterValue },
    ...[...props.tags]
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'problem' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      .map((t) => ({
        label: `${t.kind === 'algorithm' ? '算法标签' : '题目标签'}: ${t.name}`,
        value: t.id,
      })),
  ],
)

</script>

<template>
  <UCard class="mb-5 rounded-md shadow-none" :ui="{ body: 'p-4 sm:p-4' }" aria-label="题库筛选">
    <div class="flex items-center gap-3">
      <UInput v-model="searchInput" icon="i-lucide-search" type="search" size="md"
        placeholder="搜索题目名称或题号" aria-label="按标题或题号搜索" class="min-w-0 flex-1" />
      <UButton color="neutral" variant="ghost" size="sm" icon="i-lucide-filter-x" class="shrink-0" @click="emit('reset')">清空筛选</UButton>
    </div>
    <div class="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <UFormField label="题库" class="min-w-0">
        <USelect :model-value="problemType || 'P'" :items="types" size="sm" class="w-full" aria-label="题库"
          @update:model-value="emit('update:problemType', $event)" />
      </UFormField>
      <UFormField label="难度" class="min-w-0">
        <USelect :model-value="difficulty || allFilterValue" :items="difficulties" size="sm" class="w-full" aria-label="难度"
          @update:model-value="emit('update:difficulty', filterValue($event))" />
      </UFormField>
      <UFormField label="题目类型" class="min-w-0">
        <USelect :model-value="judgeType || allFilterValue" :items="judgeTypes" size="sm" class="w-full" aria-label="题目类型"
          @update:model-value="emit('update:judgeType', filterValue($event))" />
      </UFormField>
      <UFormField label="评测后端" class="min-w-0">
        <USelect :model-value="judgeBackend || allFilterValue" :items="judgeBackends" size="sm" class="w-full" aria-label="评测后端"
          @update:model-value="emit('update:judgeBackend', filterValue($event))" />
      </UFormField>
      <UFormField label="标签" class="min-w-0">
        <USelect :model-value="tagId || allFilterValue" :items="tagItems" size="sm" class="w-full" aria-label="标签"
          @update:model-value="emit('update:tagId', filterValue($event) || null)" />
      </UFormField>
    </div>
  </UCard>
</template>
