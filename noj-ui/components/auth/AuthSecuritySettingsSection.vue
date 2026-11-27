<script setup lang="ts">
// 显式导入项目 useToast：避免与 @nuxt/ui 自动导入的同名 useToast 混淆
import { useToast } from '~/composables/useToast';
import { formatRecoveryCodesFile } from '~/utils/auth/recoveryCodes';
import { extractApiError } from '~/utils/server/apiError';

const { user } = useAuth();
const { api } = useApi();
const { toast } = useToast();

// ── TFA 管理（issue #228） ──
const tfaEnabled = ref(user.value?.tfa_enabled ?? false);
const tfaSetup = ref<{ secret: string; otpauth_url: string } | null>(null);
const tfaCode = ref('');
const tfaRecoveryCodes = ref<string[]>([]);
const tfaLoading = ref(false);
const tfaError = ref('');
const qrDataUrl = ref('');
const tfaUserId = ref(user.value?.id ?? null);

function resetTfaTransientState() {
  tfaSetup.value = null;
  tfaCode.value = '';
  tfaRecoveryCodes.value = [];
  tfaError.value = '';
  qrDataUrl.value = '';
}

watch(
  user,
  (u) => {
    const nextUserId = u?.id ?? null;
    if (nextUserId !== tfaUserId.value) {
      resetTfaTransientState();
      tfaUserId.value = nextUserId;
    }
    tfaEnabled.value = u?.tfa_enabled ?? false;
  },
  { immediate: true },
);

async function handleTfaSetup() {
  tfaLoading.value = true;
  tfaError.value = '';
  try {
    const res = await api.post<{ data: { secret: string; otpauth_url: string } }>(
      '/api/v1/auth/tfa/setup',
      undefined,
    );
    tfaSetup.value = res.data;
    tfaCode.value = '';
    tfaRecoveryCodes.value = [];
    qrDataUrl.value = '';
    // 前端本地生成二维码，避免 secret 经过额外服务端处理
    const QRCode = (await import('qrcode')).default;
    qrDataUrl.value = await QRCode.toDataURL(res.data.otpauth_url, {
      width: 200,
      margin: 1,
    });
  } catch (err: unknown) {
    tfaError.value = extractApiError(err).message;
  } finally {
    tfaLoading.value = false;
  }
}

async function handleTfaConfirm() {
  if (!tfaCode.value.trim()) {
    tfaError.value = '请输入 6 位验证码';
    return;
  }
  tfaLoading.value = true;
  tfaError.value = '';
  try {
    const res = await api.post<{ data: { recovery_codes: string[] } }>(
      '/api/v1/auth/tfa/confirm',
      { code: tfaCode.value.trim() },
    );
    tfaRecoveryCodes.value = res.data.recovery_codes;
    tfaEnabled.value = true;
    tfaSetup.value = null;
    tfaCode.value = '';
    qrDataUrl.value = '';
    if (user.value) user.value.tfa_enabled = true;
  } catch (err: unknown) {
    tfaError.value = extractApiError(err).message;
  } finally {
    tfaLoading.value = false;
  }
}

async function handleTfaDisable() {
  if (!tfaCode.value.trim()) {
    tfaError.value = '请输入验证码或恢复码';
    return;
  }
  tfaLoading.value = true;
  tfaError.value = '';
  try {
    await api.post('/api/v1/auth/tfa/disable', { code: tfaCode.value.trim() });
    tfaEnabled.value = false;
    resetTfaTransientState();
    if (user.value) user.value.tfa_enabled = false;
    toast.success('两步验证已禁用');
  } catch (err: unknown) {
    tfaError.value = extractApiError(err).message;
  } finally {
    tfaLoading.value = false;
  }
}

async function handleTfaRegenerate() {
  if (!tfaCode.value.trim()) {
    tfaError.value = '请输入验证码或恢复码';
    return;
  }
  tfaLoading.value = true;
  tfaError.value = '';
  try {
    const res = await api.post<{ data: { recovery_codes: string[] } }>(
      '/api/v1/auth/tfa/recovery-codes/regenerate',
      { code: tfaCode.value.trim() },
    );
    tfaRecoveryCodes.value = res.data.recovery_codes;
    tfaCode.value = '';
    try {
      toast.success('恢复码已重新生成');
    } catch {
      // toast 异常不影响业务结果，静默忽略
    }
  } catch (err: unknown) {
    tfaError.value = extractApiError(err).message;
  } finally {
    tfaLoading.value = false;
  }
}

function handleDownloadRecoveryCodes() {
  if (tfaRecoveryCodes.value.length === 0) return;

  // 清除上一次遗留的错误提示，避免“下载已成功但仍显示失败”
  tfaError.value = '';

  try {
    const content = formatRecoveryCodesFile(tfaRecoveryCodes.value);
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `neuro-oj-recovery-codes-${new Date().toISOString().slice(0, 10)}.txt`;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    // 稍后释放 URL，避免下载尚未开始时提前回收
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    try {
      toast.success('恢复码文件已下载');
    } catch {
      // toast 异常不影响下载结果，静默忽略
    }
  } catch {
    tfaError.value = '恢复码文件生成失败，请手动复制保存';
  }
}

async function handleCopyRecoveryCodes() {
  if (tfaRecoveryCodes.value.length === 0) return;

  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
    await navigator.clipboard.writeText(tfaRecoveryCodes.value.join('\n'));
    toast.success('恢复码已复制');
  } catch {
    toast.error('复制失败，请手动复制恢复码');
  }
}
</script>

<template>
  <section
    id="settings-security"
    aria-labelledby="security-title"
    class="scroll-mt-32 overflow-hidden rounded border border-border bg-bg-panel"
  >
    <div class="px-6 py-5 border-b border-border">
      <h2 id="security-title" class="text-lg font-semibold flex items-center gap-2">
        <UIcon name="i-lucide-shield-check" class="size-5" />
        密码与安全
      </h2>
    </div>

    <div class="px-6 py-6 flex flex-col gap-4">
      <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <div>
          <h3 class="font-medium">登录密码</h3>
          <p class="mt-1 text-sm text-text-secondary">
            {{ user?.has_local_password ? '使用当前密码验证后更改登录密码。' : '为账号设置本地登录密码。' }}
          </p>
        </div>
        <UButton :to="user?.has_local_password ? '/change-password' : '/set-password'" variant="outline">
          {{ user?.has_local_password ? '修改密码' : '设置密码' }}
        </UButton>
      </div>
      <h3 class="font-medium">两步验证</h3>
      <p class="text-sm text-text-secondary">
        启用后登录时需要输入验证器 App 生成的 6 位验证码或恢复码。
      </p>

      <div v-if="!tfaEnabled">
        <UButton v-if="!tfaSetup" color="primary" :loading="tfaLoading" @click="handleTfaSetup">
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
            <UInput v-model="tfaCode" placeholder="6 位验证码" class="max-w-xs" />
            <UButton color="primary" :loading="tfaLoading" @click="handleTfaConfirm">确认启用</UButton>
          </div>
        </div>
      </div>

      <div v-else class="flex flex-col gap-3">
        <p class="text-sm text-success-text font-semibold">已启用</p>
        <div class="flex items-center gap-2 flex-wrap">
          <UInput v-model="tfaCode" placeholder="验证码或恢复码" class="max-w-xs" />
          <UButton color="error" variant="outline" :loading="tfaLoading" @click="handleTfaDisable">禁用</UButton>
          <UButton color="neutral" variant="outline" :loading="tfaLoading" @click="handleTfaRegenerate">
            重新生成恢复码
          </UButton>
        </div>
      </div>

      <div
        v-if="tfaRecoveryCodes.length > 0"
        class="border border-border rounded-lg p-4 bg-bg-page flex flex-col gap-2"
      >
        <p class="text-sm font-semibold">请立即保存以下恢复码，刷新页面后无法找回</p>
        <div class="grid grid-cols-2 gap-2">
          <code
            v-for="c in tfaRecoveryCodes"
            :key="c"
            class="font-mono text-sm bg-bg-panel border border-border rounded px-2 py-1"
          >{{ c }}</code>
        </div>
        <p class="text-xs text-text-muted">
          每个恢复码只能使用一次；重新生成后，旧恢复码全部失效。
        </p>
        <div class="flex flex-wrap gap-2">
          <UButton color="primary" variant="outline" size="sm" @click="handleDownloadRecoveryCodes">
            <UIcon name="i-lucide-download" class="size-4" />
            下载恢复码文件
          </UButton>
          <UButton color="neutral" variant="outline" size="sm" @click="handleCopyRecoveryCodes">
            <UIcon name="i-lucide-copy" class="size-4" />
            复制全部
          </UButton>
        </div>
      </div>

      <p v-if="tfaError" class="text-sm text-error-text">{{ tfaError }}</p>
    </div>
  </section>
</template>
