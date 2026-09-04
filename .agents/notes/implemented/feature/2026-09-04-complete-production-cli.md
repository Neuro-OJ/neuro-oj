# Agent Note: 补齐 noj-cli 生产运维与一键安装入口

Status: implemented

## Problem

根目录 noj 删除后，安装器回退执行 deploy.sh，无法提供文档承诺的 PATH 命令。
noj-cli 的 JSON 编排未覆盖现有生产 Compose 的初始化、升级、签名验证、Judge 和邮件配置。

## Decision

- noj-cli 增加生产顶层命令，复用从原 noj 提取的 scripts/deploy/production.sh。
  部署、配置引导和备份继续调用 deploy.sh / backup.sh，保留 .env.prod、服务名与数据卷。
- install.sh 下载同 ref 源码和 Linux amd64 CLI，在写入安装目录前验证 SHA-256，
  原子替换 bin/noj-cli 后调用 install。缺少 Release 资产时明确失败，不混用版本。
- 镜像验证通过后发布 CLI 二进制及校验文件；PR 与 Release 均运行 CLI 和离线安装测试。
- config check 不检查远端镜像、不修改配置或服务；完全卸载在删除 Compose 数据前验证目录，拒绝 Git/jj 工作区。
- JSON deploy/maintain 命令独立保留；restore 别名执行实际恢复，未知运维命令返回失败。
- 修复 CLI 既有测试中的 macOS 临时目录规范化和日志订阅就绪竞态，使发布验证可重复运行。

## Alternatives considered

- 仅恢复根目录 noj：可修复入口，但仍要维护两套公开 CLI。
- 直接用 deploy init/up 替换旧安装：生成的 Compose 不等价，可能遗漏生产配置或创建另一套数据卷。
- 一次性将全部 Shell 编排重写为 TypeScript：迁移面大，增加升级、备份和数据卷兼容风险。

## Consequences

生产机无需 Deno。CLI 依赖安装目录中的内部脚本，不能只复制单个二进制管理生产部署。
已有生产配置无需转换，JSON 编排仍是独立模式。新安装链路需先发布含 CLI 资产的新 Release；
旧 Release 继续使用其自身的安装器。开发测试采用模拟 Docker/下载，不修改生产服务。
