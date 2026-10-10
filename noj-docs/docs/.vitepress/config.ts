import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

// 部署到 GitHub Pages 项目页时启用（与仓库 neuro-oj 对应）：
// base: "/neuro-oj/",
export default withMermaid(defineConfig({
  lang: "zh-CN",
  title: "Neuro OJ 文档",
  description:
    "Neuro OJ — 面向 IOAI、NOAI、LMCC 等 AI 认证与竞赛场景的在线评测系统文档",

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
        href:
          "https://fonts.googleapis.com/css2?family=Outfit:wght@100..900&display=swap",
      },
    ],
    [
      "style",
      {},
      `:root {
        --vp-c-brand-1: #1B2B4A;
        --vp-c-brand-2: #00d68a;
        --vp-c-brand-3: #007146;
        --vp-c-bg: #e8e8e2;
        --vp-c-bg-alt: #f2f2ec;
        --vp-c-bg-elv: #f2f2ec;
        --vp-c-text-1: #1c1e1b;
        --vp-c-text-2: #4c4e4a;
        --vp-c-border: #d5d6cf;
        --vp-c-divider: #d5d6cf;
      }
      .dark {
        --vp-c-brand-1: #7C96D6;
        --vp-c-brand-2: #00e07a;
        --vp-c-brand-3: #00d68a;
        --vp-c-bg: #121310;
        --vp-c-bg-alt: #191b17;
        --vp-c-bg-elv: #191b17;
        --vp-c-text-1: #f2f3ef;
        --vp-c-text-2: #90938d;
        --vp-c-border: #333631;
        --vp-c-divider: #333631;
      }`,
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
      { text: "做题指南", link: "/users/", activeMatch: "^/(users|features)/" },
      {
        text: "出题指南",
        link: "/problemsetters/",
        activeMatch: "^/(problemsetters|standards)/",
      },
      { text: "运维部署", link: "/operators/", activeMatch: "^/operators/" },
      {
        text: "评测机制与架构",
        link: "/mechanisms/",
        activeMatch: "^/(mechanisms|system)/",
      },
      {
        text: "参考手册",
        link: "/reference/",
        activeMatch: "^/(reference|intro)/",
      },
      {
        text: "项目与源码",
        items: [
          { text: "GitHub 仓库", link: "https://github.com/Neuro-OJ/neuro-oj" },
          {
            text: "问题反馈 (Issues)",
            link: "https://github.com/Neuro-OJ/neuro-oj/issues",
          },
          { text: "更新日志", link: "/reference/changelog" },
          {
            text: "许可证 (AGPL-3.0)",
            link: "https://github.com/Neuro-OJ/neuro-oj/blob/main/LICENSE",
          },
        ],
      },
    ],
    sidebar: {
      "/users/": [
        {
          text: "做题入门",
          items: [
            { text: "做题人概览", link: "/users/" },
            { text: "快速开始", link: "/users/quick-start" },
            { text: "提交代码与语言约定", link: "/users/submit" },
            { text: "理解评测结果", link: "/users/results" },
            { text: "使用 Capability 网络能力", link: "/users/capability" },
          ],
        },
        {
          text: "做题客户端",
          items: [
            { text: "LMCC IDE 插件", link: "/users/lmcc-extension" },
          ],
        },
        {
          text: "平台功能",
          items: [
            { text: "竞赛模式", link: "/features/contests" },
            { text: "题单训练", link: "/features/trainings" },
            { text: "客观题套卷", link: "/features/objective" },
            { text: "题目版本管理", link: "/features/problem-versioning" },
            { text: "排行榜与每日签到", link: "/features/ranking" },
            { text: "社区与讨论", link: "/features/community" },
            { text: "站内搜索与私信", link: "/features/search-messages" },
            { text: "系统公告", link: "/features/announcements" },
          ],
        },
        {
          text: "账号与设置",
          items: [
            { text: "账号与密码安全", link: "/users/account" },
          ],
        },
      ],
      "/features/": [
        {
          text: "做题入门",
          items: [
            { text: "做题人概览", link: "/users/" },
            { text: "快速开始", link: "/users/quick-start" },
            { text: "提交代码与语言约定", link: "/users/submit" },
            { text: "理解评测结果", link: "/users/results" },
            { text: "使用 Capability 网络能力", link: "/users/capability" },
          ],
        },
        {
          text: "做题客户端",
          items: [
            { text: "LMCC IDE 插件", link: "/users/lmcc-extension" },
          ],
        },
        {
          text: "平台功能",
          items: [
            { text: "竞赛模式", link: "/features/contests" },
            { text: "题单训练", link: "/features/trainings" },
            { text: "客观题套卷", link: "/features/objective" },
            { text: "题目版本管理", link: "/features/problem-versioning" },
            { text: "排行榜与每日签到", link: "/features/ranking" },
            { text: "社区与讨论", link: "/features/community" },
            { text: "站内搜索与私信", link: "/features/search-messages" },
            { text: "系统公告", link: "/features/announcements" },
          ],
        },
        {
          text: "账号与设置",
          items: [
            { text: "账号与密码安全", link: "/users/account" },
          ],
        },
      ],
      "/problemsetters/": [
        {
          text: "出题起步",
          items: [
            { text: "出题人概览", link: "/problemsetters/" },
            {
              text: "快速出一题（5步路径）",
              link: "/problemsetters/quick-start",
            },
            { text: "A+B 完整样例题拆解", link: "/problemsetters/ab-example" },
            {
              text: "Web 题目编辑器全流程",
              link: "/problemsetters/web-editor",
            },
          ],
        },
        {
          text: "题型实战",
          items: [
            { text: "LLM 智能体调用题", link: "/problemsetters/llm-problem" },
            {
              text: "客观题套卷出题",
              link: "/problemsetters/objective-problem",
            },
          ],
        },
        {
          text: "题目规范与质量",
          items: [
            { text: "题目规范总览", link: "/standards/" },
            {
              text: "统一题目包格式规范 (ZIP)",
              link: "/standards/problem-bundle",
            },
            { text: "测试数据与样例规范", link: "/standards/test-data" },
            { text: "题目质量要求与自查清单", link: "/standards/quality" },
          ],
        },
      ],
      "/standards/": [
        {
          text: "出题起步",
          items: [
            { text: "出题人概览", link: "/problemsetters/" },
            {
              text: "快速出一题（5步路径）",
              link: "/problemsetters/quick-start",
            },
            { text: "A+B 完整样例题拆解", link: "/problemsetters/ab-example" },
            {
              text: "Web 题目编辑器全流程",
              link: "/problemsetters/web-editor",
            },
          ],
        },
        {
          text: "题型实战",
          items: [
            { text: "LLM 智能体调用题", link: "/problemsetters/llm-problem" },
            {
              text: "客观题套卷出题",
              link: "/problemsetters/objective-problem",
            },
          ],
        },
        {
          text: "题目规范与质量",
          items: [
            { text: "题目规范总览", link: "/standards/" },
            {
              text: "统一题目包格式规范 (ZIP)",
              link: "/standards/problem-bundle",
            },
            { text: "测试数据与样例规范", link: "/standards/test-data" },
            { text: "题目质量要求与自查清单", link: "/standards/quality" },
          ],
        },
      ],
      "/operators/": [
        {
          text: "安装与部署",
          items: [
            { text: "运营者概览", link: "/operators/" },
            {
              text: "生产部署 (noj-cli)",
              link: "/operators/production-deploy",
            },
            { text: "CLI 运维工具与命令", link: "/operators/cli" },
            {
              text: "生产密钥管理与轮换 Runbook",
              link: "/operators/production-secrets",
            },
          ],
        },
        {
          text: "核心服务运维",
          items: [
            {
              text: "Judge Worker 评测机运维与伸缩",
              link: "/operators/judge-workers",
            },
            { text: "对象存储配置与运维", link: "/operators/storage" },
            {
              text: "提供 LLM 调用能力 (Gateway)",
              link: "/operators/llm-call-capability",
            },
            { text: "邮件送达与退信处理", link: "/operators/email-delivery" },
          ],
        },
        {
          text: "系统管控与合规",
          items: [
            {
              text: "管理后台使用指南 (Admin)",
              link: "/operators/admin-guide",
            },
            {
              text: "竞赛代码相似度：判定与申诉",
              link: "/operators/contest-similarity",
            },
            { text: "可观测性与故障排查", link: "/operators/observability" },
            { text: "公测容量基线验收", link: "/operators/capacity-baseline" },
            { text: "法律与合规指南", link: "/operators/legal-compliance" },
          ],
        },
      ],
      "/mechanisms/": [
        {
          text: "评测内核机制",
          items: [
            { text: "评测机制总览", link: "/mechanisms/" },
            {
              text: "双容器评测模型与状态映射",
              link: "/mechanisms/judge-model",
            },
            { text: "Evaluator SDK", link: "/mechanisms/evaluator-sdk" },
            { text: "Solution SDK", link: "/mechanisms/solution-sdk" },
            { text: "RPC 协议与数据帧格式", link: "/mechanisms/rpc" },
            { text: "评测镜像与隔离运行时", link: "/mechanisms/runtimes" },
            {
              text: "受限网络 Capability 实现",
              link: "/mechanisms/capability-networking",
            },
          ],
        },
        {
          text: "系统底层架构",
          items: [
            { text: "系统架构总览", link: "/system/" },
            { text: "系统分层架构设计", link: "/system/architecture" },
            { text: "端到端安全模型", link: "/system/security" },
            { text: "存储与评测包交付体系", link: "/system/storage" },
            {
              text: "对象存储生命周期治理",
              link: "/system/object-storage-governance",
            },
            { text: "竞赛反作弊与风控数据", link: "/system/anti-cheat" },
          ],
        },
      ],
      "/system/": [
        {
          text: "评测内核机制",
          items: [
            { text: "评测机制总览", link: "/mechanisms/" },
            {
              text: "双容器评测模型与状态映射",
              link: "/mechanisms/judge-model",
            },
            { text: "Evaluator SDK", link: "/mechanisms/evaluator-sdk" },
            { text: "Solution SDK", link: "/mechanisms/solution-sdk" },
            { text: "RPC 协议与数据帧格式", link: "/mechanisms/rpc" },
            { text: "评测镜像与隔离运行时", link: "/mechanisms/runtimes" },
            {
              text: "受限网络 Capability 实现",
              link: "/mechanisms/capability-networking",
            },
          ],
        },
        {
          text: "系统底层架构",
          items: [
            { text: "系统架构总览", link: "/system/" },
            { text: "系统分层架构设计", link: "/system/architecture" },
            { text: "端到端安全模型", link: "/system/security" },
            { text: "存储与评测包交付体系", link: "/system/storage" },
            {
              text: "对象存储生命周期治理",
              link: "/system/object-storage-governance",
            },
            { text: "竞赛反作弊与风控数据", link: "/system/anti-cheat" },
          ],
        },
      ],
      "/intro/": [
        {
          text: "了解 Neuro OJ",
          items: [
            { text: "什么是 Neuro OJ", link: "/intro/what-is-noj" },
            { text: "快速开始", link: "/intro/getting-started" },
            { text: "常见问题 (FAQ)", link: "/intro/faq" },
          ],
        },
        {
          text: "速查参考",
          items: [
            { text: "参考文档总览", link: "/reference/" },
            { text: "评测结果状态代码", link: "/reference/result-status" },
            {
              text: "数据库与 Redis 数据字典",
              link: "/reference/data-dictionary",
            },
            { text: "术语表 (Glossary)", link: "/reference/glossary" },
            { text: "更新日志 (Changelog)", link: "/reference/changelog" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "了解 Neuro OJ",
          items: [
            { text: "什么是 Neuro OJ", link: "/intro/what-is-noj" },
            { text: "快速开始", link: "/intro/getting-started" },
            { text: "常见问题 (FAQ)", link: "/intro/faq" },
          ],
        },
        {
          text: "速查参考",
          items: [
            { text: "参考文档总览", link: "/reference/" },
            { text: "评测结果状态代码", link: "/reference/result-status" },
            {
              text: "数据库与 Redis 数据字典",
              link: "/reference/data-dictionary",
            },
            { text: "术语表 (Glossary)", link: "/reference/glossary" },
            { text: "更新日志 (Changelog)", link: "/reference/changelog" },
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
