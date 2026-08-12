<script setup lang="ts">
import { extractApiError } from "~/utils/apiError"
const { user, isLoggedIn, loading } = useAuth()
const router = useRouter()
const { api } = useApi()

// 认证守卫：loading 就绪后检查登录状态
watch(
  loading,
  (loadingVal) => {
    if (!loadingVal && !isLoggedIn.value) {
      router.replace("/login")
    }
  },
  { immediate: true },
)

// Bio 编辑
const bio = ref("")
const previewMode = ref(false)
const saving = ref(false)
const saveSuccess = ref(false)
const saveError = ref("")

// 头像管理（issue #229）
const avatarUploading = ref(false)
const avatarInput = ref<HTMLInputElement | null>(null)
const avatarPreviewKey = ref(Date.now()) // 上传/删除后破缓存
const { dialog } = useDialog()
const { toast } = useToast()

// 上传头像（前端预校验类型/大小，与后端阈值一致）
async function handleAvatarUpload(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  if (
    !/\.(png|jpe?g|webp)$/i.test(file.name) ||
    !["image/png", "image/jpeg", "image/webp"].includes(file.type)
  ) {
    toast.error("仅支持 png/jpeg/webp 图片")
    input.value = ""
    return
  }
  if (file.size > 2 * 1024 * 1024) {
    toast.error("头像大小超过限制（最大 2MB）")
    input.value = ""
    return
  }
  avatarUploading.value = true
  try {
    const fd = new FormData()
    fd.append("file", file)
    const res = await api.post<{ data: { avatar_url: string } }>(
      "/api/v1/users/me/avatar",
      fd,
    )
    if (user.value) user.value.avatar_url = res.data.avatar_url
    avatarPreviewKey.value = Date.now()
    toast.success("头像已更新")
  } finally {
    avatarUploading.value = false
    input.value = ""
  }
}

// 删除头像（弹确认框）
async function handleAvatarDelete() {
  const ok = await dialog.confirm("确定删除头像吗？将恢复为默认头像。")
  if (!ok) return
  await api.delete("/api/v1/users/me/avatar")
  if (user.value) user.value.avatar_url = null
  avatarPreviewKey.value = Date.now()
  toast.success("头像已删除")
}

// 加载当前用户 bio（等 user 就绪后再请求，避免 fetchUser 未完成）
watch(
  user,
  async (u) => {
    if (!u?.id) return
    try {
      const res = await api.get<{ data: { user: { bio: string } } }>(
        `/api/v1/users/${u.id}/profile`,
        { silent: true },
      )
      bio.value = res.data.user.bio || ""
    } catch {
      // 静默失败
    }
  },
  { immediate: true },
)

async function handleSave() {
  if (!isLoggedIn.value) return
  saving.value = true
  saveSuccess.value = false
  saveError.value = ""
  try {
    await api.put("/api/v1/users/me", { bio: bio.value })
    saveSuccess.value = true
    setTimeout(() => { saveSuccess.value = false }, 3000)
  } catch (err: unknown) {
    saveError.value = extractApiError(err).message
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="max-w-[800px] mx-auto px-4 py-6 sm:px-6 sm:py-8 flex flex-col gap-6">
    <!-- 返回 -->
    <NuxtLink
      v-if="user?.id"
      :to="`/users/${user.id}`"
      class="inline-flex items-center gap-1.5 text-sm text-text-secondary no-underline hover:text-primary"
    >
      <UIcon name="i-lucide-arrow-left" class="size-4" />
      返回个人主页
    </NuxtLink>

    <!-- 标题 -->
    <div class="bg-white border border-border rounded-xl overflow-hidden">
      <div class="px-6 py-5 border-b border-border">
        <h1 class="text-xl font-bold flex items-center gap-2">
          <UIcon name="i-lucide-edit-3" class="size-5" />
          个人资料编辑
        </h1>
      </div>

      <div class="px-6 py-6 flex flex-col gap-6">
        <!-- 头像管理（issue #229） -->
        <div class="flex items-center gap-6 pb-4 border-b border-border">
          <span class="relative inline-block rounded-full overflow-hidden shrink-0" :style="{ width: '64px', height: '64px' }">
            <img
              v-if="user?.avatar_url"
              :src="`/api/v1/users/${user.id}/avatar?t=${avatarPreviewKey}`"
              alt="当前头像"
              class="size-full object-cover"
            />
            <span
              v-else
              class="size-full flex items-center justify-center text-xl font-bold"
              :style="{ backgroundColor: 'hsl(0 0% 92%)', color: 'hsl(0 0% 40%)' }"
            >{{ user?.username?.charAt(0).toUpperCase() || "?" }}</span>
          </span>
          <div class="flex flex-col gap-2">
            <div class="flex items-center gap-3">
              <UButton color="primary" variant="outline" :loading="avatarUploading" @click="avatarInput?.click()">
                <UIcon name="i-lucide-upload" class="size-4" />
                上传头像
              </UButton>
              <UButton v-if="user?.avatar_url" color="error" variant="outline" @click="handleAvatarDelete">
                <UIcon name="i-lucide-trash-2" class="size-4" />
                删除头像
              </UButton>
              <input ref="avatarInput" type="file" accept="image/png,image/jpeg,image/webp" class="hidden" @change="handleAvatarUpload" />
            </div>
            <p class="text-xs text-text-muted">支持 png / jpeg / webp，最大 2MB</p>
          </div>
        </div>

        <!-- 基本信息（只读） -->
        <div class="flex items-center gap-3 pb-4 border-b border-border">
          <div class="w-12 h-12 rounded-full bg-primary-bg flex items-center justify-center text-primary text-xl font-bold shrink-0">
            {{ user?.username?.charAt(0).toUpperCase() || "?" }}
          </div>
          <div class="flex flex-col">
            <span class="font-semibold text-text">{{ user?.username }}</span>
            <span class="text-xs text-text-muted">{{ user?.email }}</span>
          </div>
        </div>

        <!-- Bio 编辑区 -->
        <div class="flex flex-col gap-3">
          <div class="flex items-center justify-between">
            <label class="text-sm font-semibold text-text">个人简介</label>
            <UButton color="neutral" variant="outline" class="text-xs px-3 py-1.5 flex items-center gap-1.5 text-text-secondary border border-border bg-transparent rounded-md cursor-pointer hover:bg-gray-100 hover:text-text transition-colors" @click="previewMode = !previewMode">
              <UIcon name="i-lucide-eye" class="size-3.5" v-if="!previewMode"/>
              <UIcon name="i-lucide-edit-3" class="size-3.5" v-else/>
              {{ previewMode ? "编辑" : "预览" }}
            </UButton>
          </div>

          <!-- 编辑器 -->
          <textarea
            v-if="!previewMode"
            v-model="bio"
            class="w-full min-h-[200px] px-4 py-3 border border-border rounded-lg text-sm font-mono leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
            placeholder="用 Markdown 介绍自己..."
            maxlength="5000"
          />

          <!-- 预览（Markdown 渲染） -->
          <div
            v-else
            class="min-h-[200px] px-4 py-3 border border-border rounded-lg bg-white"
          >
            <MarkdownRenderer v-if="bio.trim()" :content="bio" />
            <p v-else class="text-text-muted text-sm italic">暂无个人简介</p>
          </div>

          <div class="flex items-center justify-between text-xs text-text-muted">
            <span>支持 Markdown 格式，最多 5000 字</span>
            <span>{{ bio.length }} / 5000</span>
          </div>
        </div>

        <!-- 保存按钮 -->
        <UButton color="primary" class="flex items-center justify-center gap-2 py-2.5 px-6 self-start text-sm disabled:opacity-50 disabled:cursor-not-allowed" :disabled="saving"
          @click="handleSave">
          <UIcon name="i-lucide-save" class="size-4" />
          <span>{{ saving ? "保存中..." : "保存" }}</span>
        </UButton>
      </div>
    </div>
  </div>
</template>
