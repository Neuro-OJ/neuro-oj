// https://nuxt.com/docs/api/configuration/nuxt-config
const apiBase = process.env.NUXT_API_BASE ?? 'http://localhost:8000';

export default defineNuxtConfig({
  compatibilityDate: '2026-06-26',
  devtools: { enabled: true },
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],

  // @nuxt/icon：lucide 集合本地打包，SSR/单二进制离线渲染图标
  // （scan 扫描源码中实际用到的图标打包进客户端；@nuxt/icon 2.x 无
  //   collections / includeAllCollections 选项，配置会被忽略，已移除）
  icon: {
    serverBundle: 'local',
    clientBundle: {
      scan: true,
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

  // 通用 API 代理不在 Nitro 层启用 SWR：代理响应可能是上游 Node 响应对象，无法安全
  // 序列化；同时同一路径下存在按用户鉴权/个性化的接口（例如 U 型题列表），缓存会
  // 导致请求挂起、复用错误响应，甚至把一个用户的数据暴露给另一个用户。需要缓存时，
  // 应在明确的、非个性化 server handler 中单独实现。
  routeRules: {
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
