<!-- Logo 重新设计后在此插入居中图片：<p align="center"><img src="..." width="96" alt="Neuro OJ"></p> -->

<h1 align="center">Neuro OJ</h1>

<p align="center">面向 AI 领域认证与竞赛的开源在线评测平台</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue" alt="License"></a>
  <a href="https://github.com/Neuro-OJ/neuro-oj/actions/workflows/ci.yml"><img src="https://github.com/Neuro-OJ/neuro-oj/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://docs.noj.xyber-nova.space"><img src="https://img.shields.io/badge/docs-%E6%96%87%E6%A1%A3%E7%AB%99-blue" alt="文档站"></a>
</p>

<p align="center">
  <a href="https://docs.noj.xyber-nova.space">文档站</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#文档">文档</a> ·
  <a href="#参与贡献">参与贡献</a>
</p>

---

Neuro OJ（NOJ）是独立社区项目，与 CCF、LMCC、IOAI 及 NOAI 无任何官方关系。

## 简介

NOJ 提供从“注册 → 做题 → 提交 → 评测”的完整流程，可用于 LMCC 备考与模拟训练、AI 认证与选拔、课程实训和模型评测竞赛。

它与传统 OJ 的主要区别是：题目通过 evaluator 调用用户实现的函数并完成评分，而不是只比较标准输入输出（stdin/stdout）。这种方式更适合评测大模型应用和 AI 工程能力。

## 核心特性

- **函数调用型评测**：由 evaluator 驱动测试并自定义评分逻辑，覆盖客观题、代码题、LLM 工程题和产物提交题。
- **双容器安全沙箱**：用户代码与评测代码在独立 Docker 容器中隔离运行，Solution 关闭网络，Evaluator 可按题目配置联网并受资源限制。
- **完整竞赛与社区**：题目筛选、提交记录、排行榜、竞赛、实时评测状态，以及社区互动与 RBAC 权限管理。
- **LLM 调用网关**：统一管理 Provider、访问凭据、限流与用量审计。

## 快速开始

生产环境使用单机 Docker Compose 部署。从 Release 下载 `noj-cli` 二进制并校验，再由它完成安装：

```bash
VERSION=v0.9.5
curl -fsSLO "https://github.com/Neuro-OJ/neuro-oj/releases/download/$VERSION/noj-cli-linux-amd64"
curl -fsSLO "https://github.com/Neuro-OJ/neuro-oj/releases/download/$VERSION/noj-cli-linux-amd64.sha256"
sha256sum -c noj-cli-linux-amd64.sha256
chmod +x noj-cli-linux-amd64
./noj-cli-linux-amd64 install --dir /opt/neuro-oj
```

环境要求、资源配置、TLS、升级与备份详见文档站[生产部署](https://docs.noj.xyber-nova.space/operators/production-deploy.html)。

## 文档

完整文档见 [docs.noj.xyber-nova.space](https://docs.noj.xyber-nova.space)。

| 角色 | 从这里开始 |
| --- | --- |
| 做题人 | [做题人文档](https://docs.noj.xyber-nova.space/users/) |
| 出题人 | [出题人文档](https://docs.noj.xyber-nova.space/problemsetters/) |
| 运营者 | [运营者文档](https://docs.noj.xyber-nova.space/operators/) |

- [什么是 Neuro OJ](https://docs.noj.xyber-nova.space/intro/what-is-noj.html)：了解评测模型与传统 OJ 的区别
- [快速开始](https://docs.noj.xyber-nova.space/intro/getting-started.html)：完成第一次注册、做题和提交
- [常见问题](https://docs.noj.xyber-nova.space/intro/faq.html)：排查常见使用与部署问题

开发者请阅读[贡献指南](./CONTRIBUTING.md)与[项目开发约定](./AGENTS.md)。

## 项目结构

```text
noj-ui               Nuxt 4 + Vue 3 前端
noj-core             Deno + Hono API 与业务服务
noj-judge            Rust + Docker 评测 Worker
noj-llm-gateway      LLM 调用网关
noj-lmcc-extension   LMCC IDE / VS Code 做题插件
noj-tests            跨模块全链路测试
noj-docs             用户、运营者和出题人文档站
```

核心评测链路：

```text
浏览器 → noj-ui → noj-core → Redis 队列 → noj-judge → 评测结果
```

## 参与贡献

欢迎通过 Issue 和 Pull Request 参与项目。修改代码前请先阅读[贡献指南](./CONTRIBUTING.md)与[项目开发约定](./AGENTS.md)。

- [提交 Issue](https://github.com/Neuro-OJ/neuro-oj/issues)
- [报告安全漏洞（私下）](./SECURITY.md)
- [查看 CI](https://github.com/Neuro-OJ/neuro-oj/actions)

## 许可证

本项目基于 [GNU Affero General Public License v3.0](./LICENSE) 开源。
