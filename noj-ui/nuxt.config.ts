// https://nuxt.com/docs/api/configuration/nuxt-config
const apiBase = process.env.NUXT_API_BASE ?? "http://localhost:8000";

export default defineNuxtConfig({
  devtools: { enabled: true },
  modules: [],

  // @lucide/vue 的 Icon 组件在 SSR 下 inject() 上下文丢失，
  // 通过 noExternal 强制让 Vite 将其打包入 SSR bundle，确保 inject 链路完整
  vite: {
    ssr: {
      noExternal: ["@lucide/vue"],
    },
  },

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
