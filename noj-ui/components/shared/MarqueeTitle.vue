<template>
    <div
        ref="containerRef"
        class="marquee-container overflow-hidden min-w-0 w-full"
        :style="containerStyle"
    >
        <div
            ref="trackRef"
            class="flex whitespace-nowrap will-change-transform"
            :class="$attrs.class"
            :style="trackStyle"
        >
            <span :class="textClass">{{ text }}</span>
            <span
                v-if="isOverflowing"
                :class="textClass"
                aria-hidden="true"
            >{{ text }}</span>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, getCurrentInstance, nextTick, onMounted, onUnmounted, ref, watch } from "vue"

interface Props {
    /** 要显示的文本 */
    text: string
    /**
     * 开头停顿秒数。
     * 不传时按"可见字符数 × 0.1s"自动计算（足够用户看清初始显示的内容，下限 0.3s）；
     * 传 `0` 立即开始滚动；传具体秒数则覆盖默认值。
     */
    pauseSeconds?: number
    /**
     * 第一份尾部和第二份开头之间的空白宽度。
     * - 数字：像素（px）
     * - 字符串以 '%' 结尾：JS 计算为容器宽度的百分比（如 '50%' = 容器宽度的一半）
     * 默认 '50%'
     */
    gap?: number | string
    /**
     * 每字滚动秒数（值越大滚得越慢）。
     * 默认 0.15——配合 Wt+G 新位移，匀速速度约为修复位移前的 1.78 倍。
     * 觉得不够快可调到 0.1（~2.7 倍）或更低；想慢可调到 0.3 或更高。
     */
    scrollCharSeconds?: number
    /** 应用到 marquee-item（文本 span）的类名，用于颜色、字号等 */
    textClass?: string
}

const props = withDefaults(defineProps<Props>(), {
    gap: "50%",
    scrollCharSeconds: 0.15,
    textClass: "",
})

defineOptions({ inheritAttrs: false })

const containerRef = ref<HTMLElement | null>(null)

/** 段缘淡化遮罩：仅右侧 8% 渐变到透明（暗示"还有更多"），左侧完全显示。 */
const maskStyle = {
    'mask-image': 'linear-gradient(to right, black 0%, black 92%, transparent 100%)',
    '-webkit-mask-image': 'linear-gradient(to right, black 0%, black 92%, transparent 100%)',
}

/**
 * 容器 style：仅在文本溢出滚动时启用 mask 渐变。
 * 不溢出时文字完整显示在容器内，无需遮罩。
 */
const containerStyle = computed(() =>
    isOverflowing.value ? maskStyle : undefined,
)
const trackRef = ref<HTMLElement | null>(null)
const isOverflowing = ref(false)
const containerWidth = ref(0)
const trackWidth = ref(0)
/**
 * 是否已完成首次测量。
 * SSR / 测量前 visibleChars 等指标无效，用以回退到保守默认值，避免水合不匹配。
 */
const measured = ref(false)
let resizeObserver: ResizeObserver | null = null

/** 基于 Vue 实例 uid 的 keyframes id——确保每个组件实例独立，避免冲突。 */
const marqueeKeyframesId = `marquee-${getCurrentInstance()?.uid ?? 0}`

/** 滚动时长：按字数线性计算，夹紧到 [3s, 22s]。下限 3s 防止短文本瞬间消失。 */
const scrollSeconds = computed(() =>
    Math.min(
        Math.max(props.text.length * props.scrollCharSeconds, 3),
        22,
    )
)

/**
 * 可见字符数估算：
 * - 不溢出：text 全部可见 = text.length
 * - 溢出：按"容器宽度 / 单份 text 宽度"比例缩放 text.length
 *   （单份宽度 Wt = (scrollWidth - gapPx) / 2）
 */
const visibleChars = computed(() => {
    if (!measured.value) return 0
    if (!isOverflowing.value) return props.text.length
    const wt = (trackWidth.value - gapPx.value) / 2
    if (wt <= 0 || containerWidth.value <= 0) return props.text.length
    return Math.max(1, Math.round(props.text.length * containerWidth.value / wt))
})

/**
 * 实际停顿秒数。
 * - props.pauseSeconds 显式传入：直接使用
 * - 未传：visibleChars × 0.1s（下限 0.3s）
 * - SSR / 测量前：1s 保守值
 */
const effectivePauseSeconds = computed(() => {
    if (props.pauseSeconds !== undefined) return props.pauseSeconds
    if (!measured.value) return 1
    return Math.max(2, visibleChars.value * 0.15)
})

/** 总动画时长 = 开头停顿 + 滚动（末尾不停顿，100% 跳回 0% 循环）。 */
const totalSeconds = computed(() => effectivePauseSeconds.value + scrollSeconds.value)
const marqueeDuration = computed(() => `${totalSeconds.value}s`)

/** 滚动开始百分比（停顿结束后开始滚动的位置）。 */
const scrollStartPct = computed(() =>
    (effectivePauseSeconds.value / totalSeconds.value) * 100
)

/**
 * 将 gap prop 转换为稳定 px 值（避免 CSS 百分比在 inline-flex 容器中的循环依赖）。
 *
 * - 数字 → 直接 px
 * - 字符串以 '%' 结尾 → JS 计算为容器宽度的百分比（'50%' = W / 2）
 */
const gapPx = computed(() => {
    const g = props.gap
    if (typeof g === "number") return g
    if (typeof g === "string" && g.endsWith("%")) {
        const pct = parseFloat(g)
        if (!isNaN(pct) && containerWidth.value > 0) {
            return (containerWidth.value * pct) / 100
        }
    }
    return 0
})

/**
 * track 的 inline style。
 *
 * 必须用 inline style 而非 Tailwind 类名（`gap-[${px}px]` 是动态值，
 * JIT 静态扫描无法识别，类名挂上 DOM 也不会生成对应 CSS 规则）。
 */
const trackStyle = computed(() => {
    const base: Record<string, string> = { gap: `${gapPx.value}px` }
    if (!isOverflowing.value) return base
    return {
        ...base,
        animationName: marqueeKeyframesId,
        animationDuration: marqueeDuration.value,
        animationIterationCount: 'infinite',
    }
})

/** 测量容器宽度和 track 宽度。 */
function measure() {
    if (containerRef.value) {
        containerWidth.value = containerRef.value.clientWidth
    }
    if (trackRef.value) {
        trackWidth.value = trackRef.value.scrollWidth
    }
}

function checkOverflow() {
    if (!containerRef.value) return
    isOverflowing.value = containerRef.value.scrollWidth > containerRef.value.clientWidth
}

/** 首次测量 + overflow 检查（onMounted / ResizeObserver 共用） */
function measureAll() {
    measure()
    checkOverflow()
    measured.value = true
}

/**
 * 动态生成 keyframes。
 *
 * 位移幅度 = -(Wt + gap)——使 100% 时第二份恰好对齐窗口左边缘 [0, Wt]，
 * 与 0% 时的第一份完全重合，循环跳变无视觉差异。
 *
 * 其中 Wt = 一份 text 的宽度 = (track.scrollWidth - gapPx) / 2
 *   （track 是 inline-flex，包含两份 text + 一个 gap：scrollWidth = 2*Wt + gapPx）
 *
 * 几何分析（Wt = 400px，gap = 200px，容器 W = 任意）：
 * - 0% 时：窗口 [0, W] 显示第一份内容 [0, W]（Wt > W 时为 text 前 W）
 * - 100% 时（translateX(-(Wt+gap)) = -600px）：
 *   - 第一份 [-(Wt+gap), -gap] = [-600, -200]（完全在窗口外）
 *   - gap [-gap, 0] = [-200, 0]（窗口外，刚到边）
 *   - 第二份 [0, Wt] = [0, 400]（窗口内左对齐，x=0 处即第二份开头）
 * - 100% → 0% 跳变：第二份 [0, W] 替换为第一份 [0, W]，内容完全相同 → 无缝
 *
 * ⚠️ 不能用 `-(containerWidth + gapPx)`——容器宽度 W 不等于一份 text 的宽度 Wt，
 *    会导致 100% 时第二份左边缘 ≠ 0，跳回 0% 时窗口内 x=0 处出现空白或内容突变。
 */
const marqueeKeyframesCSS = computed(() => {
    const tx = isOverflowing.value
        ? -(trackWidth.value + gapPx.value) / 2
        : 0
    if (!isOverflowing.value) {
        return `@keyframes ${marqueeKeyframesId} {
            0%, 100% { transform: translateX(0); }
        }`
    }
    /**
     * 滚动阶段内部时序分配（总动画 = 停顿 + 滚动）：
     * - 加速 [scrollStartPct, easeInEnd]：温和 ease-in（前后段斜率不极端，避免"突然"感）
     * - 匀速 [easeInEnd, easeOutStart]
     * - 减速 [easeOutStart, 100%]：温和 ease-out（前后段斜率不极端，避免"拖尾"感）
     *
     * 比例 20 / 60 / 20 是滚动阶段的时长比例（匀速段占主导，加减速段短而平）。
     */
    const pctStart = scrollStartPct.value
    const range = 100 - pctStart
    const easeInEnd = pctStart + range * 0.20
    const easeOutStart = pctStart + range * 0.80
    return `@keyframes ${marqueeKeyframesId} {
        0% {
            transform: translateX(0);
            animation-timing-function: linear;
        }
        ${pctStart.toFixed(2)}% {
            transform: translateX(0);
            animation-timing-function: cubic-bezier(0.42, 0, 1, 1);
        }
        ${easeInEnd.toFixed(2)}% {
            transform: translateX(${(tx * 0.10).toFixed(2)}px);
            animation-timing-function: linear;
        }
        ${easeOutStart.toFixed(2)}% {
            transform: translateX(${(tx * 0.90).toFixed(2)}px);
            animation-timing-function: cubic-bezier(0, 0, 0.58, 1);
        }
        100% { transform: translateX(${tx}px); }
    }`
})

function syncKeyframes() {
    if (typeof document === "undefined") return
    const css = marqueeKeyframesCSS.value
    let style = document.getElementById(marqueeKeyframesId)
    if (!style) {
        style = document.createElement("style")
        style.id = marqueeKeyframesId
        document.head.appendChild(style)
    }
    style.textContent = css
}

function removeKeyframes() {
    if (typeof document === "undefined") return
    document.getElementById(marqueeKeyframesId)?.remove()
}

watch(marqueeKeyframesCSS, syncKeyframes)

onMounted(() => {
    nextTick(() => {
        measureAll()
        syncKeyframes()
        if (typeof ResizeObserver !== "undefined" && containerRef.value) {
            resizeObserver = new ResizeObserver(() => {
                measureAll()
                syncKeyframes()
            })
            resizeObserver.observe(containerRef.value)
        }
    })
})

onUnmounted(() => {
    resizeObserver?.disconnect()
    removeKeyframes()
})
</script>

<style scoped>
</style>