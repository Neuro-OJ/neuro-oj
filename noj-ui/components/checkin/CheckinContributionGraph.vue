<script setup lang="ts">
import { buildContributionGrid, formatDateFull } from '~/utils/checkinContributions'

/**
 * GitHub 风格签到贡献图。
 * 每周一列（7 行：周日…周六），列从左（一年前）到当前周。
 * 顶部月轴两行：第一行年、第二行月。
 * 界面过长时外层横向滚动；tooltip 显示完整日期。
 */
const props = defineProps<{
  /** 已签到日期（YYYY-MM-DD，升序） */
  days: string[]
  /** 起始展示日（通常为一年前，组件内部会对齐到所在周起点） */
  startDate: string
  /** 今天日期 YYYY-MM-DD */
  today: string
}>()

const grid = computed(() =>
  buildContributionGrid(props.days, props.startDate, props.today),
)

// 横向滚动容器 ref：默认滚动到最右（展示最近的周/当前月）
const scrollRef = ref<HTMLElement | null>(null)
function scrollToLatest() {
  nextTick(() => {
    if (scrollRef.value) {
      scrollRef.value.scrollLeft = scrollRef.value.scrollWidth
    }
  })
}
onMounted(scrollToLatest)
watch(() => grid.value.weeks.length, scrollToLatest)

// 月轴：每周起始月/年（与上一周不同才显示）。
// 年份由第一行 yearLabel 单独展示，第二行月标签只显示月份数字（如 "8"）。
const monthRows = computed(() => grid.value.weeks.map((w) => (w.monthLabel ? String(Number(w.monthLabel.slice(5))) : null)))
const yearRows = computed(() => grid.value.weeks.map((w) => w.yearLabel))

// tooltip：展示具体月份日期 + 星期
const hover = ref<{ cell: { date: string; checked: boolean } | null; x: number; y: number }>({
  cell: null,
  x: 0,
  y: 0,
})

function onHover(e: MouseEvent, cell: { date: string; checked: boolean }) {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  hover.value = { cell, x: rect.left, y: rect.top }
}
function onFocus(e: FocusEvent, cell: { date: string; checked: boolean }) {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  hover.value = { cell, x: rect.left, y: rect.top }
}
function onLeave() {
  hover.value = { cell: null, x: 0, y: 0 }
}
</script>

<template>
  <div ref="scrollRef" class="overflow-x-auto">
    <div class="min-w-max">
      <!-- 月轴两行：第一行年、第二行月（每格宽度与方块列宽一致，保证对齐） -->
      <div class="mb-1 flex h-4">
        <div v-for="(y, i) in yearRows" :key="`y${i}`" class="w-4 shrink-0 overflow-visible text-[9px] leading-4 text-text-muted">
          {{ y }}
        </div>
      </div>
      <div class="mb-1 flex h-4">
        <div v-for="(m, i) in monthRows" :key="`m${i}`" class="w-4 shrink-0 overflow-visible text-[9px] leading-4 text-text-muted">
          {{ m }}
        </div>
      </div>
      <!-- 网格：7 行 × N 列 -->
      <div class="flex">
        <div v-for="(week, wi) in grid.weeks" :key="wi" class="flex flex-col">
          <template v-for="(cell, ci) in week.cells" :key="ci">
            <div
              v-if="cell"
              class="m-[1px] h-3.5 w-3.5 rounded-[3px] outline-none focus-visible:ring-2 focus-visible:ring-signal"
              :class="cell.checked
                ? 'bg-signal'
                : cell.isToday
                  ? 'border border-signal'
                  : 'bg-gray-200'"
              :tabindex="0"
              :aria-label="`${cell.checked ? '已签到' : '未签到'} ${formatDateFull(cell.date)}`"
              @mouseenter="onHover($event, cell)"
              @mouseleave="onLeave"
              @focus="onFocus($event, cell)"
              @blur="onLeave"
              @click="onHover($event, cell)"
            ></div>
          </template>
        </div>
      </div>

      <!-- tooltip -->
      <div
        v-if="hover.cell"
        class="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-[calc(100%+8px)] whitespace-nowrap rounded-md bg-gray-900 px-2 py-1 text-[10px] text-white"
        :style="{ left: hover.x + 'px', top: hover.y + 'px' }"
      >
        {{ hover.cell.checked ? '已签到' : '未签到' }} · {{ formatDateFull(hover.cell.date) }}
      </div>
    </div>
  </div>
</template>
