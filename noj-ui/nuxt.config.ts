// https://nuxt.com/docs/api/configuration/nuxt-config
const apiBase = process.env.NUXT_API_BASE ?? 'http://localhost:8000';

export default defineNuxtConfig({
  compatibilityDate: '2026-06-26',
  devtools: { enabled: true },
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],

  // @nuxt/icon：lucide 集合本地打包，SSR/单二进制离线渲染图标
  icon: {
    serverBundle: 'local',
    clientBundle: {
      scan: true,
      collections: ['lucide'],
      includeAllCollections: true,
    },
  },

  // @nuxt/fonts：仅保留本地 provider（fonts.google.com 元数据 API 在大陆网络不可达，
  // 远程 provider 会导致 SSR 模块加载挂起；字体回退到系统字体栈）
  fonts: {
    providers: {
      google: false,
      googleicons: false,
      bunny: false,
      adobe: false,
      fontshare: false,
    },
  },

  // 运行时配置（服务端私有，不暴露给浏览器）
  runtimeConfig: {
    apiBase,
  },

  // 子目录组件不添加路径前缀（feature/LatestSubmissions.vue → <LatestSubmissions>）
  components: {
    dirs: [{ path: '~/components', pathPrefix: false }],
  },

  // API 请求由 server/api/[...slug].ts 代理到 noj-core

  app: {
    head: {
      // 页面语言声明（WCAG 3.1.1）：缺失时屏幕阅读器无法确定朗读语言
      htmlAttrs: {
        lang: 'zh-CN',
      },
      title: 'Neuro OJ',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: 'Neuro OJ — 面向 AI 领域认证与竞赛（IOAI / NOAI / LMCC）的在线评测平台' },
        { property: 'og:title', content: 'Neuro OJ' },
        {
          property: 'og:description',
          content: 'Neuro OJ — 面向 AI 领域认证与竞赛（IOAI / NOAI / LMCC）的在线评测平台',
        },
        { property: 'og:type', content: 'website' },
      ],
    },
  },

  // Deno Compile 用，删了没法编译
  hooks: {
    close: () => {
      // 仅在编译产物（deno compile 单二进制）中主动退出；
      // nuxt dev 的配置变更重启也会触发 close，直接退出会杀掉整个开发服务器
      // （管理后台创建竞赛时前端报「网络连接失败，请检查网络」的根因）。
      if (!process.argv.includes('dev')) {
        process.exit(0);
      }
    },
  },

  // 公开 GET 接口缓存（SWR），降低 noj-core 压力；认证/个性化接口显式 no-store
  routeRules: {
    '/api/v1/problems': { swr: 60 },
    '/api/v1/rankings': { swr: 60 },
    '/api/v1/contests': { swr: 60 },
    '/api/v1/trainings': { swr: 60 },
    '/api/v1/announcements': { swr: 60 },
    '/api/v1/tags': { swr: 60 },
    '/api/v1/stats': { swr: 60 },
    '/api/v1/auth/**': { headers: { 'cache-control': 'no-store' } },
    '/api/v1/submissions/**': { headers: { 'cache-control': 'no-store' } },
    '/api/v1/queue/**': { headers: { 'cache-control': 'no-store' } },
    '/api/v1/community/**': { headers: { 'cache-control': 'no-store' } },
    '/api/v1/users/me/**': { headers: { 'cache-control': 'no-store' } },
  },

  nitro: {
    preset: 'deno-server',
  },
});
