<script setup lang="ts">
// 显式导入项目 useToast：避免与 @nuxt/ui 自动导入的同名 useToast 混淆
import { useToast } from '~/composables/useToast';
import { extractApiError } from '~/utils/server/apiError';

const auth = useAuth();
const { user, isLoggedIn, loading } = auth;
const { toast } = useToast();

// ── 第三方账号绑定（issue #227） ──
const oauthProviders = ref<Array<{ id: string; name: string }>>([]);
const linkedOAuthAccounts = ref<
  Array<{
    id: string;
    provider: string;
    provider_user_id: string;
    provider_username: string | null;
    created_at: string;
  }>
>([]);
const oauthPassword = ref('');
const oauthLoading = ref(false);
const oauthError = ref('');

async function loadOAuthSettings() {
  try {
    const [providers, accounts] = await Promise.all([
      auth.getOAuthProviders(),
      auth.getLinkedOAuthAccounts(),
    ]);
    oauthProviders.value = providers;
    linkedOAuthAccounts.value = accounts;
  } catch {
    oauthProviders.value = [];
    linkedOAuthAccounts.value = [];
  }
}

watch(
  loading,
  (value) => {
    if (!value && isLoggedIn.value) void loadOAuthSettings();
  },
  { immediate: true },
);

async function beginOAuthLink(provider: string) {
  oauthLoading.value = true;
  oauthError.value = '';
  try {
    const url = await auth.beginOAuthLink(provider, oauthPassword.value);
    window.location.assign(url);
  } catch (err: unknown) {
    oauthError.value = extractApiError(err).message;
    oauthLoading.value = false;
  }
}

async function handleOAuthUnlink(accountId: string) {
  oauthLoading.value = true;
  oauthError.value = '';
  try {
    await auth.unlinkOAuthAccount(accountId, oauthPassword.value);
    linkedOAuthAccounts.value = linkedOAuthAccounts.value.filter((account) => account.id !== accountId);
    oauthPassword.value = '';
    toast.success('第三方账号已解绑');
  } catch (err: unknown) {
    oauthError.value = extractApiError(err).message;
  } finally {
    oauthLoading.value = false;
  }
}
</script>

<template>
  <section
    id="settings-connections"
    aria-labelledby="connections-title"
    class="scroll-mt-32 overflow-hidden rounded border border-border bg-bg-panel"
  >
    <div class="px-6 py-5 border-b border-border">
      <h2 id="connections-title" class="text-lg font-semibold flex items-center gap-2">
        <UIcon name="i-lucide-link" class="size-5" />
        第三方账号
      </h2>
    </div>
    <div class="px-6 py-6 flex flex-col gap-4">
      <p class="text-sm text-text-secondary">
        绑定后可以使用第三方账号登录。绑定和解绑需要确认当前密码；没有本地密码的账号不能解绑唯一登录方式。
      </p>
      <UInput
        v-if="user?.has_local_password"
        v-model="oauthPassword"
        type="password"
        autocomplete="current-password"
        placeholder="确认当前密码"
        class="max-w-sm"
      />
      <div v-if="linkedOAuthAccounts.length" class="flex flex-col gap-2">
        <div
          v-for="account in linkedOAuthAccounts"
          :key="account.id"
          class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
        >
          <div>
            <p class="font-semibold">{{ account.provider }}</p>
            <p class="text-xs text-text-muted">
              {{ account.provider_username || account.provider_user_id }}
            </p>
          </div>
          <UButton
            size="sm"
            color="error"
            variant="outline"
            :loading="oauthLoading"
            @click="handleOAuthUnlink(account.id)"
          >解绑</UButton>
        </div>
      </div>
      <div v-if="oauthProviders.length" class="flex flex-wrap gap-2">
        <UButton
          v-for="provider in oauthProviders.filter((item) => !linkedOAuthAccounts.some((account) => account.provider === item.id))"
          :key="provider.id"
          color="primary"
          variant="outline"
          :loading="oauthLoading"
          @click="beginOAuthLink(provider.id)"
        >绑定 {{ provider.name }}</UButton>
      </div>
      <p v-if="oauthError" class="text-sm text-error-text">{{ oauthError }}</p>
      <p v-if="!oauthProviders.length && !linkedOAuthAccounts.length" class="text-sm text-text-muted">
        管理员尚未配置第三方登录。
      </p>
    </div>
  </section>
</template>
