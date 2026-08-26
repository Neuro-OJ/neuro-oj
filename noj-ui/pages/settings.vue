<script setup lang="ts">
import { extractApiError } from "~/utils/apiError"
import { getAvatarUploadError } from "~/utils/avatarUpload"
import { formatRecoveryCodesFile } from "~/utils/recoveryCodes"
import { userUrl } from "~/utils/publicIdentifiers"
const { user, isLoggedIn, loading, fetchUser } = useAuth()
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

// 评审 P1 修复：进入设置页时从 /auth/me 拉取真实 TFA 状态。
// session cookie 只在登录时写入，若用户在本次会话中途启用/禁用 TFA，
// 刷新后 cookie 中的 tfa_enabled 已过期；这里以服务端为准刷新一次，
// 确保已启用用户能看到禁用/重新生成恢复码入口。
watch(
  loading,
  async (loadingVal) => {
    if (!loadingVal && isLoggedIn.value) {
      try {
        await fetchUser()
      } catch {
        // fetchUser 内部已处理 401 登出，其余错误静默保留本地会话
      }
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
const avatarError = ref("") // issue #314：超过 2MB 等校验错误内联展示，避免“没有反应”
const { dialog } = useDialog()
const { toast } = useToast()

// 上传头像（前端预校验类型/大小，与后端阈值一致）
async function handleAvatarUpload(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  avatarError.value = ""
  const validationError = getAvatarUploadError(file)
  if (validationError) {
    avatarError.value = validationError
    toast.error(validationError)
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
      { silent: true },
    )
    if (user.value) user.value.avatar_url = res.data.avatar_url
    avatarPreviewKey.value = Date.now()
    avatarError.value = ""
    toast.success("头像已更新")
  } catch (err: unknown) {
    avatarError.value = extractApiError(err).message
    toast.error(extractApiError(err).message)
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
        `/api/v1/users/${u.username}/profile`,
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

// ── TFA 管理（issue #228） ──
const tfaEnabled = ref(user.value?.tfa_enabled ?? false)
const tfaSetup = ref<{ secret: string; otpauth_url: string } | null>(null)
const tfaCode = ref("")
const tfaRecoveryCodes = ref<string[]>([])
const tfaLoading = ref(false)
const tfaError = ref("")
const qrDataUrl = ref("")
const tfaUserId = ref(user.value?.id ?? null)

function resetTfaTransientState() {
  tfaSetup.value = null
  tfaCode.value = ""
  tfaRecoveryCodes.value = []
  tfaError.value = ""
  qrDataUrl.value = ""
}

watch(
  user,
  (u) => {
    const nextUserId = u?.id ?? null
    if (nextUserId !== tfaUserId.value) {
      resetTfaTransientState()
      tfaUserId.value = nextUserId
    }
    tfaEnabled.value = u?.tfa_enabled ?? false
  },
  { immediate: true },
)

async function handleTfaSetup() {
  tfaLoading.value = true
  tfaError.value = ""
  try {
    const res = await api.post<{ data: { secret: string; otpauth_url: string } }>(
      "/api/v1/auth/tfa/setup",
      undefined,
    )
    tfaSetup.value = res.data
    tfaCode.value = ""
    tfaRecoveryCodes.value = []
    qrDataUrl.value = ""
    // 前端本地生成二维码，避免 secret 经过额外服务端处理
    const QRCode = (await import("qrcode")).default
    qrDataUrl.value = await QRCode.toDataURL(res.data.otpauth_url, {
      width: 200,
      margin: 1,
    })
  } catch (err: unknown) {
    tfaError.value = extractApiError(err).message
  } finally {
    tfaLoading.value = false
  }
}

async function handleTfaConfirm() {
  if (!tfaCode.value.trim()) {
    tfaError.value = "请输入 6 位验证码"
    return
  }
  tfaLoading.value = true
  tfaError.value = ""
  try {
    const res = await api.post<{ data: { recovery_codes: string[] } }>(
      "/api/v1/auth/tfa/confirm",
      { code: tfaCode.value.trim() },
    )
    tfaRecoveryCodes.value = res.data.recovery_codes
    tfaEnabled.value = true
    tfaSetup.value = null
    tfaCode.value = ""
    qrDataUrl.value = ""
    if (user.value) user.value.tfa_enabled = true
  } catch (err: unknown) {
    tfaError.value = extractApiError(err).message
  } finally {
    tfaLoading.value = false
  }
}

async function handleTfaDisable() {
  if (!tfaCode.value.trim()) {
    tfaError.value = "请输入验证码或恢复码"
    return
  }
  tfaLoading.value = true
  tfaError.value = ""
  try {
    await api.post("/api/v1/auth/tfa/disable", { code: tfaCode.value.trim() })
    tfaEnabled.value = false
    resetTfaTransientState()
    if (user.value) user.value.tfa_enabled = false
    toast.success("两步验证已禁用")
  } catch (err: unknown) {
    tfaError.value = extractApiError(err).message
  } finally {
    tfaLoading.value = false
  }
}

async function handleTfaRegenerate() {
  if (!tfaCode.value.trim()) {
    tfaError.value = "请输入验证码或恢复码"
    return
  }
  tfaLoading.value = true
  tfaError.value = ""
  try {
    const res = await api.post<{ data: { recovery_codes: string[] } }>(
      "/api/v1/auth/tfa/recovery-codes/regenerate",
      { code: tfaCode.value.trim() },
    )
    tfaRecoveryCodes.value = res.data.recovery_codes
    tfaCode.value = ""
    try {
      toast.success("恢复码已重新生成")
    } catch {
      // toast 异常不影响业务结果，静默忽略
    }
  } catch (err: unknown) {
    tfaError.value = extractApiError(err).message
  } finally {
    tfaLoading.value = false
  }
}

function handleDownloadRecoveryCodes() {
  if (tfaRecoveryCodes.value.length === 0) return

  // 清除上一次遗留的错误提示，避免“下载已成功但仍显示失败”
  tfaError.value = ""

  try {
    const content = formatRecoveryCodesFile(tfaRecoveryCodes.value)
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `neuro-oj-recovery-codes-${new Date().toISOString().slice(0, 10)}.txt`
    link.style.display = "none"
    document.body.appendChild(link)
    link.click()
    link.remove()
    // 稍后释放 URL，避免下载尚未开始时提前回收
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    try {
      toast.success("恢复码文件已下载")
    } catch {
      // toast 异常不影响下载结果，静默忽略
    }
  } catch {
    tfaError.value = "恢复码文件生成失败，请手动复制保存"
  }
}

async function handleCopyRecoveryCodes() {
  if (tfaRecoveryCodes.value.length === 0) return

  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable")
    await navigator.clipboard.writeText(tfaRecoveryCodes.value.join("\n"))
    toast.success("恢复码已复制")
  } catch {
    toast.error("复制失败，请手动复制恢复码")
  }
}
</script>

<template>
  <div class="max-w-[800px] mx-auto px-4 py-6 sm:px-6 sm:py-8 flex flex-col gap-6">
    <!-- 返回 -->
    <NuxtLink
      v-if="user?.id"
      :to="userUrl(user?.username ?? '')"
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
              :src="`/api/v1/users/${user.username}/avatar?t=${avatarPreviewKey}`"
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
            <p v-if="avatarError" class="text-xs text-error-text">{{ avatarError }}</p>
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

    <!-- 两步验证（TFA，issue #228） -->
    <div class="bg-white border border-border rounded-xl overflow-hidden">
      <div class="px-6 py-5 border-b border-border">
        <h1 class="text-xl font-bold flex items-center gap-2">
          <UIcon name="i-lucide-shield-check" class="size-5" />
          两步验证（TFA）
        </h1>
      </div>

      <div class="px-6 py-6 flex flex-col gap-4">
        <p class="text-sm text-text-secondary">
          启用后登录时需要输入验证器 App 生成的 6 位验证码或恢复码。
        </p>

        <div v-if="!tfaEnabled">
          <UButton
            v-if="!tfaSetup"
            color="primary"
            :loading="tfaLoading"
            @click="handleTfaSetup"
          >
            <UIcon name="i-lucide-qr-code" class="size-4" />
            启用两步验证
          </UButton>

          <div v-else class="flex flex-col gap-3">
            <img
              v-if="qrDataUrl"
              :src="qrDataUrl"
              alt="TFA 二维码"
              class="w-48 h-48 border border-border rounded-lg"
            />
            <div>
              <p class="text-xs text-text-muted">手动输入密钥：</p>
              <code class="text-sm font-mono break-all">{{ tfaSetup.secret }}</code>
            </div>
            <div class="flex items-center gap-2">
              <UInput
                v-model="tfaCode"
                placeholder="6 位验证码"
                class="max-w-xs"
              />
              <UButton color="primary" :loading="tfaLoading" @click="handleTfaConfirm">
                确认启用
              </UButton>
            </div>
          </div>
        </div>

        <div v-else class="flex flex-col gap-3">
          <p class="text-sm text-success-text font-semibold">已启用</p>
          <div class="flex items-center gap-2 flex-wrap">
            <UInput
              v-model="tfaCode"
              placeholder="验证码或恢复码"
              class="max-w-xs"
            />
            <UButton color="error" variant="outline" :loading="tfaLoading" @click="handleTfaDisable">
              禁用
            </UButton>
            <UButton color="neutral" variant="outline" :loading="tfaLoading" @click="handleTfaRegenerate">
              重新生成恢复码
            </UButton>
          </div>
        </div>

        <div
          v-if="tfaRecoveryCodes.length > 0"
          class="border border-border rounded-lg p-4 bg-page flex flex-col gap-2"
        >
          <p class="text-sm font-semibold">请立即保存以下恢复码，刷新页面后无法找回</p>
          <div class="grid grid-cols-2 gap-2">
            <code
              v-for="c in tfaRecoveryCodes"
              :key="c"
              class="font-mono text-sm bg-white border border-border rounded px-2 py-1"
            >{{ c }}</code>
          </div>
          <p class="text-xs text-text-muted">
            每个恢复码只能使用一次；重新生成后，旧恢复码全部失效。
          </p>
          <div class="flex flex-wrap gap-2">
            <UButton
              color="primary"
              variant="outline"
              size="sm"
              @click="handleDownloadRecoveryCodes"
            >
              <UIcon name="i-lucide-download" class="size-4" />
              下载恢复码文件
            </UButton>
            <UButton
              color="neutral"
              variant="outline"
              size="sm"
              @click="handleCopyRecoveryCodes"
            >
              <UIcon name="i-lucide-copy" class="size-4" />
              复制全部
            </UButton>
          </div>
        </div>

        <p v-if="tfaError" class="text-sm text-error-text">{{ tfaError }}</p>
      </div>
    </div>
  </div>
</template>
