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
      title: 'Neuro OJ',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: 'Neuro OJ — 面向 LMCC 的在线评测系统' },
      ],
    },
  },

  // Deno Compile 用，删了没法编译
  hooks: {
    close: () => {
      process.exit(0);
    },
  },

  nitro: {
    preset: 'deno-server',
  },
});
