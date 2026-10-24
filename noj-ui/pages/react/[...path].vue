<script setup lang="ts">
import { loadBootstrap } from '~/react/bootstrap';
import type { ServerGet } from '~/react/bootstrap';
import { isProtectedRoute, isReactRoute } from '~/react/routes';

// React Router 独立管理子路由。固定 page key 避免浏览器后退时 Nuxt 重建 React root。
definePageMeta({ layout: false, key: 'react-app' });
const route = useRoute();
const initialUrl = route.fullPath;
const pathname = route.path.replace(/^\/react(?=\/|$)/, '') || '/';
const session = useCookie('noj:session');
// 使用服务端请求上下文转发 Cookie，绝不将 JWT 放入水合数据。
const requestFetch = useRequestFetch();
const get: ServerGet = (url, options) => requestFetch(url, options);
const { data: bootstrap } = await useAsyncData(`react:${initialUrl}`, () => loadBootstrap(initialUrl, Boolean(session.value), get));
if (!isReactRoute(pathname)) {
  setResponseStatus(404);
}
if (bootstrap.value?.user?.must_change_password) await navigateTo('/change-password', { external: true });
if (isProtectedRoute(pathname) && bootstrap.value && !bootstrap.value.user && !bootstrap.value.authError) {
  await navigateTo(`/react/login?redirect=${encodeURIComponent(initialUrl)}`, { replace: true });
}
if (bootstrap.value?.status === 404) setResponseStatus(404);

const root = ref<HTMLElement | null>(null);
let unmount: (() => void) | undefined;
// SSR 内容和样式随 Nuxt payload 一起交付，客户端复用同一数据水合。
const { data: rendered } = await useAsyncData(`react-html:${initialUrl}`, async () => {
  if (!import.meta.server || !bootstrap.value) return { html: '' };
  const { renderReact } = await import('~/react/entry-server');
  return renderReact(bootstrap.value);
});
useHead({ title: 'Neuro OJ', meta: [{ name: 'robots', content: 'noindex,follow' }] });
onMounted(async () => {
  const { mountReact } = await import('~/react/entry-client');
  if (root.value && bootstrap.value) unmount = mountReact(root.value, bootstrap.value);
});
onBeforeUnmount(() => unmount?.());
</script>

<template>
  <div>
    <div ref="root" v-html="rendered?.html" />
  </div>
</template>
