<script setup lang="ts">
const props = defineProps<{
  initialCheckIn?: { checked_in: boolean; streak: number };
}>();
const { user, isLoggedIn } = useAuth();
const { api } = useApi();

// 轮播与公告已解耦：轮播见 components/feature/Carousel.vue，
// 常驻公告区块见 components/feature/AnnouncementSection.vue。

// ── Check-in ──
const checkedIn = ref(props.initialCheckIn?.checked_in ?? false);
const fadeWhite = ref(false);
const showText = ref(false);
const streakCount = ref(props.initialCheckIn?.streak ?? 0);
const showStreak = ref(false);
const checkInLoading = ref(false);
const checkInLoaded = ref(props.initialCheckIn !== undefined);

// 签到动画时序（加载恢复 vs 手动签到，两套不同节奏）
const RESTORE_ANIM_DELAYS = { anim: 600, white: 200, text: 400, streak: 700 };
const CHECKIN_ANIM_DELAYS = { anim: 600, white: 1500, text: 2200, streak: 2500 };

function playCheckInAnim(delays: {
  anim: number;
  white: number;
  text: number;
  streak: number;
}) {
  setTimeout(() => {
    fadeWhite.value = true;
  }, delays.white);
  setTimeout(() => {
    showText.value = true;
  }, delays.text);
  setTimeout(() => {
    showStreak.value = true;
  }, delays.streak);
}

async function fetchTodayCheckIn() {
  if (!isLoggedIn.value || props.initialCheckIn !== undefined) return;
  try {
    const res = await api.get<{ data: { checked_in: boolean; streak: number } }>(
      '/api/v1/checkin/today',
      { silent: true, redirectOnUnauthorized: false },
    );
    if (res.data) {
      checkedIn.value = res.data.checked_in;
      streakCount.value = res.data.streak;
      if (res.data.checked_in) {
        playCheckInAnim(RESTORE_ANIM_DELAYS);
      }
    }
  } catch {
    // silent
  } finally {
    checkInLoaded.value = true;
  }
}

async function handleCheckIn() {
  if (checkInLoading.value || checkedIn.value) return;
  checkInLoading.value = true;
  try {
    const res = await api.post<{ data: { checked_in: boolean; streak: number } }>(
      '/api/v1/checkin',
    );
    if (res.data) {
      checkedIn.value = res.data.checked_in;
      streakCount.value = res.data.streak;
      playCheckInAnim(CHECKIN_ANIM_DELAYS);
    }
  } catch {
    // silent
  } finally {
    checkInLoading.value = false;
  }
}

const d = new Date();
const todayDateStr = d.toLocaleDateString('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
}) + ' ' + d.toLocaleDateString('zh-CN', { weekday: 'long' });

const now = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | null = null;

const todayTimeStr = computed(() =>
  new Date(now.value).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
);

onMounted(() => {
  clockTimer = setInterval(() => {
    now.value = Date.now();
  }, 1000);
  if (checkedIn.value) playCheckInAnim(RESTORE_ANIM_DELAYS);
  if (isLoggedIn.value) {
    fetchTodayCheckIn();
  }
});

onUnmounted(() => {
  if (clockTimer) clearInterval(clockTimer);
});
</script>

<template>
  <div
    class="w-full lg:w-[300px] lg:aspect-square lg:self-start shrink-0 flex flex-col bg-gradient-to-br from-white to-bg-sunken/60 border-t lg:border-t-0 lg:border-l border-border">
    <div class="flex items-center justify-center gap-1.5 pt-5 text-xs text-text-muted leading-tight">
      <UIcon name="i-lucide-calendar" class="size-3.5 text-primary shrink-0" />
      <span>{{ todayDateStr }}</span>
      <ClientOnly>
        <span class="tabular-nums font-mono text-text-secondary text-[11px]">· {{ todayTimeStr }}</span>
      </ClientOnly>
    </div>
    <CheckInCard
      :is-logged-in="isLoggedIn"
      :username="user?.username ?? ''"
      :checked-in="checkedIn"
      :fade-white="fadeWhite"
      :show-text="showText"
      :streak-count="streakCount"
      :show-streak="showStreak"
      :check-in-loaded="checkInLoaded"
      @checkin="handleCheckIn"
    />
  </div>
</template>
