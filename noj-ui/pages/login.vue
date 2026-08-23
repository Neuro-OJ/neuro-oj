<template>
  <AuthFormCard
    v-if="!tfaRequired"
    title="登录"
    :error="error"
    :loading="loading"
    submit-label="登录"
    loading-label="登录"
    @submit="handleLogin"
    @clear-error="clearError"
  >
    <!-- 注册成功/密码重置成功 banner -->
    <template #banner-success>
      <ToastBanner :visible="!!registeredMsg" color="success" icon="i-lucide-check-circle" :message="registeredMsg" @close="registeredMsg = ''" />
    </template>

    <!-- 被封禁 banner -->
    <template #banner-info>
      <ToastBanner :visible="!!bannedMsg" color="error" icon="i-lucide-ban" :message="bannedMsg" @close="bannedMsg = ''" />
    </template>

    <TextInput
      id="login"
      v-model="form.login"
      label="用户名 / 邮箱"
      placeholder="请输入用户名或邮箱"
      autocomplete="username"
      :disabled="loading"
      :error="fieldErrors.login"
      @focus="fieldErrors.login = ''"
    >
      <template #icon>
        <UIcon name="i-lucide-user" class="size-4.5" />
      </template>
    </TextInput>

    <PasswordField
      id="password"
      v-model="form.password"
      label="密码"
      placeholder="至少 8 位，需包含字母和数字"
      autocomplete="current-password"
      :disabled="loading"
      :error="fieldErrors.password"
      @focus="fieldErrors.password = ''"
    />

    <template #footer>
      <p class="mb-2">
        还没有账号？<NuxtLink to="/register" class="text-primary no-underline font-semibold hover:underline">立即注册</NuxtLink>
      </p>
      <p>
        <NuxtLink to="/forgot-password" class="text-primary no-underline font-semibold hover:underline">忘记密码？</NuxtLink>
      </p>
    </template>
  </AuthFormCard>

  <AuthFormCard
    v-else
    title="两步验证（2FA）"
    :subtitle="`账号：${form.login.trim()}`"
    :error="error"
    :loading="loading"
    submit-label="验证并登录"
    loading-label="验证中"
    @submit="handleLogin"
    @clear-error="clearError"
  >
    <!-- 被封禁 banner -->
    <template #banner-info>
      <ToastBanner :visible="!!bannedMsg" color="error" icon="i-lucide-ban" :message="bannedMsg" @close="bannedMsg = ''" />
    </template>

    <div class="rounded-md bg-page border border-border px-4 py-3">
      <p v-if="!recoveryMode" class="text-sm text-text-secondary">账号已启用两步验证，请输入6位动态验证码验证身份</p>
      <p v-else class="text-sm text-text-secondary">账号已启用两步验证，请输入恢复码或上传恢复码文件验证身份</p>
    </div>

    <TextInput
      v-if="!recoveryMode"
      id="code"
      v-model="form.code"
      label="动态验证码"
      placeholder="请输入6位验证码"
      autocomplete="one-time-code"
      :disabled="loading"
      :error="fieldErrors.code"
      @focus="fieldErrors.code = ''"
    >
      <template #icon>
        <UIcon name="i-lucide-shield-check" class="size-4.5" />
      </template>
    </TextInput>

    <div v-if="!recoveryMode" class="flex justify-center">
      <UButton
        type="button"
        color="neutral"
        variant="link"
        :disabled="loading"
        @click="enterRecoveryMode"
      >
        使用恢复码登录
      </UButton>
    </div>

    <template v-else>
      <TextInput
        id="code"
        v-model="form.code"
        label="恢复码"
        placeholder="请输入恢复码"
        autocomplete="off"
        :disabled="loading"
        :error="fieldErrors.code"
        @focus="fieldErrors.code = ''"
      >
        <template #icon>
          <UIcon name="i-lucide-key-round" class="size-4.5" />
        </template>
      </TextInput>

      <div class="flex flex-col gap-2">
        <div class="flex items-center gap-3">
          <UButton
            type="button"
            color="neutral"
            variant="outline"
            :disabled="loading"
            @click="recoveryCodeFileInput?.click()"
          >
            <UIcon name="i-lucide-file-up" class="size-4" />
            从文件导入恢复码
          </UButton>
          <input
            ref="recoveryCodeFileInput"
            type="file"
            accept=".txt,text/plain"
            class="hidden"
            @change="handleRecoveryCodeFileChange"
          />
        </div>
        <p class="text-xs text-text-muted">
          文件只在本地读取，不会上传；请选择一个恢复码后再提交登录。
        </p>
        <div v-if="recoveryFileCodes.length > 0" class="flex flex-col gap-2">
          <p class="text-xs text-text-secondary">已读取 {{ recoveryFileCodes.length }} 个恢复码，请选择一个：</p>
          <div class="flex flex-wrap gap-2">
            <UButton
              v-for="code in recoveryFileCodes"
              :key="code"
              type="button"
              color="neutral"
              variant="outline"
              size="sm"
              :class="form.code === code ? 'ring-2 ring-primary' : ''"
              @click="selectRecoveryCode(code)"
            >
              {{ code }}
            </UButton>
          </div>
        </div>
        <p v-if="recoveryFileError" class="text-sm text-error-text">{{ recoveryFileError }}</p>
      </div>

      <div class="flex justify-center">
        <UButton
          type="button"
          color="neutral"
          variant="link"
          :disabled="loading"
          @click="useTotpMode"
        >
          使用动态验证码登录
        </UButton>
      </div>
    </template>

    <template #footer>
      <UButton
        type="button"
        color="neutral"
        variant="link"
        :disabled="loading"
        @click="returnToLoginStep"
      >
        <UIcon name="i-lucide-arrow-left" class="size-4" />
        返回登录
      </UButton>
    </template>
  </AuthFormCard>
</template>

<script setup lang="ts">
import { extractApiError } from "~/utils/apiError"
import {
  assertRecoveryCodeFileSize,
  parseRecoveryCodesFile,
} from "~/utils/recoveryCodes"

definePageMeta({ layout: "auth" })

const router = useRouter()
const auth = useAuth()
const route = useRoute()
const { error, setError, clearError } = useFormError()

const form = reactive({ login: "", password: "", code: "" })
const loading = ref(false)
const tfaRequired = ref(false)
const recoveryMode = ref(false)
const recoveryCodeFileInput = ref<HTMLInputElement | null>(null)
const recoveryFileCodes = ref<string[]>([])
const recoveryFileError = ref("")

// 注册成功后的提示
const registeredMsg = ref("")
const bannedMsg = ref("")
if (route.query.registered === "1") {
  registeredMsg.value = "注册成功，请登录"
} else if (route.query.reset === "1") {
  // issue #49：密码重置成功 banner
  registeredMsg.value = "密码重置成功，请登录"
}

const fieldErrors = reactive({
  login: "",
  password: "",
  code: "",
})

function selectRecoveryCode(code: string) {
  form.code = code
  fieldErrors.code = ""
  recoveryFileError.value = ""
}

function resetTfaStep() {
  form.code = ""
  fieldErrors.code = ""
  recoveryMode.value = false
  recoveryFileCodes.value = []
  recoveryFileError.value = ""
  clearError()
}

function enterRecoveryMode() {
  form.code = ""
  fieldErrors.code = ""
  recoveryFileCodes.value = []
  recoveryFileError.value = ""
  recoveryMode.value = true
  clearError()
}

function useTotpMode() {
  form.code = ""
  fieldErrors.code = ""
  recoveryFileCodes.value = []
  recoveryFileError.value = ""
  recoveryMode.value = false
  clearError()
}

function returnToLoginStep() {
  resetTfaStep()
  tfaRequired.value = false
}

async function handleRecoveryCodeFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  recoveryFileError.value = ""
  if (!file) return

  try {
    assertRecoveryCodeFileSize(file.size)
    recoveryFileCodes.value = parseRecoveryCodesFile(await file.text())
  } catch (err: unknown) {
    recoveryFileCodes.value = []
    recoveryFileError.value = err instanceof Error
      ? err.message
      : "恢复码文件读取失败，请检查文件内容"
  } finally {
    // 清空 input，允许用户再次选择同一个文件。
    input.value = ""
  }
}

function validate(): boolean {
  let valid = true
  fieldErrors.login = ""
  fieldErrors.password = ""
  fieldErrors.code = ""

  if (tfaRequired.value) {
    if (!form.code.trim()) {
      fieldErrors.code = recoveryMode.value ? "请输入恢复码" : "请输入6位验证码"
      valid = false
    }
  } else {
    if (!form.login.trim()) {
      fieldErrors.login = "请输入用户名或邮箱"
      valid = false
    }

    if (!form.password) {
      fieldErrors.password = "请输入密码"
      valid = false
    }
  }

  return valid
}

async function handleLogin() {
  if (!validate()) return

  loading.value = true
  try {
    const { user: loggedInUser } = await auth.login(
      form.login.trim(),
      form.password,
      tfaRequired.value ? form.code.trim() : undefined,
    )
    // issue #75：临时引导管理员首次登录必须改密
    if (loggedInUser?.must_change_password === true) {
      router.replace("/change-password")
    } else {
      router.replace("/")
    }
  } catch (e: any) {
    // ban-status-endpoint：被封用户直接 inline 显示 banner，不用 URL 跳转
    if (e.data?.code === "USER_BANNED") {
      const reason = e.data.reason || "";
      const until = e.data.until || "";
      bannedMsg.value = until
        ? `账号已被封禁至 ${until}。${reason ? `原因：${reason}。` : ""}请联系管理员。`
        : `账号已被封禁。${reason ? `原因：${reason}。` : ""}请联系管理员。`;
      return;
    }
    // TFA：密码已通过，提示输入第二步验证码
    if (e.data?.code === "TFA_REQUIRED") {
      resetTfaStep()
      tfaRequired.value = true
      clearError()
      return;
    }
    setError(extractApiError(e).message)
  } finally {
    loading.value = false
  }
}
</script>
