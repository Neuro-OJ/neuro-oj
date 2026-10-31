<script setup lang="ts">
import { workspacePath } from '~/utils/workspace';
import { useToast } from '~/composables/useToast';
import type { BffEnvelope } from '~/utils/bff-view';
import type { AnnouncementSummary } from '~/composables/useAnnouncements';
import type { CarouselSlide } from '~/composables/useCarousel';
import type { CommunityConfig, FeedItem } from '~/composables/useCommunity';
import type { EducationDashboardData } from '~/utils/education-dashboard';
import type { DomainProblemSummary } from '~/utils/domain-problems';
type HomeSnapshot = { total: number; full_score: number; not_full_score: number };
type HomeRecentSubmission = {
  id: string;
  public_id: string | null;
  problem_id: string;
  status: string;
  created_at: string;
  problem: { title: string };
  result: { status: string; score: number; time_ms: number | null; memory_kb: number | null } | null;
};
type HomeActivity = { data: { recent: HomeRecentSubmission[]; total: HomeSnapshot; today: HomeSnapshot } };
definePageMeta({ layout: 'workspace', middleware: 'workspace-context', workspaceWidth: 'home' });
const { slug, domain, refresh } = useWorkspace();
const { user, isLoggedIn } = useAuth();
const workspace = useWorkspaceApi(), { toast } = useToast();
const joining = ref(false), reason = ref('');
const homeKey = computed(() => `domain-home:${slug.value}:${user.value?.id ?? null}`);
const homeCache = useState<{ key: string; data: BffEnvelope } | null>('domain-home-cache', () => null);
const { data: view, error: viewError, status: viewStatus, refresh: refreshView } = await useViewAsyncData(
  'home',
  homeKey,
  async () => {
    if (homeCache.value?.key === homeKey.value) return homeCache.value.data;
    const result = await useApi().api.get<BffEnvelope>(
      `/api/bff/v1/domains/${encodeURIComponent(slug.value!)}/home`,
      { silent: true },
    );
    homeCache.value = { key: homeKey.value, data: result };
    return result;
  },
  { dedupe: 'defer' },
);
const section = <T>(name: keyof BffEnvelope['sections']) => view.value?.sections[name]?.data as T | undefined;
const carousel = computed(() => (section<{ data: CarouselSlide[] }>('carousel')?.data ?? undefined));
const announcements = computed(() => (section<{ data: AnnouncementSummary[] }>('announcements')?.data ?? undefined));
const dashboard = computed(() => section<{ data: EducationDashboardData }>('dashboard'));
const activity = computed(() => section<HomeActivity>('activity'));
const randomProblems = computed(() => section<DomainProblemSummary[]>('randomProblems'));
const communityConfig = computed(() => section<{ key: string; config: CommunityConfig }>('communityConfig')?.config);
const feed = computed(() => section<{ data: FeedItem[] }>('feed')?.data);
async function join() {
  if (!domain.value || joining.value) return;
  joining.value = true;
  try {
    const response = await workspace.join(domain.value.slug, reason.value);
    toast.success(response.data.request ? '加入申请已提交' : '已加入此域');
    await refresh();
  } finally {
    joining.value = false;
  }
}
useSeoMeta({ title: () => domain.value?.name ?? 'Neuro OJ' });
</script>
<template>
  <AsyncContent v-if="domain" :status="viewError ? 'error' : viewStatus === 'pending' ? 'loading' : view ? 'data' : 'empty'"
    :error="viewError ? '首页数据读取失败，请重试' : undefined" @retry="refreshView()">
  <div :key="domain.id + ':' + (user?.id ?? 'guest')" class="space-y-6">
    <!-- 头部核心区：轮播与签到 -->
    <section class="overflow-hidden rounded-lg border border-border bg-bg-panel shadow-card">
      <div class="flex min-h-[320px] flex-col lg:flex-row">
        <Carousel :domain-slug="domain.slug" :title="domain.name" :description="domain.description" :initial-slides="carousel" />
        <HomepageCheckIn :initial-check-in="section<{ data: { checked_in: boolean; streak: number } }>('checkin')?.data" />
      </div>
    </section>

    <!-- 加入空间引导条（非成员且非仅邀请，排除默认主域） -->
    <section
      v-if="domain.slug !== 'main' && !domain.is_member && domain.status === 'active' && domain.configuration.join_policy !== 'invite'"
      class="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-primary/20 bg-primary-bg/40 px-5 py-3.5 text-sm shadow-xs"
      aria-label="加入空间"
    >
      <div class="flex items-center gap-2.5">
        <UIcon name="i-lucide-user-plus" class="size-4 text-primary shrink-0" />
        <span class="text-text font-medium">加入 {{ domain.name }} 开启本空间解题、教学与竞赛权限</span>
      </div>
      <div class="flex items-center gap-2.5">
        <template v-if="isLoggedIn">
          <UInput
            v-if="domain.configuration.join_policy === 'approval'"
            v-model="reason"
            size="sm"
            placeholder="简要说明加入理由"
            aria-label="加入理由"
            class="w-56"
          />
          <UButton
            size="sm"
            color="primary"
            :loading="joining"
            @click="join"
          >
            {{ domain.configuration.join_policy === 'approval' ? '申请加入' : '加入此空间' }}
          </UButton>
        </template>
        <UButton
          v-else
          size="sm"
          color="primary"
          :to="{ path: '/login', query: { redirect: workspacePath(domain.slug) } }"
        >
          登录后加入
        </UButton>
      </div>
    </section>

    <!-- 空间公告 -->
    <div class="overflow-hidden rounded-lg border border-border bg-bg-panel shadow-card">
      <AnnouncementSection :domain-slug="domain.slug" :initial-data="announcements" />
    </div>

    <!-- 教学待办与进行中任务 -->
    <div class="overflow-hidden rounded-lg border border-border bg-bg-panel shadow-card">
      <DomainHomeContent :initial-data="dashboard" />
    </div>

    <!-- 推荐与实时动态网格 -->
    <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <RandomProblems :domain-slug="domain.slug" :initial-data="randomProblems" />
      <LatestSubmissions :domain-slug="domain.slug" :initial-data="activity" />
      <FollowingFeed v-if="domain.configuration.features.community" class="min-h-48 lg:col-span-full"
        :initial-data="feed" :initial-config="communityConfig" />
    </div>
  </div>
  </AsyncContent>
</template>
