<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { workspaceCacheKey } from '~/utils/workspace';
import { DOMAIN_CONTEST_TYPES } from '~/utils/domain-contests';
import { extractApiError } from '~/utils/apiError';
import { formatDateTime } from '~/utils/submissionFormat';
import { runContestRegistration } from '~/utils/contestRegistration';
import { useOfficialSolutions } from '~/composables/useOfficialSolutions';
import {
  contestCountdown,
  contestDurationText,
  contestPhase,
  contestProblemsState,
  contestRegistrationState,
  rankingVisibilityText,
  scoreboardScopeText,
} from '~/utils/contestWindow';

/**
 * 域比赛详情与报名页。
 *
 * 信息架构：一个顶部赛事头部（状态、倒计时、赛程、规模、主操作）+ 左侧正文
 * （报名 / 赛题 / 说明 / 公告）+ 右侧事实栏（赛制规则、答题窗口、榜单可见性）。
 * 报名、已报名、未开始、已结束、组织者五种身份共用同一套状态机
 * （`utils/contestWindow.ts`），避免模板里散落互斥的 `v-if`。
 */
definePageMeta({
  layout: 'workspace',
  middleware: 'workspace-context',
  workspaceWidth: 'library',
  breadcrumbWidth: '960px',
});

const route = useRoute();
const { slug, domain } = useWorkspace();
const { user, isLoggedIn } = useAuth();
const api = useDomainContests();
const scope = useWorkspaceActionScope();

const id = computed(() => String(route.params.contestId));
const key = computed(() => workspaceCacheKey(slug.value!, user.value?.id ?? null, 'contest', id.value));

const { data, error, status, refresh } = await useAsyncData(key, () => api.detail(slug.value!, id.value));

const contest = computed(() => data.value?.data ?? null);
// ── 倒计时：只读 Date.now()，每秒重算（SSR 首帧不依赖本地时钟） ──
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  timer = setInterval(() => now.value = Date.now(), 1000);
  focusClarificationsIfNeeded();
});
// 头部/外部链接带 `?tab=clarifications` 直达答疑区；路由复用同一组件时 query 变化也要响应。
watch(() => route.query?.tab, () => focusClarificationsIfNeeded());
onUnmounted(() => {
  if (timer) clearInterval(timer);
});
/**
 * 本地阶段：赛前 / 赛中 / 赛后只看 `start_time` / `end_time`。
 *
 * 不依赖服务端下发的 `status`（它只在低频同步时更新），因此跨越边界是即时的：
 * 倒计时归零的那一刻，报名区、赛题区与作答入口会一起切到下一阶段。
 */
const phase = computed(() => contestPhase(contest.value, now.value));
/** 阶段或 revision 变化 → 立即重取一次事实（报名、公告、赛程）。 */
watch(
  [phase, () => contest.value?.status, () => contest.value?.revision],
  (next, previous) => {
    // 本地阶段、服务端状态、revision 任一变化都重取：本地时钟负责边界，服务端状态
    // 负责"赛程被改过"这类客户端推不出来的事实。
    if (!previous || next[0] !== previous[0] || next[1] !== previous[1] || next[2] !== previous[2]) void refresh();
  },
);
const countdownTarget = computed(() =>
  contest.value ? (phase.value === 'pending' ? contest.value.start_time : contest.value.end_time) : null
);
const countdown = computed(() => contestCountdown(countdownTarget.value, now.value));

const contestType = computed(() => DOMAIN_CONTEST_TYPES.find((type) => type.value === contest.value?.type));
const registration = computed(() => contest.value
  ? contestRegistrationState({
    isLoggedIn: isLoggedIn.value,
    isRegistered: contest.value.is_registered === true,
    status: phase.value,
    canManage: contest.value.can_manage === true,
  })
  : null);
const problemsState = computed(() => contest.value
  ? contestProblemsState({
    status: phase.value,
    isRegistered: contest.value.is_registered === true,
    canManage: contest.value.can_manage === true,
  })
  : null);

/** 赛题只在「可见状态」下拉取；未开赛/未报名由后端 403，前端不先发请求。 */
const problems = await useAsyncData(
  computed(() => `${key.value}:problems:${problemsState.value}:${contest.value?.updated_at ?? ''}`),
  () => problemsState.value === 'visible' ? api.problems(slug.value!, id.value) : Promise.resolve(null),
);

const registerSection = ref<HTMLElement | null>(null);
const clarificationsSection = ref<HTMLElement | null>(null);

/** 头部「报名参赛」把注意力带到报名区；需要凭据时直接聚焦输入框。 */
function focusRegistration() {
  const target = registerSection.value?.querySelector<HTMLElement>('button');
  target?.focus?.();
  registerSection.value?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function focusClarificationsIfNeeded() {
  if (route.query?.tab === 'clarifications') {
    clarificationsSection.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

const registering = ref(false);
const failure = ref('');
const registeredFlash = ref(false);

async function register() {
  if (registering.value) return;
  failure.value = '';
  try {
    await runContestRegistration({
      isRegistering: () => registering.value,
      setRegistering: (value) => registering.value = value,
      register: async () => {
        const operation = scope();
        await api.register(operation.slug, id.value);
      },
      onRegistered: () => {
        registeredFlash.value = true;
      },
      refresh: async () => {
        await refresh();
      },
      onRefreshFailed: () => {
        failure.value = '报名已成功，但页面刷新失败，请手动刷新';
      },
    });
  } catch (e) {
    failure.value = extractApiError(e).message;
  }
}

/**
 * 详情同步策略：本地时钟负责「赛前/赛中/赛后」的展示，服务端只做低频事实同步。
 *
 * 此前这里是 5 秒 detail 轮询：赛时每场比赛的每个在线观众每 5 秒打一次详情查询，
 * 而详情里真正会变的东西（报名状态、公告、revision、赛程）只在组织者操作或本人报名
 * 时才变。现在：
 * - 跨过开赛 / 结束边界 → 立即重取；
 * - `revision` 变化（服务端下发）→ 立即重取；
 * - 其余每 30 秒同步一次，另在页面重新可见时补一次。
 * 不能用「revision 变了才刷新」当唯一条件——当前没有独立的 revision 通知渠道。
 */
usePolling({
  intervalMs: computed(() => (phase.value !== 'ended' ? 30000 : null)),
  immediate: false,
  fetcher: () => refresh(),
});

const durationText = computed(() =>
  contest.value ? contestDurationText(contest.value.start_time, contest.value.end_time) : null
);

const statusMeta = computed(() => {
  switch (phase.value) {
    case 'running':
      return { label: '进行中', icon: 'i-lucide-radio', tone: 'signal' as const };
    case 'pending':
      return { label: '未开始', icon: 'i-lucide-clock', tone: 'primary' as const };
    default:
      return { label: '已结束', icon: 'i-lucide-flag', tone: 'muted' as const };
  }
});

const startText = computed(() => formatDateTime(contest.value?.start_time));
const endText = computed(() => formatDateTime(contest.value?.end_time));
const announcement = computed(() => contest.value?.announcement ?? '');

// ── 赛题行状态：用户状态由后端下发 ──
const problemStatusLabel: Record<string, string> = { solved: '已解决', attempted: '尝试过', untouched: '未开始' };

/**
 * 赛后复盘：官方题解入口。
 *
 * 只在比赛结束后启用（赛中给出会提前泄露判定思路），一次拉取本域官方题解再按题分组，
 * 避免每道赛题各发一次请求。授权与保密仍由域社区读取路径决定，前端不做过滤。
 */
const officialSolutions = await useOfficialSolutions(
  slug,
  computed(() => phase.value === 'ended' && domain.value?.configuration.features.community !== false),
);
/** 该题是否有官方题解（用于列表里显示入口，没有就不显示死链）。 */
const hasOfficialSolution = (problemId: string) =>
  officialSolutions.forProblem(problemId).length > 0;
/** 单篇直达，多篇落到赛题页选择。 */
const officialSolutionLink = (problemId: string) => {
  const rows = officialSolutions.forProblem(problemId);
  if (rows.length !== 1) {
    return `/d/${slug.value}/contests/${encodeURIComponent(id.value)}/problems/${
      encodeURIComponent(
        problems.data.value?.data.find((item) => item.problem_id === problemId)?.label ?? '',
      )
    }`;
  }
  return officialSolutions.hrefOf(rows[0]!);
};

useSeoMeta({ title: () => contest.value?.title ?? '比赛' });
</script>

<template>
  <AsyncContent
    :status="error ? 'error' : status === 'pending' && !contest ? 'loading' : contest ? 'data' : 'empty'"
    :error="error ? extractApiError(error).message : undefined" @retry="refresh()">
    <div v-if="contest" class="space-y-6">
      <!-- ── 赛事头部：状态 / 标题 / 赛程 / 主操作 ────────────────── -->
      <header class="overflow-hidden rounded-lg border border-border bg-bg-panel shadow-card">
        <div class="border-b border-border px-5 py-4 sm:px-7 sm:py-5">
          <div class="flex flex-wrap items-center gap-2 text-xs">
            <span
              class="inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-semibold"
              :class="statusMeta.tone === 'signal'
                ? 'border-signal/30 bg-signal/10 text-signal-deep'
                : statusMeta.tone === 'primary'
                  ? 'border-primary/25 bg-primary-bg text-primary'
                  : 'border-border bg-bg-sunken text-text-secondary'">
              <UIcon :name="statusMeta.icon" class="size-3.5" />
              {{ statusMeta.label }}
            </span>
            <span class="rounded border border-border px-2 py-0.5 font-medium text-text-secondary">
              {{ contestType?.label }}
            </span>
            <span v-if="contest.secrecy_enabled" class="rounded border border-border px-2 py-0.5 font-medium text-text-secondary">
              赛题保护
            </span>
            <span v-if="contest.is_registered" class="inline-flex items-center gap-1.5 rounded border border-signal/30 bg-signal/10 px-2 py-0.5 font-semibold text-signal-deep">
              <UIcon name="i-lucide-user-check" class="size-3.5" />
              已报名
            </span>
            <span class="ml-auto font-mono text-[11px] text-text-muted">{{ contest.public_id }}</span>
          </div>

          <div class="mt-3 flex flex-wrap items-start justify-between gap-4">
            <h1 class="min-w-0 break-words text-2xl font-bold leading-tight text-text sm:text-3xl">
              {{ contest.title }}
            </h1>
            <div class="flex flex-wrap items-center gap-2">
              <UButton :to="`/d/${slug}/contests/${id}/ranking`" color="neutral" variant="outline" size="sm"
                icon="i-lucide-trophy">
                成绩榜
              </UButton>
              <UButton v-if="contest.can_manage" :to="`/d/${slug}/contests/${id}/manage`" color="neutral"
                variant="outline" size="sm" icon="i-lucide-settings-2">
                管理比赛
              </UButton>
              <UButton v-if="registration?.kind === 'registered' && problemsState === 'visible' && problems.data.value?.data.length"
                :to="`/d/${slug}/contests/${id}/problems/${encodeURIComponent(problems.data.value.data[0]!.label)}`"
                size="sm" icon="i-lucide-play">
                进入赛题
              </UButton>
              <UButton v-else-if="registration?.kind === 'register'" size="sm" icon="i-lucide-user-plus"
                @click="focusRegistration">
                报名参赛
              </UButton>
            </div>
          </div>

          <dl class="mt-4 grid grid-cols-2 gap-x-6 gap-y-2.5 border-t border-border pt-4 text-xs sm:grid-cols-4">
            <div class="min-w-0">
              <dt class="text-text-muted">开始</dt>
              <dd class="mt-0.5 tabular-nums text-text">{{ startText }}</dd>
            </div>
            <div class="min-w-0">
              <dt class="text-text-muted">结束</dt>
              <dd class="mt-0.5 tabular-nums text-text">{{ endText }}</dd>
            </div>
            <div>
              <dt class="text-text-muted">赛程</dt>
              <dd class="mt-0.5 tabular-nums text-text">{{ durationText ?? '—' }}</dd>
            </div>
            <div>
              <dt class="text-text-muted">规模</dt>
              <dd class="mt-0.5 tabular-nums text-text">
                {{ contest.problem_count }} 题 · {{ contest.participant_count }} 人
              </dd>
            </div>
          </dl>
        </div>

        <!-- 倒计时：只在未结束时出现，进行中为「距离结束」 -->
        <div v-if="phase !== 'ended' && !countdown.expired"
          class="flex flex-wrap items-center justify-between gap-3 bg-bg-sunken/60 px-5 py-3 sm:px-7">
          <p class="text-xs text-text-secondary">
            {{ phase === 'pending' ? '距离开始还有' : '距离结束还有' }}
          </p>
          <p class="font-mono text-lg font-semibold tabular-nums tracking-wide text-text">{{ countdown.text }}</p>
        </div>
      </header>

      <div class="grid min-w-0 grid-cols-1 items-start gap-6 lg:grid-cols-12">
        <div class="min-w-0 space-y-5 lg:col-span-8">
          <!-- ── 报名 ──────────────────────────────────────────── -->
          <section id="contest-register" ref="registerSection"
            class="scroll-mt-24 rounded-lg border border-border bg-bg-panel p-5 shadow-card sm:p-6">
            <template v-if="registration?.kind === 'login'">
              <h2 class="text-base font-semibold text-text">报名参赛</h2>
              <p class="mt-2 text-sm leading-6 text-text-secondary">
                登录后可报名本场{{ contestType?.label }}比赛，报名成功后即可在开赛后进入赛题作答。
              </p>
              <div class="mt-4 flex flex-wrap items-center gap-3">
                <UButton :to="{ path: '/login', query: { redirect: route.fullPath } }" icon="i-lucide-log-in">
                  登录后报名
                </UButton>
                <NuxtLink :to="{ path: '/register', query: { redirect: route.fullPath } }"
                  class="text-sm text-primary no-underline hover:underline">
                  注册新账号
                </NuxtLink>
              </div>
            </template>

            <template v-else-if="registration?.kind === 'register'">
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div class="min-w-0">
                  <h2 class="text-base font-semibold text-text">报名参赛</h2>
                  <p class="mt-2 max-w-prose text-sm leading-6 text-text-secondary">
                    报名即刻生效，开赛后可从本场比赛入口作答；成绩按赛制计入本场榜单。
                  </p>
                </div>
                <span class="rounded border border-border bg-bg-sunken px-2 py-1 text-xs tabular-nums text-text-muted">
                  域内报名
                </span>
              </div>
              <div class="mt-4 flex flex-wrap items-start gap-3">
                <UButton :loading="registering" icon="i-lucide-user-plus" @click="register">
                  报名参赛
                </UButton>
                <p class="self-center text-xs text-text-muted">报名后可随时查看赛程；开赛后即可作答。</p>
              </div>
              <UAlert v-if="failure" color="error" :title="failure" class="mt-4" />
            </template>

            <template v-else-if="registration?.kind === 'registered'">
              <div class="min-w-0">
                <div>
                  <h2 class="flex flex-wrap items-center gap-2 text-base font-semibold text-text">
                    <UIcon name="i-lucide-check-circle-2" class="size-4 text-signal-deep" />
                    你已报名本场比赛
                    <UBadge color="success" variant="subtle">参赛者</UBadge>
                  </h2>
                  <p class="mt-2 max-w-prose text-sm leading-6 text-text-secondary">
                    <template v-if="problemsState === 'not-started'">
                      比赛尚未开始，赛题与作答入口将在开赛后开放；现在可以先确认赛制与榜单规则。
                    </template>
                    <template v-else-if="phase === 'ended'">
                      比赛已结束，赛题仍可查看与复盘，提交不再受理。
                    </template>
                    <template v-else>
                      比赛进行中，可以从下方赛题列表进入作答；提交按赛制计入本场成绩。
                    </template>
                  </p>
                </div>
              </div>
              <UAlert v-if="registeredFlash" color="success" title="报名成功，赛题入口已开放" class="mt-4" />
            </template>

            <template v-else-if="registration?.kind === 'ended'">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 class="text-base font-semibold text-text">比赛已结束</h2>
                  <p class="mt-2 text-sm leading-6 text-text-secondary">
                    不再接受报名；赛题对所有人开放复盘，提交不再受理。
                  </p>
                </div>
                <UButton :to="`/d/${slug}/contests/${id}/ranking`" color="neutral" variant="outline"
                  icon="i-lucide-trophy">
                  查看成绩
                </UButton>
              </div>
            </template>
          </section>

          <!-- ── 赛题 ──────────────────────────────────────────── -->
          <section class="rounded-lg border border-border bg-bg-panel shadow-card">
            <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3.5 sm:px-6">
              <h2 class="text-sm font-semibold text-text">赛题</h2>
              <span class="text-xs tabular-nums text-text-muted">
                {{ problemsState === 'visible' ? `${problems.data.value?.data.length ?? contest.problem_count} 题` : `共 ${contest.problem_count} 题` }}
              </span>
            </div>

            <div v-if="problemsState === 'not-started'" class="px-5 py-8 text-center sm:px-6">
              <UIcon name="i-lucide-lock" class="size-6 text-text-muted" />
              <p class="mt-2 text-sm text-text-secondary">赛题在开赛后开放</p>
              <p class="mt-1 text-xs text-text-muted">开始时间 {{ startText }}</p>
            </div>
            <div v-else-if="problemsState === 'not-registered'" class="px-5 py-8 text-center sm:px-6">
              <UIcon name="i-lucide-user-lock" class="size-6 text-text-muted" />
              <p class="mt-2 text-sm text-text-secondary">报名后可查看赛题</p>
              <p class="mt-1 text-xs text-text-muted">报名不收费，可随时在比赛结束前完成。</p>
            </div>
            <UAlert v-else-if="problems.error.value" color="error" :title="extractApiError(problems.error.value).message"
              class="m-5">
              <template #actions>
                <UButton @click="problems.refresh()">重试</UButton>
              </template>
            </UAlert>
            <p v-else-if="problems.status.value === 'pending'" class="px-5 py-8 text-center text-sm text-text-muted">
              正在读取赛题…
            </p>
            <ul v-else-if="problems.data.value?.data.length" class="divide-y divide-border">
              <li v-for="problem in problems.data.value.data" :key="problem.problem_id">
                <NuxtLink
                  :to="`/d/${slug}/contests/${id}/problems/${encodeURIComponent(problem.label)}`"
                  class="group flex flex-wrap items-center gap-4 px-5 py-4 no-underline transition-colors hover:bg-primary-bg/40 sm:px-6">
                  <span
                    class="flex size-9 shrink-0 items-center justify-center rounded border border-primary/20 bg-primary-bg font-mono text-sm font-semibold text-primary">
                    {{ problem.label }}
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="block break-words font-semibold text-text group-hover:text-primary">{{ problem.title }}</span>
                    <span class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
                      <span class="font-mono">{{ problem.display_id }}</span>
                      <span>固定版本 V{{ problem.version ?? '—' }}</span>
                      <span v-if="problem.judge_type">{{ problem.judge_type === 'oi' ? 'OI 题' : 'AI 题' }}</span>
                      <span v-if="problem.score" class="tabular-nums">{{ (problem.score / 100).toFixed(0) }} 分</span>
                    </span>
                  </span>
                  <span class="flex items-center gap-3">
                    <!-- 赛后复盘：仅在该题确有官方题解时给出入口，不制造死链。 -->
                    <NuxtLink
                      v-if="phase === 'ended' && hasOfficialSolution(problem.problem_id)"
                      :to="officialSolutionLink(problem.problem_id)"
                      class="inline-flex items-center gap-1 text-xs font-medium text-primary no-underline hover:underline"
                      @click.stop>
                      <UIcon name="i-lucide-book-open-check" class="size-3.5" />
                      官方题解
                    </NuxtLink>
                    <span v-if="user && problem.user_status"
                      class="text-xs font-medium"
                      :class="problem.user_status === 'solved'
                        ? 'text-signal-deep'
                        : problem.user_status === 'attempted'
                          ? 'text-warning-text'
                          : 'text-text-muted'">
                      {{ problemStatusLabel[problem.user_status] }}
                    </span>
                    <UIcon name="i-lucide-chevron-right" class="size-4 shrink-0 text-text-muted" />
                  </span>
                </NuxtLink>
              </li>
            </ul>
            <div v-else class="px-5 py-8 text-center sm:px-6">
              <p class="text-sm text-text-secondary">本场暂未公布赛题</p>
            </div>
          </section>

          <!-- ── 比赛说明 ──────────────────────────────────────── -->
          <section class="rounded-lg border border-border bg-bg-panel px-5 py-5 shadow-card sm:px-6">
            <h2 class="mb-3 text-sm font-semibold text-text">比赛说明</h2>
            <div v-if="contest.description.trim()" class="text-sm leading-7">
              <MarkdownRenderer :content="contest.description" />
            </div>
            <p v-else class="text-sm text-text-secondary">组织者未填写比赛说明。</p>
          </section>

          <!-- ── 公告 ──────────────────────────────────────────── -->
          <section v-if="announcement.trim()" class="rounded-lg border border-info-text/25 bg-info-text/5 px-5 py-5 sm:px-6">
            <h2 class="mb-3 flex items-center gap-2 text-sm font-semibold text-info-text">
              <UIcon name="i-lucide-megaphone" class="size-4" />
              比赛公告
            </h2>
            <div class="text-sm leading-7">
              <MarkdownRenderer :content="announcement" />
            </div>
          </section>

          <!-- ── 竞赛答疑 ──────────────────────────────────────── -->
          <section id="clarifications" ref="clarificationsSection"
            class="scroll-mt-24 rounded-lg border border-border bg-bg-panel px-5 py-5 shadow-card sm:px-6">
            <ClarificationsPanel :slug="slug!" :contest="contest" :problems="problems.data.value?.data ?? []" />
          </section>
        </div>

        <!-- ── 右侧事实栏 ──────────────────────────────────────── -->
        <!-- 右侧事实栏随阅读滚动停留：长赛题列表下仍能看到赛制与入口 -->
        <aside class="min-w-0 space-y-5 lg:sticky lg:top-20 lg:col-span-4">
          <section class="rounded-lg border border-border bg-bg-panel p-5">
            <h2 class="mb-3 text-sm font-semibold text-text">赛制与规则</h2>
            <dl class="space-y-3 text-sm">
              <div>
                <dt class="text-xs text-text-muted">赛制</dt>
                <dd class="mt-0.5 text-text">{{ contestType?.label }}</dd>
                <dd class="mt-1 text-xs leading-5 text-text-secondary">{{ contestType?.description }}</dd>
              </div>
              <div class="border-t border-border pt-3">
                <dt class="text-xs text-text-muted">成绩如何公布</dt>
                <dd class="mt-0.5 text-xs leading-5 text-text-secondary">
                  {{ scoreboardScopeText(contest.type, contest.config.scoreboard_scope) }}
                </dd>
              </div>
              <div class="border-t border-border pt-3">
                <dt class="text-xs text-text-muted">榜单可见性</dt>
                <dd class="mt-0.5 text-xs leading-5 text-text-secondary">
                  {{ rankingVisibilityText(contest.ranking_visibility) }}
                </dd>
              </div>
              <div v-if="contest.freeze_duration_seconds > 0" class="border-t border-border pt-3">
                <dt class="text-xs text-text-muted">封榜</dt>
                <dd class="mt-0.5 text-xs leading-5 text-text-secondary">
                  结束前 {{ Math.round(contest.freeze_duration_seconds / 60) }} 分钟封榜，封榜后的提交赛后揭晓
                </dd>
              </div>
              <div class="border-t border-border pt-3">
                <dt class="text-xs text-text-muted">计分范围</dt>
                <dd class="mt-0.5 text-xs leading-5 text-text-secondary">
                  {{ contest.affect_global_ranking ? '本场成绩计入全局解题统计' : '本场成绩不计入全局解题统计' }}
                </dd>
              </div>
              <div v-if="contest.classrooms?.length" class="border-t border-border pt-3">
                <dt class="text-xs text-text-muted">关联班级</dt>
                <dd class="mt-1 flex flex-wrap gap-1.5">
                  <span v-for="classroom in contest.classrooms" :key="classroom.id"
                    class="rounded border border-border bg-bg-sunken px-2 py-0.5 text-xs text-text-secondary">
                    {{ classroom.name }}
                  </span>
                </dd>
                <dd class="mt-1.5 text-xs leading-5 text-text-muted">榜单可按关联班级分组查看。</dd>
              </div>
            </dl>
          </section>

          <section class="rounded-lg border border-border bg-bg-panel p-5">
            <h2 class="mb-3 text-sm font-semibold text-text">前往</h2>
            <div class="flex flex-col gap-2">
              <UButton :to="`/d/${slug}/contests`" color="neutral" variant="outline" icon="i-lucide-list"
                class="justify-start">
                全部比赛
              </UButton>
              <UButton v-if="contest.can_manage" :to="`/d/${slug}/contests/${id}/manage`" color="neutral"
                variant="outline" icon="i-lucide-settings-2" class="justify-start">
                比赛管理
              </UButton>
              <UButton v-if="registration?.kind === 'registered' && problemsState === 'visible' && problems.data.value?.data.length"
                :to="`/d/${slug}/contests/${id}/problems/${encodeURIComponent(problems.data.value.data[0]!.label)}`"
                color="neutral" variant="outline" icon="i-lucide-play" class="justify-start">
                第一题：{{ problems.data.value.data[0]!.label }}
              </UButton>
            </div>
            <p v-if="problemsState === 'visible'" class="mt-3 text-xs leading-5 text-text-muted">
              赛题版本在本场固定：比赛期间题库发布新版本不会改变本场题目。
            </p>
          </section>
        </aside>
      </div>
    </div>
  </AsyncContent>
</template>
