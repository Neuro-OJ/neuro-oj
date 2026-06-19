// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  devtools: { enabled: true },
  modules: [],

  // 运行时配置（服务端私有，不暴露给浏览器）
  runtimeConfig: {
    apiBase: "http://localhost:8000",
  },

  // Nitro 服务端代理 — 将 /api/* 转发到 noj-core
  // 开发模式使用 devProxy，生产模式使用 routeRules
  nitro: {
    devProxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },

  routeRules: {
    // 生产环境代理（部署时由 Nitro 服务端处理）
    "/api/**": { proxy: { to: "http://localhost:8000/api/**" } },
  },

  app: {
    head: {
      title: "Neuro OJ",
      meta: [
        { charset: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        { name: "description", content: "Neuro OJ — 面向 LMCC 的在线评测系统" },
      ],
    },
  },
});
