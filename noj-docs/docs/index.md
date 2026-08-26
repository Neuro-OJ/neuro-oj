---
layout: home

hero:
  name: "Neuro OJ"
  text: "面向 AI 领域认证与竞赛的在线评测平台"
  tagline: 函数调用型评测 / 双容器隔离沙箱 / 竞赛 · 社区 · RBAC
  actions:
    - theme: brand
      text: 什么是 Neuro OJ
      link: /intro/what-is-noj
    - theme: alt
      text: 快速开始
      link: /intro/getting-started
    - theme: alt
      text: 快速出一题
      link: /problemsetters/quick-start

features:
  - icon: 🧩
    title: 函数调用型评测
    details: 实现题面声明的函数，由 evaluator 调用并评分，而非传统的 stdin/stdout 判题。
  - icon: 📦
    title: 双容器隔离评测
    details: 用户代码与评测代码在独立 Docker 沙箱容器中运行，网络关闭、无特权、资源受限。
  - icon: ⌨️
    title: 在线编辑器
    details: Monaco 编辑器，支持语法高亮与提交历史，提交后立即可见排队与评测结果。
  - icon: 🏆
    title: 社区与竞赛
    details: 帖子与关注动态流，icpc / ioi / oi 三赛制竞赛与实时排名，RBAC 权限管理。
---
