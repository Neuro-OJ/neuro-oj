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
  tags: Tag[]
}

const props = defineProps<Props>()
const emit = defineEmits<{
  'update:keyword': [value: string]
  'update:difficulty': [value: string]
  'update:tagId': [value: string | null]
  'update:problemType': [value: string]
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

const difficulties = [
  { value: '', label: '全部' },
  { value: 'easy', label: '简单' },
  { value: 'medium', label: '中等' },
  { value: 'hard', label: '困难' },
]

const types = [
  { value: 'P', label: '主题库' },
  { value: 'U', label: '用户题库' },
]

function selectDifficulty(value: string) {
  emit('update:difficulty', value === props.difficulty ? '' : value)
}

function selectTag(value: string) {
  emit('update:tagId', value === props.tagId ? null : value)
}

// 标签选项：按 kind 排序（题目标签在前），label 带 kind 前缀区分
const tagItems = computed(() =>
  [...props.tags]
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'problem' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    .map((t) => ({
      label: `${t.kind === 'algorithm' ? '算法标签' : '题目标签'}: ${t.name}`,
      value: t.id,
    })),
)

function selectType(value: string) {
  emit('update:problemType', value === props.problemType ? '' : value)
}

// radio 组方向键导航（WCAG 2.1.1）：左右/上下移动选中项并跟随焦点
function onGroupKeydown(e: KeyboardEvent, values: { value: string }[], current: string, onSelect: (v: string) => void) {
  let idx = values.findIndex((v) => v.value === current)
  if (idx < 0) idx = 0
  if (e.key === "ArrowRight" || e.key === "ArrowDown") idx = Math.min(idx + 1, values.length - 1)
  else if (e.key === "ArrowLeft" || e.key === "ArrowUp") idx = Math.max(idx - 1, 0)
  else return
  e.preventDefault()
  onSelect(values[idx]!.value)
  ;(e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="radio"]')[idx]?.focus()
}

// roving tabindex：当前值不在选项内时默认聚焦第一项（如"全部"）
const activeType = computed(() => types.some((t) => t.value === props.problemType) ? props.problemType : types[0]!.value)
const activeDifficulty = computed(() => difficulties.some((d) => d.value === props.difficulty) ? props.difficulty : difficulties[0]!.value)
</script>

<template>
  <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4 mb-5">
    <!-- 搜索框 -->
    <div class="relative flex-1 max-w-sm">
      <input
        v-model="searchInput"
        type="text"
        placeholder="搜索题目..."
        aria-label="按标题或题号搜索"
        class="w-full px-3 py-2 pr-8 text-sm border border-border rounded-lg bg-white placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-signal/30 focus:border-signal transition-colors duration-150"
      />
      <button
        v-if="searchInput"
        class="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary transition-colors"
        aria-label="清除搜索"
        @click="searchInput = ''"
      >
        <span class="text-sm leading-none">&times;</span>
      </button>
    </div>

    <!-- 类型筛选 -->
    <div class="flex items-center gap-1.5 flex-wrap" role="radiogroup" aria-labelledby="type-label" @keydown="onGroupKeydown($event, types, problemType, selectType)">
      <span class="text-xs text-text-muted mr-1" id="type-label">类型:</span>
      <button
        v-for="t in types"
        :key="t.value"
        role="radio"
        :aria-checked="activeType === t.value"
        :tabindex="activeType === t.value ? 0 : -1"
        class="px-3 py-1.5 text-xs font-medium rounded-full border transition-colors duration-150"
        :class="activeType === t.value
          ? t.value === 'U' ? 'bg-blue-100 text-blue-700 border-blue-300'
            : t.value === 'P' ? 'bg-purple-100 text-purple-700 border-purple-300'
            : 'bg-signal text-on-signal border-signal'
          : 'bg-white text-text-secondary border-border hover:border-signal/40'"
        @click="selectType(t.value)"
      >
        {{ t.label }}
      </button>
    </div>

    <!-- 难度筛选 -->
    <div class="flex items-center gap-1.5 flex-wrap" role="radiogroup" aria-labelledby="diff-label" @keydown="onGroupKeydown($event, difficulties, difficulty, selectDifficulty)">
      <span class="text-xs text-text-muted mr-1" id="diff-label">难度:</span>
      <button
        v-for="d in difficulties"
        :key="d.value"
        role="radio"
        :aria-checked="difficulty === d.value"
        :aria-label="d.label"
        :tabindex="activeDifficulty === d.value ? 0 : -1"
        class="px-3 py-1.5 text-xs font-medium rounded-full border transition-colors duration-150"
        :class="difficulty === d.value
          ? 'bg-signal text-on-signal border-signal'
          : 'bg-white text-text-secondary border-border hover:border-signal/40'"
        @click="selectDifficulty(d.value)"
      >
        {{ d.label }}
      </button>
    </div>

    <!-- 标签筛选 -->
    <div v-if="tags.length > 0" class="flex items-center gap-1.5">
      <span class="text-xs text-text-muted mr-1" id="tag-label">标签:</span>
      <USelect
        :model-value="tagId ?? undefined"
        :items="tagItems"
        size="xs"
        class="min-w-[150px]"
        placeholder="全部标签"
        aria-label="按标签筛选"
        @update:model-value="selectTag"
      />
    </div>
  </div>
</template>
