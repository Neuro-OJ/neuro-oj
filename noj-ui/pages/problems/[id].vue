<script setup lang="ts">
import { useRoute } from "vue-router"
import type { PostRow } from "~/composables/useCommunity"
import { isAdminUser } from "~/utils/isAdminUser"
import { problemUrl, publicUrl } from "~/utils/publicIdentifiers"
import { extractApiError } from "~/utils/apiError"
import type { PublicProblemStats } from "~/utils/problemStats"
import { useProblemStats } from "~/composables/useProblemStats"
import { toProblemView, type ProblemResource } from "~/utils/problemView"
import { useBreadcrumbLabel } from "~/composables/useBreadcrumb"

const route = useRoute()
const router = useRouter()
const { isLoggedIn, user } = useAuth()
const { config, loadConfig } = useCommunity()

const problemId = route.params.id as string

const { data, pending, error, refresh } = useFetch<{ data: ProblemResource }>(
  `/api/v1/problems/${problemId}`,
)

/** 原始资源 → 统一视图模型（#511：与竞赛做题页共用同一形状）。 */
const problem = computed(() =>
  data.value?.data ? toProblemView(data.value.data) : null
)

// ── 面包屑（#512）：数据到位后用题名精化末层文案 ──
useBreadcrumbLabel(() => problem.value?.title)

// ── 公开通过率：对所有人可见；竞赛进行中由后端抑制 ──
const { fetchPublic } = useProblemStats()
const publicStats = ref<PublicProblemStats | null>(null)

useSeoMeta({
  title: () => problem.value?.title ? `${problem.value.title} - Neuro OJ` : '题目 - Neuro OJ',
  description: () => problem.value?.description ? problem.value.description.slice(0, 160) : 'Neuro OJ 在线评测题目',
  ogTitle: () => problem.value?.title ?? 'Neuro OJ',
  ogDescription: () => problem.value?.description ? problem.value.description.slice(0, 160) : 'Neuro OJ 在线评测平台',
})

// 注：本详情页不包含提交轮询（useSubmissionPolling 仅存在于做题工作区 EditorWorkspace），
// 无法在提交终态回调里即时刷新。退而求其次：每次挂载（含从编辑器返回）都重新拉取一次，
// 保证用户通过本题（AC）后回到详情页即可看到算法标签与最新门控状态。
onMounted(() => {
  refresh()
})

const canEdit = computed(() => {
  const p = problem.value
  if (!p) return false
  return isAdminUser(user.value) || (p.type === "U" && p.owner_id === user.value?.id)
})

const isDetailPage = computed(() => route.path === `/problems/${problemId}`)

/** 客观题套卷（并入 problems 体系：无评测容器，服务端即时判定） */
const isObjective = computed(() => problem.value?.is_objective === true)
/** artifact 提交模式：选手上传 zip 产物 */
const isArtifact = computed(() => problem.value?.submission_mode === 'artifact')

/** 独立编辑器入口（客观题与 artifact 题无编辑器）。 */
const editorUrl = computed(() =>
  problem.value && !isObjective.value && !isArtifact.value
    ? `/editor/${problem.value.display_id || problemId}`
    : null
)
const editUrl = computed(() =>
  problem.value && canEdit.value
    ? `${problemUrl(problem.value.id, problem.value.display_id)}/edit`
    : null
)

/** 描述区展开/收起状态（由页面持有，组件无内部状态）。 */
const statementExpanded = ref(false)

function goToEditor() {
  if (editorUrl.value) router.push(editorUrl.value)
}

// ── artifact 提交 ──
const artifactFile = ref<File | null>(null)
const artifactSubmitting = ref(false)
const artifactError = ref('')
const artifactSuccessId = ref('')
const { api } = useApi()

function formatMb(mb: number | null | undefined): string {
  if (mb == null) return 'NOJ 默认上限'
  return `${mb} MB`
}

async function handleArtifactSubmit() {
  if (!problem.value) return
  if (!artifactFile.value) {
    artifactError.value = '请选择 zip 文件'
    return
  }
  artifactError.value = ''
  artifactSubmitting.value = true
  try {
    const form = new FormData()
    form.append('problem_id', problem.value.id)
    form.append('language', 'python3')
    form.append('file', artifactFile.value)
    const res = await api.post<{ data: { id: string; public_id?: string } }>(
      '/api/v1/submissions',
      form,
    )
    artifactSuccessId.value = res.data.id
    artifactFile.value = null
  } catch (err: unknown) {
    artifactError.value = extractApiError(err).message
  } finally {
    artifactSubmitting.value = false
  }
}

// ── 题解区（community-ui spec：题解列表 + 发布入口，服从模块开关与权限）──
const solutions = ref<PostRow[]>([])
const loadingSolutions = ref(false)
const eligibility = ref<{
  enabled: boolean
  requires_accepted: boolean
  accepted: boolean
  can_create: boolean
  /** 赛期门控原因：running_contest 时禁用发布入口。 */
  blocked_reason: string | null
} | null>(null)

watch(
  problem,
  async (p) => {
    if (!p) return
    loadingSolutions.value = true
    try {
      // 公开统计与题解并行拉取；失败时保持 null（不渲染），不影响主内容
      void fetchPublic(p.id)
        .then((res) => { publicStats.value = res.data })
        .catch(() => { publicStats.value = null })
      const [solRes, cfg] = await Promise.all([
        api.get<{ data: PostRow[] }>(
          `/api/v1/community/posts?type=solution&problem_id=${p.id}&limit=5`,
        ),
        loadConfig(),
      ])
      solutions.value = solRes.data
      if (isLoggedIn.value) {
        try {
          const el = await api.get<{ data: typeof eligibility.value }>(
            `/api/v1/community/solutions/eligibility?problem_id=${p.id}`,
          )
          eligibility.value = el.data
        } catch {
          eligibility.value = null
        }
      } else {
        eligibility.value = null
      }
    } catch {
      // 模块关闭（403）或游客不可读（401）时题解区静默降级为空
      solutions.value = []
      eligibility.value = null
    } finally {
      loadingSolutions.value = false
    }
  },
  { immediate: true },
)

/** 发布入口禁用原因（未通过门槛 / 无权限 / 只读模式） */
const publishBlockReason = computed(() => {
  const el = eligibility.value
  if (!el) return null
  if (el.can_create) return null
  // 赛期门控优先展示：这是"看得到题但暂时不能写题解"的场景，与权限不足不同
  if (el.blocked_reason === "running_contest") return "竞赛进行中，赛后开放题解"
  if (!el.enabled) return "题解区已关闭"
  if (config.value?.read_only) return "社区当前为只读模式"
  if (el.requires_accepted && !el.accepted) return "通过本题后可发布题解"
  return "当前账号没有发布题解的权限"
})
</script>

<template>
  <NuxtPage v-if="!isDetailPage" />

  <template v-else>
    <AsyncContent
      :status="pending ? 'loading' : error ? 'error' : problem ? 'data' : 'empty'"
      error="题目加载失败"
      @retry="refresh"
    >
      <template #error>
        <span class="flex items-center justify-center size-11 rounded-full bg-error-text/10 text-error-text text-xl font-bold">!</span>
        <p>题目加载失败</p>
        <UButton color="primary" variant="outline" to="/problems">返回题目列表</UButton>
      </template>

      <!-- v-if="problem"：与 AsyncContent 的 'data' 状态等价，同时让模板对 problem 做类型收窄 -->
      <div v-if="problem" class="mx-auto max-w-7xl p-4 sm:p-6">
        <!-- 页内锚点：题面 / 题解（客观题无题解区） -->
        <nav aria-label="页内导航" class="mb-4 flex items-center gap-4 text-sm">
          <NuxtLink to="/problems" class="text-text-secondary no-underline hover:text-primary">题库</NuxtLink>
          <a href="#statement" class="text-text-secondary no-underline hover:text-primary">题面</a>
          <a v-if="!isObjective" href="#solutions" class="text-text-secondary no-underline hover:text-primary">题解</a>
        </nav>

        <div class="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <!-- ── 主栏 ── -->
          <div class="min-w-0 space-y-6 lg:col-span-8">
            <ProblemHeader :problem="problem" :stats="publicStats">
              <template #actions>
                <AddToTrainingMenu v-if="isLoggedIn" :problem-id="problem.id" />
                <UButton
                  v-if="editorUrl"
                  color="primary"
                  class="inline-flex items-center gap-2 px-5 py-2.5 text-sm"
                  :to="editorUrl"
                >
                  <UIcon name="i-lucide-code-2" class="size-4" />
                  开始编码
                </UButton>
              </template>
            </ProblemHeader>

            <!-- 客观题：作答表单内联在题面卡片中（不折叠、不复制） -->
            <ProblemStatement
              v-if="isObjective"
              title="作答"
              :content="problem.description"
              :collapsible="false"
              :copyable="false"
            >
              <template #body>
                <ObjectiveAnswerForm :paper-id="problem.display_id || problem.id" />
              </template>
            </ProblemStatement>

            <!-- 编程题：题面 + 工具条（复制 / 展开收起 / 在编辑器打开 / 编辑） -->
            <ProblemStatement
              v-else
              v-model:expanded="statementExpanded"
              :content="problem.description"
              :editor-to="editorUrl"
              :edit-to="editUrl"
            />

            <!-- artifact 题：zip 上传提交 -->
            <section v-if="isArtifact" class="rounded-xl border border-border bg-white p-6">
              <h2 class="text-base font-semibold text-text mb-1">提交产物（zip）</h2>
              <p class="text-sm text-text-secondary">
                请上传包含 <code class="font-mono text-primary">submission.py</code> 的 zip 压缩包，平台将在云端评测。
                大小上限：{{ formatMb(problem.artifact_max_size_mb) }}。
              </p>
              <div class="mt-4 flex flex-col gap-3">
                <input
                  type="file"
                  accept=".zip,application/zip,application/x-zip-compressed"
                  class="block w-full text-sm text-text-secondary file:mr-3 file:rounded-md file:border-0 file:bg-signal file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-signal/80"
                  @change="(e: Event) => artifactFile = (e.target as HTMLInputElement).files?.[0] ?? null"
                />
                <div v-if="artifactError" class="text-sm text-error-text">{{ artifactError }}</div>
                <div v-if="artifactSuccessId" class="text-sm text-success-text">
                  提交成功！
                  <NuxtLink :to="publicUrl('submission', artifactSuccessId)" class="text-primary no-underline hover:underline">查看评测结果</NuxtLink>
                </div>
                <div class="flex items-center gap-3">
                  <UButton color="primary" :loading="artifactSubmitting" :disabled="!isLoggedIn || artifactSubmitting" @click="handleArtifactSubmit">
                    <UIcon name="i-lucide-upload" class="size-4" />
                    上传并提交
                  </UButton>
                  <span v-if="!isLoggedIn" class="text-sm text-text-muted">
                    <NuxtLink to="/login" class="text-primary no-underline hover:underline">登录</NuxtLink>
                    后即可提交
                  </span>
                </div>
              </div>
            </section>

            <div v-if="!isLoggedIn && !isObjective && !isArtifact" class="text-center text-sm text-text-muted">
              <NuxtLink to="/login" class="text-primary no-underline hover:underline">登录</NuxtLink>
              后即可提交代码
            </div>

            <!-- 题解区（客观题不展示） -->
            <section v-if="!isObjective" id="solutions" class="scroll-mt-20 rounded-xl border border-border bg-white p-6">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 class="text-base font-semibold text-text">题解与讨论</h2>
                  <p class="mt-1 text-sm text-text-secondary">查看本题的公开题解，或在通过后分享思路。</p>
                </div>
                <div class="flex items-center gap-2">
                  <!-- 发布入口：服从题解模块开关与当前用户权限（community-ui spec） -->
                  <UButton
                    v-if="config?.solutions_enabled === false"
                    :to="`/community?type=solution&problem_id=${problem.display_id || problem.id}`"
                    color="primary"
                    variant="outline"
                    class="text-sm"
                  >
                    查看题解
                  </UButton>
                  <UButton
                    v-else-if="!isLoggedIn"
                    color="primary"
                    class="text-sm"
                    @click="router.push('/login')"
                  >
                    登录后发布题解
                  </UButton>
                  <UButton
                    v-else-if="eligibility?.can_create"
                    :to="`/community?type=solution&problem_id=${problem.display_id || problem.id}`"
                    color="primary"
                    class="text-sm"
                  >
                    <UIcon name="i-lucide-book-open" class="size-3.5" />
                    发布题解
                  </UButton>
                  <UButton
                    v-else
                    color="primary"
                    class="text-sm opacity-60 cursor-not-allowed"
                    :disabled="true"
                    :title="publishBlockReason ?? '暂不可发布'"
                  >
                    发布题解
                  </UButton>
                  <UButton
                    :to="`/community?type=solution&problem_id=${problem.id}`"
                    color="primary"
                    variant="outline"
                    class="text-sm"
                  >
                    查看全部
                  </UButton>
                </div>
              </div>

              <!-- 题解列表（community-ui spec：题目详情页展示题解列表） -->
              <div v-if="loadingSolutions" class="mt-4 text-sm text-text-muted">题解加载中…</div>
              <div v-else-if="solutions.length === 0" class="mt-4 text-sm text-text-secondary">
                {{ config?.solutions_enabled === false ? "题解区已关闭。" : "暂无题解，来发布第一篇吧。" }}
              </div>
              <ul v-else class="mt-4 divide-y divide-border">
                <li v-for="item in solutions" :key="item.post.id" class="py-3 first:pt-0 last:pb-0">
                  <NuxtLink
                    :to="publicUrl('post', item.post.public_id || item.post.id)"
                    class="group flex items-start justify-between gap-3"
                  >
                    <span class="flex items-center gap-2 text-sm font-medium text-text group-hover:text-primary">
                      <UIcon name="i-lucide-file-text" class="size-3.5 shrink-0 text-text-muted" />
                      <UBadge v-if="item.post.is_official" color="primary" variant="subtle" class="shrink-0">
                        官方题解
                      </UBadge>
                      {{ item.post.title || "题解" }}
                    </span>
                    <span class="flex shrink-0 items-center gap-2 text-xs text-text-secondary">
                      <span v-if="item.post.is_locked" class="inline-flex items-center gap-0.5">
                        <UIcon name="i-lucide-lock" class="size-[10px]" />已锁定
                      </span>
                      <UserIdentity :user="item.author" size="sm" />
                      <NuxtTime :datetime="item.post.created_at" relative locale="zh-CN" />
                    </span>
                  </NuxtLink>
                </li>
              </ul>

              <!-- 门槛禁用说明（community-ui spec 场景：未通过用户受门槛限制） -->
              <p v-if="isLoggedIn && eligibility && !eligibility.can_create && eligibility.enabled" class="mt-3 flex items-center gap-1.5 text-xs text-text-muted">
                <UIcon name="i-lucide-lock" class="size-3" />
                {{ publishBlockReason }}<template v-if="eligibility.blocked_reason !== 'running_contest'">。通过本题后即可发布题解。</template>
              </p>
            </section>
          </div>

          <!-- ── 右栏（<1024px 位于正文之后，DOM 顺序天然满足） ── -->
          <aside class="space-y-6 lg:col-span-4">
            <ProblemMetaCard :problem="problem" :stats="publicStats" />
            <MySubmissionCard :problem-id="problem.id" />
          </aside>
        </div>
      </div>
    </AsyncContent>
  </template>
</template>
