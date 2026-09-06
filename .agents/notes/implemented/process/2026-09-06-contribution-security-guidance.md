# Agent Note: 补齐贡献与安全报告入口

Status: implemented

## Problem

仓库原有开发约定、Pull Request 模板和模块文档，但缺少面向外部贡献者的集中贡献指南、私下安全漏洞报告说明和结构化 Issue 模板。外部贡献者难以确认本地启动、模块测试、分支协作、提交签名及缺陷报告所需的信息。

## Decision

新增根目录 `CONTRIBUTING.md` 和 `SECURITY.md`，在 `.github/ISSUE_TEMPLATE/` 中提供缺陷、功能建议模板及安全漏洞入口配置，并从 README 和开发指南互相导览。贡献指南复用现有 `AGENTS.md` 与 `dev-docs/engineering/development.md` 的规则；安全文档使用 GitHub 私下漏洞报告入口，不公布未经确认的个人联系人。版本支持以最新正式 Release、`main` 和维护者明确指定的 `dev` 为边界，避免承诺未维护的旧版本和快照。

## Alternatives considered

- 只在 README 增加几行说明：入口集中但无法为缺陷、功能和安全报告提供结构化字段。
- 公布个人邮箱或新建外部表单：当前没有经过维护者确认的联系人或服务，容易造成失效入口和敏感信息外泄。
- 建设独立贡献者门户：超出本 Issue 的必要范围，会增加部署和长期维护成本。

## Consequences

贡献者可以从 README 进入贡献、安全和 Issue 流程，并在提交前使用可执行的启动、测试和签名检查清单。GitHub 私下漏洞报告入口是否可见仍取决于仓库设置；若未启用，文档明确要求不要公开披露技术细节。模板和支持版本说明需要随着分支策略、Release 流程或 GitHub 安全设置变化同步更新。
