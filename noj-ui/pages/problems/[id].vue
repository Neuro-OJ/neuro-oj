<script setup lang="ts">
import { useRoute } from "vue-router"
import type { PostRow } from "~/composables/useCommunity"
import { isAdminUser } from "~/utils/isAdminUser"
import { problemUrl, publicUrl } from "~/utils/publicIdentifiers"
import { extractApiError } from "~/utils/apiError"

const route = useRoute()
const router = useRouter()
const { isLoggedIn, user } = useAuth()
const { config, loadConfig } = useCommunity()

const problemId = route.params.id as string

const { data, pending, error, refresh } = useFetch<{
  data: {
    id: string
    title: string
    description: string
    difficulty: string
    display_id: string
    type: string
    owner_id: string
    owner_username?: string
    number: number
    is_objective: boolean
    submission_mode?: 'code' | 'artifact'
    artifact_max_size_mb?: number | null
    tags: { id: string; name: string; kind: 'problem' | 'algorithm' }[]
    has_hidden_algorithm_tags: boolean
    runtime_config?: {
      evaluator?: {
        time_limit_ms?: number
        memory_limit_mb?: number
      }
    }
  }
}>(`/api/v1/problems/${problemId}`)

const problem = computed(() => data.value?.data ?? null)

useSeoMeta({
  title: () => problem.value?.title ? `${problem.value.title} - Neuro OJ` : '题目 - Neuro OJ',
  description: () => problem.value?.description ? problem.value.description.slice(0, 160) : 'Neuro OJ 在线评测题目',
  ogTitle: () => problem.value?.title ?? 'Neuro OJ',
  ogDescription: () => problem.value?.description ? problem.value.description.slice(0, 160) : 'Neuro OJ 在线评测平台',
})

const tags = computed(() => problem.value?.tags ?? [])
// 题目标签（kind='problem'）：点击可跳转到按该标签筛选的题库列表
const problemTags = computed(() => tags.value.filter((t) => t.kind === 'problem'))
// 算法标签（kind='algorithm'，仅 admin/题主/有通过提交的 viewer 可见，后端已裁剪）
const algorithmTags = computed(() => tags.value.filter((t) => t.kind === 'algorithm'))
// 存在不可见的算法标签时的占位提示（通过后可显示）
const hasHiddenAlgorithmTags = computed(() => problem.value?.has_hidden_algorithm_tags === true)

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

function goToEditor() {
  router.push(`/editor/${problem.value?.display_id || problemId}`)
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
} | null>(null)

watch(
  problem,
  async (p) => {
    if (!p) return
    loadingSolutions.value = true
    try {
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
        <span class="flex items-center justify-center size-11 rounded-full bg-red-100 text-red-800 text-xl font-bold">!</span>
        <p>题目加载失败</p>
        <UButton color="primary" variant="outline" to="/problems">返回题目列表</UButton>
      </template>

      <!-- v-if="problem"：与 AsyncContent 的 'data' 状态等价，同时让模板对 problem 做类型收窄 -->
      <div v-if="problem" class="max-w-4xl mx-auto p-6 space-y-6">
      <!-- 题目信息卡片 -->
      <div class="bg-white border border-border rounded-xl overflow-hidden">
        <div class="px-7 py-6 pb-5 border-b border-border">
          <div class="flex items-start justify-between gap-4">
            <div class="flex-1">
              <div class="flex items-center gap-2 mb-2">
                <span
                  class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold"
                  :class="problem.type === 'U' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'"
                >
                  {{ problem.display_id }}
                </span>
                <span
                  class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold"
                  :class="problem.type === 'U' ? 'bg-blue-50 text-blue-600' : 'bg-purple-50 text-purple-600'"
                >
                  {{ problem.type === 'U' ? '用户题库' : '主题库' }}
                </span>
                <span
                  v-if="isObjective"
                  class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-700"
                >
                  客观题
                </span>
              </div>
              <h1 class="text-2xl font-bold mb-3 text-text">{{ problem.title }}</h1>
              <!-- 创建者（用户题库 U 型展示；主题库为平台官方题） -->
              <UserIdentity
                v-if="problem.type === 'U' && problem.owner_username"
                :user="{ id: problem.owner_id, username: problem.owner_username }"
                size="sm"
                class="mb-3"
              />
            </div>
            <div class="flex items-center gap-2">
              <AddToTrainingMenu v-if="isLoggedIn" :problem-id="problem.id" />
              <NuxtLink
                v-if="canEdit"
                :to="`${problemUrl(problem.id, problem.display_id)}/edit`"
                class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-border rounded-lg text-text-secondary hover:text-primary hover:border-signal/40 transition-colors"
              >
                <UIcon name="i-lucide-pencil" class="size-3.5" />
                编辑
              </NuxtLink>
            </div>
          </div>
          <div class="flex items-center gap-5 flex-wrap">
            <DifficultyBadge :difficulty="problem.difficulty" />
            <template v-if="isObjective">
              <span class="inline-flex items-center gap-1 text-xs text-text-secondary">
                <UIcon name="i-lucide-zap" class="size-3.5" />
                服务端即时判定
              </span>
            </template>
            <template v-else>
              <span class="inline-flex items-center gap-1 text-xs text-text-secondary">
                <UIcon name="i-lucide-clock" class="size-3.5" />
                {{ problem.runtime_config?.evaluator?.time_limit_ms ?? '--' }}ms
              </span>
              <span class="inline-flex items-center gap-1 text-xs text-text-secondary">
                <UIcon name="i-lucide-server" class="size-3.5" />
                {{ problem.runtime_config?.evaluator?.memory_limit_mb ?? '--' }}MB
              </span>
            </template>
          </div>
          <div v-if="problemTags.length || algorithmTags.length || hasHiddenAlgorithmTags" class="flex flex-wrap gap-1.5 mt-2.5">
            <!-- 题目标签：点击跳转到题库列表按标签筛选 -->
            <button
              v-for="t in problemTags"
              :key="t.id"
              class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 cursor-pointer transition-colors"
              @click="router.push(`/problems?tag=${t.id}`)"
            >
              {{ t.name }}
            </button>
            <!-- 算法标签（已可见）：与题目标签用不同色系（靛蓝）区分 -->
            <span
              v-for="t in algorithmTags"
              :key="t.id"
              class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-50 text-indigo-700 border border-indigo-200"
            >
              {{ t.name }}
            </span>
            <!-- 隐藏算法标签占位：通过后可显示 -->
            <span
              v-if="hasHiddenAlgorithmTags"
              class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500 border border-gray-200 cursor-default"
              title="通过本题后可查看算法标签"
            >
              🔒 算法标签 · 通过后显示
            </span>
          </div>
        </div>

        <div class="px-7 py-6">
          <!-- 客观题：内联作答表单（练习模式） -->
          <ObjectiveAnswerForm v-if="isObjective" :paper-id="problem.display_id || problem.id" />
          <MarkdownRenderer v-else :content="problem.description" />
        </div>
      </div>

      <!-- 客观题：不提供编码入口（无评测容器） -->
      <template v-if="!isObjective">
        <!-- 代码题：开始编码 CTA -->
        <div v-if="!isArtifact" class="bg-white border border-border rounded-xl p-6 flex items-center justify-between">
          <div>
            <h2 class="text-base font-semibold text-text mb-1">准备好开始编码了吗？</h2>
            <p class="text-sm text-text-secondary">
              点击下方按钮进入独立编码页面，享受沉浸式编辑器体验。
            </p>
          </div>
          <UButton color="primary" class="inline-flex items-center gap-2 px-5 py-2.5 text-sm" @click="goToEditor">
            <UIcon name="i-lucide-code-2" class="size-4" />
            开始编码
          </UButton>
        </div>

        <!-- artifact 题：zip 上传提交 -->
        <div v-else class="bg-white border border-border rounded-xl p-6">
          <div class="flex items-start justify-between gap-4">
            <div>
              <h2 class="text-base font-semibold text-text mb-1">提交产物（zip）</h2>
              <p class="text-sm text-text-secondary">
                请上传包含 <code class="font-mono text-primary">submission.py</code> 的 zip 压缩包，平台将在云端评测。
                大小上限：{{ formatMb(problem.artifact_max_size_mb) }}。
              </p>
            </div>
          </div>
          <div class="mt-4 flex flex-col gap-3">
            <input
              type="file"
              accept=".zip,application/zip,application/x-zip-compressed"
              class="block w-full text-sm text-text-secondary file:mr-3 file:rounded-md file:border-0 file:bg-signal file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-signal/80"
              @change="(e: Event) => artifactFile = (e.target as HTMLInputElement).files?.[0] ?? null"
            />
            <div v-if="artifactError" class="text-sm text-red-600">{{ artifactError }}</div>
            <div v-if="artifactSuccessId" class="text-sm text-green-600">
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
        </div>

        <div v-if="!isLoggedIn && !isArtifact" class="text-center text-sm text-text-muted">
          <NuxtLink to="/login" class="text-primary no-underline hover:underline">登录</NuxtLink>
          后即可提交代码
        </div>
        <section class="rounded-xl border border-border bg-white p-6">
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
          {{ publishBlockReason }}。通过本题后即可发布题解。
        </p>
      </section>
      </template>
    </div>
    </AsyncContent>
  </template>
</template>
