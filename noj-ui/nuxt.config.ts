// https://nuxt.com/docs/api/configuration/nuxt-config
const apiBase = process.env.NUXT_API_BASE ?? "http://localhost:8001";

export default defineNuxtConfig({
  devtools: { enabled: true },
  modules: [],

  // 运行时配置（服务端私有，不暴露给浏览器）
  runtimeConfig: {
    apiBase,
  },

  // API 请求由 server/api/[...slug].ts 代理到 noj-core

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
