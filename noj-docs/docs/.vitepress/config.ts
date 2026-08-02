import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

// 部署到 GitHub Pages 项目页时启用（与仓库 neuro-oj 对应）：
// base: "/neuro-oj/",
export default withMermaid(defineConfig({
  lang: "zh-CN",
  title: "Neuro OJ 文档",
  description: "Neuro OJ — 面向 LMCC 的在线评测系统文档",

  lastUpdated: true,
  cleanUrls: false,

  head: [
    ["link", { rel: "preconnect", href: "https://fonts.googleapis.cn" }],
    [
      "link",
      { rel: "preconnect", href: "https://fonts.gstatic.cn", crossorigin: "" },
    ],
    [
      "link",
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Outfit:wght@100..900&display=swap",
      },
    ],
  ],

  themeConfig: {
    siteTitle: "Neuro OJ 文档",
    search: {
      provider: "local",
      options: {
        translations: {
          button: { buttonText: "搜索", buttonAriaLabel: "搜索" },
          modal: {
            noResultsText: "未找到相关结果",
            resetButtonTitle: "清除查询",
            footer: {
              selectText: "选择",
              navigateText: "切换",
              closeText: "关闭",
            },
          },
        },
      },
    },
    nav: [
      // 顶部导航仅放外部链接；站内分区导航由胶囊 Tab 条（SectionTabs）承担
      { text: "GitHub", link: "https://github.com/Neuro-OJ/neuro-oj" },
      { text: "Issues", link: "https://github.com/Neuro-OJ/neuro-oj/issues" },
      {
        text: "License",
        link: "https://github.com/Neuro-OJ/neuro-oj/blob/main/LICENSE",
      },
    ],
    sidebar: {
      "/users/": [
        {
          text: "做题人",
          items: [
            { text: "做题人文档", link: "/users/" },
            { text: "快速开始", link: "/users/getting-started" },
            { text: "提交代码", link: "/users/submit" },
            { text: "理解结果", link: "/users/results" },
            { text: "账号与密码", link: "/users/account" },
            { text: "排行榜与签到", link: "/users/ranking" },
            { text: "搜索与私信", link: "/users/search-messages" },
          ],
        },
      ],
      "/operators/": [
        {
          text: "运营者",
          items: [
            { text: "运营者文档", link: "/operators/" },
            { text: "本地启动", link: "/operators/local-start" },
            { text: "CLI 初始化", link: "/operators/cli" },
            { text: "存储与评测包交付", link: "/operators/storage" },
            { text: "Judge Worker 运维", link: "/operators/judge-workers" },
            { text: "后台管理指南", link: "/operators/admin-guide" },
          ],
        },
      ],
      "/problemsetters/": [
        {
          text: "出题人",
          items: [
            { text: "出题人文档", link: "/problemsetters/" },
            { text: "评测模型", link: "/problemsetters/judge-model" },
            { text: "Web 题目编辑器", link: "/problemsetters/web-editor" },
            { text: "统一题目包", link: "/problemsetters/support-package" },
            { text: "测试数据", link: "/problemsetters/cases" },
            { text: "Evaluator SDK", link: "/problemsetters/evaluator-sdk" },
            { text: "Solution SDK", link: "/problemsetters/solution-sdk" },
            { text: "RPC 与可传递数据", link: "/problemsetters/rpc" },
            { text: "评测镜像与多语言", link: "/problemsetters/runtimes" },
            { text: "A+B 示例题", link: "/problemsetters/ab-example" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "参考",
          items: [
            { text: "参考文档", link: "/reference/" },
            { text: "术语表", link: "/reference/glossary" },
            { text: "结果状态", link: "/reference/result-status" },
            { text: "常见问题（FAQ）", link: "/reference/faq" },
            { text: "更新日志", link: "/reference/changelog" },
          ],
        },
      ],
    },
    outline: { level: [2, 3], label: "本页目录" },
    docFooter: { prev: "上一页", next: "下一页" },
    footer: {
      message:
        "Neuro OJ 是一个独立社区项目，与 CCF 及 LMCC 无官方关系。",
    },
    editLink: {
      pattern:
        "https://github.com/Neuro-OJ/neuro-oj/edit/main/noj-docs/docs/:path",
      text: "在 GitHub 上编辑此页",
    },
  },
}));
