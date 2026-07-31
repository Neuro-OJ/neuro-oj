<script setup lang="ts">
import {
  Heart,
  Bookmark,
  Send,
  Pencil,
  Trash2,
  Eye,
  Edit3,
  Lock,
} from "@lucide/vue"
import type {
  CommentRow,
  CommunityPost,
  PostType,
} from "~/composables/useCommunity"

const route = useRoute()
const { isLoggedIn, user } = useAuth()
const { config, loadConfig } = useCommunity()
const { toast } = useToast()
const { dialog } = useDialog()

interface PostDetail {
  post: CommunityPost
  author: { id: string; username: string }
  problem_title: string | null
  likes: number
  liked: boolean
  bookmarked: boolean
}

const typeLabel: Record<PostType, string> = {
  discussion: "讨论",
  solution: "题解",
  moment: "动态",
}

const postId = computed(() => String(route.params.postId))
const post = ref<PostDetail | null>(null)
const comments = ref<CommentRow[]>([])
const comment = ref("")
const interaction = ref<"like" | "bookmark" | null>(null)
const submittingComment = ref(false)

const replyingTo = ref<string | null>(null)
const replyContent = ref("")
const submittingReply = ref(false)

const editingPost = ref(false)
const editTitle = ref("")
const editContent = ref("")
const editPreview = ref(false)
const savingPost = ref(false)

const currentUserId = computed(() => user.value?.id)
const canReact = computed(
  () => isLoggedIn.value && config.value?.reactions_enabled === true &&
    config.value.permissions.react === true,
)
const canBookmark = computed(
  () => isLoggedIn.value && config.value?.bookmarks_enabled === true,
)
const canComment = computed(
  () => isLoggedIn.value && config.value?.comments_enabled === true &&
    config.value.permissions.comment === true,
)
const canModerate = computed(() => config.value?.permissions.moderate === true)
const isAuthor = computed(() => post.value?.post.author_id === currentUserId.value)
const canEditPost = computed(() => isAuthor.value || canModerate.value)
const commentMaxLength = computed(() => config.value?.comment_max_length ?? 1000)

const rootComments = computed(() =>
  comments.value.filter((c) => !c.comment.parent_id),
)
function repliesOf(parentId: string): CommentRow[] {
  return comments.value.filter((c) => c.comment.parent_id === parentId)
}
function canEditComment(row: CommentRow): boolean {
  return row.author.id === currentUserId.value || canModerate.value
}

async function load() {
  const [postResult, commentResult] = await Promise.all([
    $fetch<{ data: PostDetail }>(`/api/v1/community/posts/${postId.value}`),
    $fetch<{ data: CommentRow[] }>(`/api/v1/community/posts/${postId.value}/comments`),
  ])
  post.value = postResult.data
  comments.value = commentResult.data
}

async function toggle(kind: "like" | "bookmark", path: string) {
  if (!isLoggedIn.value) return navigateTo("/login")
  if ((kind === "like" ? !canReact.value : !canBookmark.value) || interaction.value) return
  interaction.value = kind
  try {
    await $fetch(path, { method: "POST" })
    await load()
  } catch (err: unknown) {
    toast.error(err instanceof Error ? err.message : "操作失败")
  } finally {
    interaction.value = null
  }
}

async function sendComment() {
  const content = comment.value.trim()
  if (!content || !canComment.value || submittingComment.value) return
  submittingComment.value = true
  try {
    await $fetch(`/api/v1/community/posts/${postId.value}/comments`, { method: "POST", body: { content } })
    comment.value = ""
    await load()
  } catch (err: unknown) {
    toast.error(err instanceof Error ? err.message : "评论失败")
  } finally {
    submittingComment.value = false
  }
}

function startReply(parentId: string) {
  replyingTo.value = replyingTo.value === parentId ? null : parentId
  replyContent.value = ""
}
async function sendReply(parentId: string) {
  const content = replyContent.value.trim()
  if (!content || !canComment.value || submittingReply.value) return
  submittingReply.value = true
  try {
    await $fetch(`/api/v1/community/posts/${postId.value}/comments`, {
      method: "POST",
      body: { content, parent_id: parentId },
    })
    replyContent.value = ""
    replyingTo.value = null
    await load()
  } catch (err: unknown) {
    toast.error(err instanceof Error ? err.message : "回复失败")
  } finally {
    submittingReply.value = false
  }
}

async function saveEditComment(id: string, contentInput: string) {
  const content = contentInput.trim()
  if (!content) return
  try {
    await $fetch(`/api/v1/community/comments/${id}`, {
      method: "PATCH",
      body: { content },
    })
    toast.success("评论已更新")
    await load()
  } catch (err: unknown) {
    toast.error(err instanceof Error ? err.message : "编辑失败")
  }
}

async function removeComment(id: string) {
  const ok = await dialog.confirm("确定删除这条评论吗？删除后不可恢复。", {
    title: "删除评论",
    danger: true,
    confirmText: "删除",
  })
  if (!ok) return
  try {
    await $fetch(`/api/v1/community/comments/${id}`, { method: "DELETE" })
    toast.success("评论已删除")
    await load()
  } catch (err: unknown) {
    toast.error(err instanceof Error ? err.message : "删除失败")
  }
}

function startEditPost() {
  editTitle.value = post.value?.post.title ?? ""
  editContent.value = post.value?.post.content ?? ""
  editPreview.value = false
  editingPost.value = true
}
async function saveEditPost() {
  if (savingPost.value || !editContent.value.trim()) return
  savingPost.value = true
  try {
    const body: Record<string, string | null> = { content: editContent.value }
    if (post.value?.post.type !== "moment") body.title = editTitle.value.trim() || null
    await $fetch(`/api/v1/community/posts/${postId.value}`, {
      method: "PATCH",
      body,
    })
    toast.success("内容已更新")
    editingPost.value = false
    await load()
  } catch (err: unknown) {
    toast.error(err instanceof Error ? err.message : "保存失败")
  } finally {
    savingPost.value = false
  }
}
async function deletePost() {
  const ok = await dialog.confirm("确定删除这篇内容吗？删除后不可恢复。", {
    title: "删除内容",
    danger: true,
    confirmText: "删除",
  })
  if (!ok) return
  try {
    await $fetch(`/api/v1/community/posts/${postId.value}`, { method: "DELETE" })
    toast.success("内容已删除")
    navigateTo("/community")
  } catch (err: unknown) {
    toast.error(err instanceof Error ? err.message : "删除失败")
  }
}

await loadConfig()
await load()
</script>

<template>
  <main class="mx-auto w-full max-w-4xl px-6 py-10">
    <NuxtLink to="/community" class="text-sm text-text-secondary hover:text-primary">← 返回社区</NuxtLink>
    <article v-if="post" class="mt-4 rounded-lg border border-border bg-white p-6 shadow-card">
      <template v-if="post.post.status === 'deleted'">
        <p class="py-8 text-center text-text-secondary">该内容已删除。</p>
      </template>
      <template v-else>
        <div class="mb-5 flex flex-wrap items-center justify-between gap-4">
          <div class="flex flex-wrap items-center gap-2">
            <NuxtLink :to="`/users/${post.author.id}`" class="font-medium text-text hover:text-primary">{{ post.author.username }}</NuxtLink>
            <span class="rounded bg-primary-bg px-2 py-0.5 text-xs text-primary">{{ typeLabel[post.post.type] }}</span>
            <NuxtLink v-if="post.post.type === 'solution' && post.post.problem_id" :to="`/problems/${post.post.problem_id}`" class="inline-flex items-center gap-1 text-xs text-primary hover:underline">{{ post.problem_title ?? '关联题目' }} →</NuxtLink>
            <span v-if="post.post.status === 'pending'" class="rounded bg-yellow-100 px-2 py-0.5 text-xs text-yellow-800">审核中</span>
            <span v-if="post.post.status === 'hidden'" class="rounded bg-red-50 px-2 py-0.5 text-xs text-red-700">已隐藏</span>
            <span v-if="post.post.is_locked" class="inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-0.5 text-xs text-text-secondary"><Lock :size="10" />已锁定</span>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <p class="text-xs text-text-secondary"><NuxtTime :datetime="post.post.created_at" locale="zh-CN" year="numeric" month="short" day="numeric" hour="2-digit" minute="2-digit" /></p>
            <button v-if="canEditPost" class="btn-outline text-xs" type="button" @click="startEditPost"><Pencil :size="14" />编辑</button>
            <button v-if="canEditPost" class="btn-outline text-xs text-red-600" type="button" @click="deletePost"><Trash2 :size="14" />删除</button>
          </div>
        </div>

        <template v-if="editingPost">
          <input v-if="post.post.type !== 'moment'" v-model="editTitle" class="mb-3 w-full rounded border border-border px-3 py-2" placeholder="标题" />
          <div class="mb-2 flex items-center justify-end">
            <button type="button" class="inline-flex items-center gap-1 rounded border border-border px-2.5 py-1 text-xs text-text-secondary hover:bg-primary-bg" @click="editPreview = !editPreview">
              <Eye v-if="!editPreview" :size="14" />
              <Edit3 v-else :size="14" />
              {{ editPreview ? "编辑" : "预览" }}
            </button>
          </div>
          <textarea v-if="!editPreview" v-model="editContent" class="min-h-40 w-full rounded border border-border px-3 py-2" required />
          <div v-else class="min-h-40 rounded border border-border px-3 py-2">
            <MarkdownRenderer v-if="editContent.trim()" :content="editContent" />
            <p v-else class="text-sm text-text-muted">暂无内容</p>
          </div>
          <div class="mt-3 flex justify-end gap-2">
            <button class="btn-outline" type="button" :disabled="savingPost" @click="editingPost = false">取消</button>
            <button class="btn-primary" :disabled="savingPost || !editContent.trim()" @click="saveEditPost">{{ savingPost ? '保存中…' : '保存' }}</button>
          </div>
        </template>
        <template v-else>
          <h1 v-if="post.post.title" class="mb-5 text-2xl font-bold">{{ post.post.title }}</h1>
          <MarkdownRenderer :content="post.post.content" :allow-external-images="config?.external_images_enabled === true" />
        </template>

        <div class="mt-6 flex gap-3 border-t border-border pt-4">
          <button class="btn-outline" aria-label="点赞" :class="{ 'border-primary bg-primary-bg text-primary': post.liked }" :disabled="!canReact || interaction !== null" @click="toggle('like', `/api/v1/community/posts/${post.post.id}/like`)"><Heart :size="16" />{{ interaction === 'like' ? '处理中…' : post.likes }}</button>
          <button class="btn-outline" aria-label="收藏" :class="{ 'border-primary bg-primary-bg text-primary': post.bookmarked }" :disabled="!canBookmark || interaction !== null" @click="toggle('bookmark', `/api/v1/community/posts/${post.post.id}/bookmark`)"><Bookmark :size="16" />{{ interaction === 'bookmark' ? '处理中…' : post.bookmarked ? '已收藏' : '收藏' }}</button>
        </div>
      </template>
    </article>

    <section v-if="post && post.post.status !== 'deleted'" class="mt-6">
      <h2 class="mb-4 text-xl font-bold">评论</h2>
      <form v-if="canComment" class="mb-5 flex flex-col gap-2" @submit.prevent="sendComment">
        <textarea v-model="comment" class="min-h-20 w-full rounded border border-border px-3 py-2" :placeholder="`写下你的想法（最长 ${commentMaxLength} 字符）`" />
        <div class="flex items-center justify-between gap-2">
          <p class="text-xs text-text-muted">{{ comment.length }} / {{ commentMaxLength }}</p>
          <button class="btn-primary" :disabled="submittingComment || !comment.trim() || comment.length > commentMaxLength"><Send :size="16" />{{ submittingComment ? '发送中…' : '发送' }}</button>
        </div>
      </form>
      <p v-else-if="isLoggedIn && config?.comments_enabled" class="mb-5 rounded-md bg-primary-bg px-3 py-2 text-sm text-primary-text">当前账号没有评论权限。</p>

      <div v-if="rootComments.length === 0" class="rounded-lg border border-dashed border-border p-10 text-center text-text-secondary">还没有评论，来抢沙发吧。</div>
      <div class="space-y-3">
        <article v-for="item in rootComments" :key="item.comment.id" class="rounded border border-border bg-white p-4">
          <CommentCard
            :row="item"
            :can-comment="canComment"
            :can-edit="canEditComment(item)"
            :comment-max-length="commentMaxLength"
            @start-reply="startReply(item.comment.id)"
            @save-edit="(c) => saveEditComment(item.comment.id, c)"
            @remove="removeComment(item.comment.id)"
          >
            <template v-if="replyingTo === item.comment.id">
              <form class="mt-3 flex gap-2" @submit.prevent="sendReply(item.comment.id)">
                <input v-model="replyContent" class="flex-1 rounded border border-border px-3 py-2" placeholder="回复这条评论">
                <button class="btn-primary text-sm" :disabled="submittingReply || !replyContent.trim()"><Send :size="14" />{{ submittingReply ? '发送中…' : '回复' }}</button>
              </form>
            </template>
          </CommentCard>
          <div v-for="reply in repliesOf(item.comment.id)" :key="reply.comment.id" class="ml-6 mt-3 border-l-2 border-border pl-4">
            <CommentCard
              :row="reply"
              :can-comment="false"
              :can-edit="canEditComment(reply)"
              :comment-max-length="commentMaxLength"
              @save-edit="(c) => saveEditComment(reply.comment.id, c)"
              @remove="removeComment(reply.comment.id)"
            />
          </div>
        </article>
      </div>
    </section>
  </main>
</template>
