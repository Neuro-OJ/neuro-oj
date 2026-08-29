import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

// 部署到 GitHub Pages 项目页时启用（与仓库 neuro-oj 对应）：
// base: "/neuro-oj/",
export default withMermaid(defineConfig({
  lang: "zh-CN",
  title: "Neuro OJ 文档",
  description: "Neuro OJ — 面向 IOAI、NOAI、LMCC 等 AI 认证与竞赛场景的在线评测系统文档",

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
      "/": [
        {
          text: "快速开始",
          items: [
            { text: "什么是 Neuro OJ", link: "/intro/what-is-noj" },
            { text: "快速开始", link: "/intro/getting-started" },
            { text: "常见问题", link: "/intro/faq" },
          ],
        },
        {
          text: "面向角色",
          collapsed: true,
          items: [
            {
              text: "做题人",
              items: [
                { text: "做题人文档", link: "/users/" },
                { text: "提交代码", link: "/users/submit" },
                { text: "使用 capability", link: "/users/capability" },
                { text: "理解结果", link: "/users/results" },
                { text: "账号与密码", link: "/users/account" },
              ],
            },
            {
              text: "出题人",
              items: [
                { text: "出题人文档", link: "/problemsetters/" },
                { text: "快速出一题", link: "/problemsetters/quick-start" },
                { text: "Web 题目编辑器", link: "/problemsetters/web-editor" },
                { text: "A+B 示例题", link: "/problemsetters/ab-example" },
                { text: "出 LLM 调用题", link: "/problemsetters/llm-problem" },
              ],
            },
            {
              text: "运营者",
              items: [
                { text: "运营者文档", link: "/operators/" },
                { text: "生产部署", link: "/operators/production-deploy" },
                { text: "如何提供 LLM 调用能力", link: "/operators/llm-call-capability" },
                { text: "CLI 初始化", link: "/operators/cli" },
                { text: "Judge Worker 运维", link: "/operators/judge-workers" },
                { text: "后台管理指南", link: "/operators/admin-guide" },
                { text: "生产密钥", link: "/operators/production-secrets" },
              ],
            },
          ],
        },
        {
          text: "面向主题",
          collapsed: true,
          items: [
            {
              text: "题目规范及质量要求",
              items: [
                { text: "总览", link: "/standards/" },
                { text: "题目包格式规范", link: "/standards/problem-bundle" },
                { text: "测试数据与样例规范", link: "/standards/test-data" },
                { text: "题目质量要求", link: "/standards/quality" },
              ],
            },
            {
              text: "评测机制与 SDK",
              items: [
                { text: "总览", link: "/mechanisms/" },
                { text: "评测模型", link: "/mechanisms/judge-model" },
                { text: "Evaluator SDK", link: "/mechanisms/evaluator-sdk" },
                { text: "Solution SDK", link: "/mechanisms/solution-sdk" },
                { text: "RPC 与可传递数据", link: "/mechanisms/rpc" },
                { text: "评测镜像与运行时", link: "/mechanisms/runtimes" },
                { text: "如何提供受限网络能力", link: "/mechanisms/capability-networking" },
              ],
            },
            {
              text: "系统架构与运维主题",
              items: [
                { text: "总览", link: "/system/" },
                { text: "系统架构", link: "/system/architecture" },
                { text: "安全模型", link: "/system/security" },
                { text: "存储与评测包交付", link: "/system/storage" },
              ],
            },
            {
              text: "功能主题",
              items: [
                { text: "总览", link: "/features/" },
                { text: "排行榜与签到", link: "/features/ranking" },
                { text: "搜索与私信", link: "/features/search-messages" },
                { text: "社区", link: "/features/community" },
                { text: "竞赛", link: "/features/contests" },
                { text: "题单", link: "/features/trainings" },
                { text: "公告", link: "/features/announcements" },
                { text: "客观题套卷", link: "/features/objective" },
              ],
            },
            {
              text: "参考",
              items: [
                { text: "参考文档", link: "/reference/" },
                { text: "术语表", link: "/reference/glossary" },
                { text: "结果状态", link: "/reference/result-status" },
                { text: "更新日志", link: "/reference/changelog" },
              ],
            },
          ],
        },
      ],
    },
    outline: { level: [2, 3], label: "本页目录" },
    docFooter: { prev: "上一页", next: "下一页" },
    footer: {
      message:
      "Neuro OJ 是一个独立社区项目，与 CCF、LMCC、IOAI 及 NOAI 无官方关系。",
    },
    editLink: {
      pattern:
        "https://github.com/Neuro-OJ/neuro-oj/edit/main/noj-docs/docs/:path",
      text: "在 GitHub 上编辑此页",
    },
  },
}));
