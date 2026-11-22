<template>
  <div class="w-full max-w-[380px] relative">
    <ToastBanner :visible="!!error" color="error" icon="i-lucide-alert-circle" :message="error"
      @close="clearError" />

    <div class="bg-white border border-border noj-panel p-8">
      <h1 class="text-22px font-bold text-center mb-6 text-text">重置密码</h1>

      <form @submit.prevent="handleSubmit">
        <div class="relative mb-7">
          <label for="password"
            class="block text-sm font-semibold text-text mb-1">新密码 <span class="text-error-text">*</span></label>
          <UInput
            id="password"
            v-model="form.password"
            :type="showPassword ? 'text' : 'password'"
            icon="i-lucide-lock"
            placeholder="至少 8 位，需包含大小写字母和数字"
            autocomplete="new-password"
            :disabled="loading"
            class="w-full"
            @focus="fieldErrors.password = ''"
          >
            <template #trailing>
              <UButton type="button" square size="xs" variant="ghost" color="neutral" tabindex="-1"
                class="text-text-muted hover:text-text-secondary"
                :icon="showPassword ? 'i-lucide-eye' : 'i-lucide-eye-off'"
                :aria-label="showPassword ? '隐藏密码' : '显示密码'"
                @click="showPassword = !showPassword" />
            </template>
          </UInput>
          <Transition name="drop">
            <div v-if="fieldErrors.password"
              class="absolute top-[calc(100%+4px)] left-0 right-0 flex items-center justify-between gap-1 text-13px text-error-text"><span>{{ fieldErrors.password }}</span><UIcon name="i-lucide-x" class="size-3.5" /></div>
          </Transition>
        </div>

        <div class="relative mb-7">
          <label for="confirmPassword"
            class="block text-sm font-semibold text-text mb-1">确认密码 <span class="text-error-text">*</span></label>
          <UInput
            id="confirmPassword"
            v-model="form.confirmPassword"
            :type="showConfirmPassword ? 'text' : 'password'"
            icon="i-lucide-lock"
            placeholder="再次输入新密码"
            autocomplete="new-password"
            :disabled="loading"
            class="w-full"
            @focus="fieldErrors.confirmPassword = ''"
          >
            <template #trailing>
              <UButton type="button" square size="xs" variant="ghost" color="neutral" tabindex="-1"
                class="text-text-muted hover:text-text-secondary"
                :icon="showConfirmPassword ? 'i-lucide-eye' : 'i-lucide-eye-off'"
                :aria-label="showConfirmPassword ? '隐藏密码' : '显示密码'"
                @click="showConfirmPassword = !showConfirmPassword" />
            </template>
          </UInput>
          <Transition name="drop">
            <div v-if="fieldErrors.confirmPassword"
              class="absolute top-[calc(100%+4px)] left-0 right-0 flex items-center justify-between gap-1 text-13px text-error-text"><span>{{ fieldErrors.confirmPassword }}</span><UIcon name="i-lucide-x" class="size-3.5" /></div>
          </Transition>
        </div>

        <UButton color="primary" size="md" block type="submit" :disabled="loading">
                    <UIcon name="i-lucide-loader-2" class="animate-spin-slow mr-1.5 size-4.5" v-if="loading"/>
                    {{ loading ? '重置中...' : '重置密码' }}
                </UButton>
      </form>

      <p class="text-center mt-5 text-sm text-text-secondary">
        <NuxtLink to="/login"
          class="text-primary no-underline font-semibold hover:underline">返回登录</NuxtLink>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { validatePassword, validatePasswordMatch } from '~/utils/auth/validatePassword';
import { extractApiError } from '~/utils/server/apiError';

definePageMeta({ layout: 'auth' });

const route = useRoute();
const router = useRouter();
const auth = useAuth();

const token = computed(() => (route.query.token as string) || '');

const form = reactive({ password: '', confirmPassword: '' });
const showPassword = ref(false);
const showConfirmPassword = ref(false);
const loading = ref(false);
const fieldErrors = ref<Record<string, string>>({});

const { error, setError, clearError } = useFormError(5000);

function validate(): boolean {
  const errors: Record<string, string> = {};
  const pwResult = validatePassword(form.password);
  if (!pwResult.valid) {
    errors.password = pwResult.message;
  }
  const matchError = validatePasswordMatch(form.password, form.confirmPassword);
  if (matchError) {
    errors.confirmPassword = matchError;
  }
  fieldErrors.value = errors;
  return Object.keys(errors).length === 0;
}

async function handleSubmit() {
  if (!token.value) {
    setError('缺少重置令牌，请重新发起密码重置');
    return;
  }
  if (!validate()) return;

  loading.value = true;
  try {
    await auth.resetPassword(token.value, form.password);
    // 成功 → 跳登录页带成功 banner
    router.replace('/login?reset=1');
  } catch (e: unknown) {
    setError(extractApiError(e).message);
    loading.value = false;
  }
}
</script>

<style>
/* Vue Transition: slide (用于 error banner) */
.slide-enter-active {
  transition: all 0.3s ease-out;
}
.slide-leave-active {
  transition: all 0.2s ease-in;
}
.slide-enter-from {
  transform: translateX(-50%) translateY(-20px);
  opacity: 0;
}
.slide-leave-to {
  transform: translateX(-50%) translateY(-20px);
  opacity: 0;
}

/* Vue Transition: drop (用于 field errors) */
.drop-enter-active {
  animation: dropIn 0.25s ease both;
}
.drop-leave-active {
  animation: dropOut 0.2s ease both;
}

@keyframes dropIn {
  from {
    opacity: 0;
    transform: translateY(-8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes dropOut {
  from {
    opacity: 1;
    transform: translateY(0);
  }
  to {
    opacity: 0;
    transform: translateY(8px);
  }
}

/* Vue Transition: icon (用于密码可见切换) */
.icon-enter-active,
.icon-leave-active {
  transition: opacity 0.18s linear, transform 0.18s linear;
}
.icon-enter-from {
  opacity: 0;
  transform: translate(-6px, -6px);
}
.icon-leave-to {
  opacity: 0;
  transform: translate(6px, 6px);
}
</style>
