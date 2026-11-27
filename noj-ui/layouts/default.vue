<script setup lang="ts">
import BanBanner from '~/components/layout/BanBanner.vue';
import BreadcrumbNav from '~/components/layout/BreadcrumbNav.vue';
import LegalConsentModal from '~/components/legal/LegalConsentModal.vue';
import { useBanStatus } from '~/composables/useBanStatus';
import { collectPendingConsents } from '~/utils/auth/legalConsent';

const { ipBanned, ipBanInfo, userBanned, userBanInfo } = useBanStatus();

// 政策重大变更同意弹窗（PIPL）：登录用户存在未同意的重大版本时展示
const { user } = useAuth();
const pendingConsents = computed(() => user.value ? collectPendingConsents(user.value.legal) : []);

const { open: _openPalette, toggle: toggleCommandPalette } = useDomainCommandPalette();

function onGlobalKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    toggleCommandPalette();
  }
}

onMounted(() => {
  window.addEventListener('keydown', onGlobalKeydown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', onGlobalKeydown);
});
</script>
<template>
  <div class="flex flex-col min-h-screen w-full overflow-x-hidden bg-bg-page">
    <a href="#main"
      class="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[200] focus:bg-bg-panel focus:text-text focus:px-4 focus:py-2 focus:rounded-md focus:shadow-modal">
            跳转到主要内容
        </a>
    <Navbar />
    <BanBanner v-if="ipBanned" type="ip" :ip-info="ipBanInfo" />
    <BanBanner v-if="userBanned" type="user" :user-info="userBanInfo" />
    <EmailVerificationBanner />
    <div class="flex flex-1 min-h-[calc(100vh-var(--header-h))] w-full pt-(--header-h)">
      <main id="main" class="flex-1 min-w-0 w-full">
        <!-- 面包屑（#512）：未注册路径不渲染，因此 admin/auth 页零影响 -->
        <BreadcrumbNav />
        <slot />
      </main>
    </div>
    <FooterBar />
    <DomainCommandPalette />
    <LegalConsentModal v-if="pendingConsents.length > 0" :pending="pendingConsents" />
  </div>
</template>
