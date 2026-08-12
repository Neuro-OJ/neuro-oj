<script setup lang="ts">
import type { Clarification, Contest, ContestProblem } from '~/composables/useContests'
import { extractApiError } from '~/utils/apiError'

const props = defineProps<{ contest: Contest; problems: ContestProblem[] }>()

const { user } = useAuth()
const toast = useToast()
const { listClarifications, askClarification, replyClarification } = useContests()

const clarifications = ref<Clarification[]>([])
const loading = ref(true)
const loadError = ref('')
const page = ref(1)
const total = ref(0)
const perPage = 20

// ── 提问表单 ───────────────────────────────────────────────────
const questionContent = ref('')
const questionProblemId = ref('')
const asking = ref(false)
const questionError = ref('')

// ── 回复表单（每个提问独立草稿，切换提问不丢失）─────────────
const replyDrafts = ref<Record<string, { content: string; isPublic: boolean }>>({})
const replyingTo = ref<string | null>(null)
const replying = ref(false)
const replyError = ref('')

// 获取（惰性初始化）某提问的回复草稿
function draftFor(clarId: string) {
  let draft = replyDrafts.value[clarId]
  if (!draft) {
    draft = { content: '', isPublic: true }
    replyDrafts.value[clarId] = draft
  }
  return draft
}

const canAsk = computed(() =>
  !!user.value && props.contest.status === 'running' && props.contest.is_registered === true,
)
const isManager = computed(() =>
  !!user.value && (user.value.is_admin || props.contest.created_by === user.value.id),
)

async function load(reset = true, silent = false) {
  if (reset) {
    page.value = 1
    if (!silent) loading.value = true
  }
  loadError.value = ''
  try {
    const result = await listClarifications(props.contest.id, { page: page.value, per_page: perPage })
    clarifications.value = reset
      ? result.data
      : [...clarifications.value, ...result.data]
    total.value = result.pagination?.total ?? clarifications.value.length
  } catch (fetchError: unknown) {
    loadError.value = extractApiError(fetchError).message
  } finally {
    loading.value = false
  }
}

async function loadMore() {
  if (clarifications.value.length >= total.value) return
  page.value += 1
  await load(false)
}

// 收到 notification:new 时静默刷新（答疑回复通知触发），替换而非追加数据
useEventSource({
  url: '/api/v1/community/notifications/events',
  enabled: computed(() => !!user.value),
  onEvent: {
    'notification:new': () => void load(true, true),
  },
  fetchFn: () => void load(true, true),
  fallbackIntervalMs: 30000,
})

async function submitQuestion() {
  const content = questionContent.value.trim()
  if (!content) {
    questionError.value = '提问内容不能为空'
    return
  }
  asking.value = true
  questionError.value = ''
  try {
    const result = await askClarification(props.contest.id, {
      content,
      problem_id: questionProblemId.value || undefined,
    })
    clarifications.value = [...clarifications.value, result.data]
    total.value += 1
    questionContent.value = ''
    questionProblemId.value = ''
    toast.showToast('success', '提问成功')
  } catch (submitError: unknown) {
    questionError.value = extractApiError(submitError).message
  } finally {
    asking.value = false
  }
}

async function submitReply(clarId: string) {
  const draft = draftFor(clarId)
  const content = draft.content.trim()
  if (!content) {
    replyError.value = '回复内容不能为空'
    return
  }
  replying.value = true
  replyError.value = ''
  try {
    const result = await replyClarification(props.contest.id, clarId, {
      content,
      is_public: draft.isPublic,
    })
    const target = clarifications.value.find((item) => item.id === clarId)
    if (target) target.replies.push(result.data)
    // 提交成功后清除该提问的草稿并收起回复表单
    delete replyDrafts.value[clarId]
    replyingTo.value = null
    toast.showToast('success', result.data.is_public ? '已公开回复' : '已私密回复')
  } catch (submitError: unknown) {
    replyError.value = extractApiError(submitError).message
  } finally {
    replying.value = false
  }
}

function isOwnQuestion(clarification: Clarification) {
  return !!user.value && clarification.sender.id === user.value.id
}

onMounted(() => void load())
</script>

<template>
  <div class="space-y-5">
    <div class="flex items-center justify-between">
      <h2 class="text-lg font-bold text-text">竞赛答疑</h2>
      <span class="text-xs text-text-muted">{{ total }} 条提问</span>
    </div>

    <!-- 提问表单：仅竞赛进行期间且已参赛用户可见 -->
    <form v-if="canAsk" class="rounded-xl border border-border bg-bg-page p-4" @submit.prevent="submitQuestion">
      <div class="mb-3 grid gap-3 sm:grid-cols-[220px_1fr]">
        <select v-model="questionProblemId" class="rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-primary">
          <option value="">全局提问</option>
          <option v-for="problem in problems" :key="problem.problem_id" :value="problem.problem_id">{{ problem.label }}. {{ problem.title }}</option>
        </select>
        <textarea
          v-model="questionContent"
          rows="3"
          maxlength="5000"
          class="w-full resize-y rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-primary"
          placeholder="描述你的疑问（可挂到具体题目，或选择全局提问）"
        />
      </div>
      <div class="flex items-center gap-3">
        <UButton type="submit" color="primary" class="gap-2" :disabled="asking"><UIcon name="i-lucide-send" class="size-4" />{{ asking ? '提交中...' : '提问' }}</UButton>
        <span class="text-xs text-text-muted">{{ questionContent.length }}/5000</span>
        <p v-if="questionError" class="text-xs text-error-text">{{ questionError }}</p>
      </div>
    </form>
    <p v-else-if="user && contest.status === 'running' && contest.is_registered === false" class="rounded-lg border border-border bg-bg-page px-4 py-3 text-xs text-text-muted">报名参赛后可在竞赛进行期间提问。</p>
    <p v-else-if="contest.status !== 'running'" class="rounded-lg border border-border bg-bg-page px-4 py-3 text-xs text-text-muted">竞赛非进行期间不可提问，可查看公开答疑。</p>

    <p v-if="loadError" class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-error-text">{{ loadError }}</p>
    <div v-else-if="loading" class="py-12 text-center text-sm text-text-muted">答疑加载中...</div>
    <div v-else-if="clarifications.length === 0" class="rounded-xl border border-dashed border-border py-12 text-center text-sm text-text-muted">暂无答疑，等待第一条提问。</div>

    <!-- 答疑流：提问 + 回复线程 -->
    <div v-else class="space-y-4">
      <div v-for="clarification in clarifications" :key="clarification.id" class="overflow-hidden rounded-xl border border-border bg-white">
        <div class="px-5 py-4">
          <div class="mb-2 flex flex-wrap items-center gap-2 text-xs">
            <UserIdentity :user="clarification.sender" size="sm" />
            <span class="rounded bg-bg-page px-1.5 py-0.5 text-text-muted">{{ clarification.problem_label ? `${clarification.problem_label} 题` : '全局' }}</span>
            <NuxtTime class="text-text-muted" :datetime="clarification.created_at" relative locale="zh-CN" />
          </div>
          <p class="whitespace-pre-wrap text-sm leading-6 text-text">{{ clarification.content }}</p>
        </div>

        <!-- 回复列表 -->
        <div v-if="clarification.replies.length" class="space-y-2 border-t border-border bg-bg-page/50 px-5 py-4">
          <div v-for="reply in clarification.replies" :key="reply.id" class="flex items-start gap-2.5">
            <span class="mt-1.5 size-1.5 shrink-0 rounded-full bg-text-muted" />
            <div class="min-w-0 flex-1">
              <div class="mb-1 flex flex-wrap items-center gap-2 text-xs">
                <UserIdentity :user="reply.sender" size="sm" />
                <span class="rounded px-1.5 py-0.5" :class="reply.is_public ? 'bg-green-50 text-success-text' : 'bg-amber-50 text-warning-text'">
                  <UIcon :name="reply.is_public ? 'i-lucide-globe' : 'i-lucide-lock'" class="size-3" />
                  {{ reply.is_public ? '公开' : isOwnQuestion(clarification) ? '仅你可见' : '私密' }}
                </span>
                <NuxtTime class="text-text-muted" :datetime="reply.created_at" relative locale="zh-CN" />
              </div>
              <p class="whitespace-pre-wrap text-sm leading-6 text-text-secondary">{{ reply.content }}</p>
            </div>
          </div>
        </div>

        <!-- 主办方回复表单 -->
        <div v-if="isManager" class="border-t border-border px-5 py-4">
          <template v-if="replyingTo === clarification.id">
            <textarea
              v-model="draftFor(clarification.id).content"
              rows="3"
              maxlength="5000"
              class="mb-2 w-full resize-y rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-primary"
              placeholder="输入回复内容"
            />
            <div class="flex flex-wrap items-center gap-3">
              <div class="flex items-center gap-1 rounded-lg border border-border bg-bg-page p-1 text-xs">
                <button type="button" class="rounded-md px-2.5 py-1.5" :class="draftFor(clarification.id).isPublic ? 'bg-white text-success-text shadow-sm' : 'text-text-muted'" @click="draftFor(clarification.id).isPublic = true"><UIcon name="i-lucide-globe" class="mr-1 size-3" />公开</button>
                <button type="button" class="rounded-md px-2.5 py-1.5" :class="!draftFor(clarification.id).isPublic ? 'bg-white text-warning-text shadow-sm' : 'text-text-muted'" @click="draftFor(clarification.id).isPublic = false"><UIcon name="i-lucide-lock" class="mr-1 size-3" />私密</button>
              </div>
              <UButton type="button" size="sm" color="primary" :disabled="replying" @click="submitReply(clarification.id)">{{ replying ? '提交中...' : '提交回复' }}</UButton>
              <UButton type="button" size="sm" variant="ghost" @click="replyingTo = null; replyError = ''">取消</UButton>
              <p v-if="replyError" class="text-xs text-error-text">{{ replyError }}</p>
            </div>
          </template>
          <UButton v-else type="button" size="sm" variant="outline" class="gap-1.5" @click="replyingTo = clarification.id; replyError = ''">
            <UIcon name="i-lucide-reply" class="size-3.5" />回复
          </UButton>
        </div>
      </div>

      <div v-if="clarifications.length < total" class="text-center">
        <UButton color="primary" variant="outline" :disabled="loading" @click="loadMore">{{ loading ? '加载中...' : '加载更多' }}</UButton>
      </div>
    </div>
  </div>
</template>
