<script setup lang="ts">
/**
 * 首页轮播（slides 驱动，与公告解耦，2026-09-24）。
 *
 * - `kind=image` 渲染图片，`kind=text` 渲染渐变 + 文案。
 * - `link_url` 为空则整卡不可点。
 * - 保留暂停/继续（WCAG 2.2.2）与圆点导航；无 slide 时显示默认欢迎占位。
 */

import { useCarousel, type CarouselSlide } from '~/composables/useCarousel';
import { DEFAULT_GRADIENT, gradientClass } from '~/utils/carouselGradient';

const props = withDefaults(defineProps<{ autoIntervalMs?: number }>(), {
  autoIntervalMs: 5000,
});

const { loadEnabled } = useCarousel();
const slides = ref<CarouselSlide[]>([]);
const currentSlide = ref(0);
const paused = ref(false);
let autoTimer: ReturnType<typeof setInterval> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

const current = computed(() => slides.value[currentSlide.value]);

function startAuto() {
  if (paused.value || slides.value.length <= 1) return;
  stopAuto();
  autoTimer = setInterval(() => {
    currentSlide.value = (currentSlide.value + 1) % slides.value.length;
  }, props.autoIntervalMs);
}

function stopAuto() {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
  }
}

function togglePause() {
  paused.value = !paused.value;
  if (paused.value) stopAuto();
  else startAuto();
}

function goToSlide(i: number) {
  if (i === currentSlide.value) return;
  currentSlide.value = i;
  stopAuto();
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(startAuto, 60000);
}

async function load() {
  try {
    slides.value = await loadEnabled(true);
    if (currentSlide.value >= slides.value.length) currentSlide.value = 0;
    startAuto();
  } catch {
    // silent：保持空态占位
  }
}

onMounted(load);
onUnmounted(() => {
  stopAuto();
  if (idleTimer) clearTimeout(idleTimer);
});
</script>

<template>
  <div
    class="flex-1 min-w-0 relative overflow-hidden min-h-[320px]"
    role="region"
    aria-roledescription="轮播图"
    aria-label="首页轮播"
    aria-live="off"
    @mouseenter="stopAuto"
    @mouseleave="() => { if (!paused) startAuto() }"
  >
    <Transition name="carousel-fade">
      <div
        v-if="current"
        :key="currentSlide"
        class="absolute inset-0 p-8 lg:p-12 flex flex-col justify-center text-text"
        :class="current.kind === 'image' ? 'bg-black/5' : `bg-gradient-to-br ${gradientClass(current.gradient_key)}`"
      >
        <!-- 图片型：铺满背景（经公开图片端点读取，noj-storage:// 不能直接作 src） -->
        <img
          v-if="current.kind === 'image' && current.image_storage_url"
          :src="`/api/v1/carousel/slides/${current.id}/image`"
          :alt="current.title ?? '轮播图'"
          class="absolute inset-0 size-full object-cover"
        />
        <div class="relative z-[6] max-w-[480px]">
          <h2
            v-if="current.title"
            class="text-2xl lg:text-3xl font-bold mb-3 animate-[slideInUp_0.6s_cubic-bezier(0.16,1,0.3,1)_both]"
          >{{ current.title }}</h2>
          <p
            v-if="current.subtitle"
            class="text-sm lg:text-base text-text-secondary leading-relaxed animate-[slideInUp_0.6s_cubic-bezier(0.16,1,0.3,1)_150ms_both]"
          >{{ current.subtitle }}</p>
        </div>
        <!-- link_url 为空则整卡不可点 -->
        <NuxtLink
          v-if="current.link_url"
          :to="current.link_url"
          class="absolute inset-0 z-[5]"
          :aria-label="current.title ? `查看：${current.title}` : '查看轮播内容'"
        />
        <span
          v-if="current.link_url"
          class="relative z-[6] mt-4 inline-flex items-center gap-1 text-sm font-medium text-signal-deep pointer-events-none animate-[slideInUp_0.6s_cubic-bezier(0.16,1,0.3,1)_300ms_both]"
        >
          查看详情
          <UIcon name="i-lucide-arrow-right" class="size-4" />
        </span>
      </div>

      <!-- 空态：无启用 slide 时显示默认欢迎占位 -->
      <div
        v-else
        class="absolute inset-0 p-8 lg:p-12 flex flex-col justify-center text-text"
        :class="`bg-gradient-to-br ${DEFAULT_GRADIENT}`"
      >
        <h2 class="text-2xl lg:text-3xl font-bold mb-3 animate-[slideInUp_0.6s_cubic-bezier(0.16,1,0.3,1)_both]">Neuro OJ 正式上线</h2>
        <p class="text-sm lg:text-base text-text-secondary max-w-[480px] leading-relaxed animate-[slideInUp_0.6s_cubic-bezier(0.16,1,0.3,1)_150ms_both]">面向 AI 领域认证与竞赛的在线评测平台现已开放注册，提供代码评测、LLM 工程题与类 Kaggle 产物提交评测。</p>
      </div>
    </Transition>

    <!-- 暂停/继续（WCAG 2.2.2 自动更新内容可暂停） -->
    <button
      v-if="!paused && slides.length > 1"
      type="button"
      class="absolute bottom-4 right-4 z-10 p-2 flex items-center justify-center rounded-full bg-black/10 text-text hover:bg-black/20 transition-colors"
      aria-label="暂停轮播"
      @click="togglePause"
    >
      <UIcon name="i-lucide-pause" class="size-4" />
    </button>
    <button
      v-else-if="slides.length > 1"
      type="button"
      class="absolute bottom-4 right-4 z-10 p-2 flex items-center justify-center rounded-full bg-black/20 text-text hover:bg-black/30 transition-colors"
      aria-label="继续轮播"
      @click="togglePause"
    >
      <UIcon name="i-lucide-play" class="size-4" />
    </button>

    <div
      v-if="slides.length > 1"
      class="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1.5 z-10"
    >
      <button
        v-for="(_, i) in slides"
        :key="i"
        class="p-2 -m-2 rounded-full transition-opacity cursor-pointer group"
        :aria-label="`切换到第 ${i + 1} 张`"
        :aria-current="i === currentSlide"
        @click="goToSlide(i)"
      >
        <span
          class="block size-2 rounded-full transition-all duration-300 bg-text"
          :class="i === currentSlide ? 'opacity-100 scale-125' : 'opacity-40 group-hover:opacity-80'"
        />
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 轮播淡入淡出（Transition name="carousel-fade"）与内容入场动画。
   scoped 样式不穿透子组件，故必须定义在本组件内（原定义留在 index.vue 已成死代码）。 */
.carousel-fade-enter-active,
.carousel-fade-leave-active {
    transition: opacity 700ms ease-in-out;
}

.carousel-fade-enter-from,
.carousel-fade-leave-to {
    opacity: 0;
}

@keyframes slideInUp {
    from {
        opacity: 0;
        transform: translateY(20px);
    }
    to {
        opacity: 1;
        transform: translateY(0);
    }
}
</style>
