<template>
  <AuthFormCard
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
      <Transition name="slide">
        <div v-if="registeredMsg" class="bg-green-50 border border-green-200 text-green-700 rounded-md px-3.5 py-2.5 text-sm flex items-center justify-center gap-3 fixed top-[74px] left-1/2 -translate-x-1/2 z-[99] max-w-[380px] w-[calc(100%-48px)]">
          <span>{{ registeredMsg }}</span>
        </div>
      </Transition>
    </template>

    <!-- 被封禁 banner -->
    <template #banner-info>
      <Transition name="slide">
        <div v-if="bannedMsg" class="bg-red-50 border border-red-200 text-red-700 rounded-md px-3.5 py-2.5 text-sm flex items-center justify-center gap-3 fixed top-[74px] left-1/2 -translate-x-1/2 z-[99] max-w-[380px] w-[calc(100%-48px)]">
          <span>{{ bannedMsg }}</span>
        </div>
      </Transition>
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
        <User :size="18" />
      </template>
    </TextInput>

    <PasswordField
      id="password"
      v-model="form.password"
      label="密码"
      placeholder="请输入密码（仅字母和数字）"
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
</template>

<script setup lang="ts">
import { User } from "@lucide/vue"

definePageMeta({ layout: "auth" })

const router = useRouter()
const auth = useAuth()
const route = useRoute()
const { error, setError, clearError } = useFormError()

const form = reactive({ login: "", password: "" })
const loading = ref(false)

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
})

function validate(): boolean {
  let valid = true
  fieldErrors.login = ""
  fieldErrors.password = ""

  if (!form.login.trim()) {
    fieldErrors.login = "请输入用户名或邮箱"
    valid = false
  }

  if (!form.password) {
    fieldErrors.password = "请输入密码"
    valid = false
  }

  return valid
}

async function handleLogin() {
  if (!validate()) return

  loading.value = true
  try {
    const { user: loggedInUser } = await auth.login(form.login.trim(), form.password)
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
    setError(typeof e.data?.error === "string" ? e.data.error : `服务器错误 (${e.status || 502})`)
  } finally {
    loading.value = false
  }
}
</script>
