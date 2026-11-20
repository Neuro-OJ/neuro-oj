# Agent Note: 修复文档站 P8 演练说明死链

Status: implemented

## Problem

`noj-docs` 的生产部署和工作区部署页面通过相对路径引用仓库外层的
`dev-docs/engineering/architecture-remediation-p8.md`。VitePress
将该路径视为站点内链接， 构建时报告两个 dead link，导致 Cloudflare Pages
构建失败。

## Decision

将两个链接改为指向 P3–P8 基线提交中的不可变 GitHub 文件 URL。文档站继续保留 P8
演练说明的权威位置，不复制工程文档，也不关闭 VitePress 的死链检查。

## Alternatives considered

- 将 P8 工程文档复制到 `noj-docs/docs`：会产生双份权威内容和同步漂移。
- 配置 VitePress 忽略死链：会掩盖真实的发布文档错误，不能接受。
- 继续使用相对路径：Cloudflare Pages 构建环境不包含 `dev-docs`，无法解析。

## Consequences

文档站可在不携带仓库外层目录的 Cloudflare Pages 构建环境中完成构建；链接固定到
已验证提交，避免随着分支移动改变历史说明。若 P8 文档发生实质更新，应显式更新链接
并重新运行文档站构建。
