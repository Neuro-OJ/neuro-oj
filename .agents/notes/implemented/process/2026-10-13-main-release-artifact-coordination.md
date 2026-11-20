# Agent Note: 集成构建产物与 LMCC 宿主证据版本协调

Status: implemented

## Problem

教学写频率限制已在源码验证，但正式 core 镜像仍需同步。LMCC 的 Node
单元测试与真实 Extension Host
证据也需核对是否适用于集成源码，避免把旧产物或模拟后端的宿主测试描述为完整运行栈验收。

## Decision

- 通过标准 core Dockerfile 构建独立标签
  `noj-upgrade-server:20261013-main-release`，不替换任何运行中的服务、Compose
  或旧镜像标签。
- 此产物包含教学写频率限制，其实际 image ID 为
  `sha256:3e4f6307daa6da7ba01491e145224f053d236067c1202efc0abdc4507f101ee9`，
  正式入口为 `/app/bin/noj-server`。构建退出码为 0。
- 构建完成后发现 main 又合入 #641 题包 Web/CLI push，因此该镜像明确代表 #641
  集成前的冻结版本；通知恢复验收 agent 使用实际 digest 记录版本，不将其称为 #641
  最终 release。
- 核实 LMCC 9 个源码文件、宿主启动脚本与 TypeScript
  配置与此前八项真实宿主验收时逐字节一致，package
  配置仅版本号变化。锁文件哈希保持不变。

## Alternatives considered

- 仅以最新标签推断运行容器或验收版本，容易混淆重建前后的 image ID，拒绝。
- 将原 Extension Host 的本地模拟 HTTP 当作真实 core/Judge
  验收，证据范围不符，拒绝。
- 无必要地重复启动 GUI 宿主或全栈回归，本次复核相同源码及已存报告，仅补标准 LMCC
  检查。

## Consequences

当前 LMCC 标准 `npm run test` 实际重新编译并完成 14 项测试，0 失败、0 跳过；
`npm run check` 的格式与类型检查通过。集成目录初次缺少 node_modules，误用全局
TypeScript 6 与缺失 Prettier 的执行没有计入通过；随后通过锁文件安装模块依赖，
没有修改锁文件。npm 的 remote 下载配置须显式允许锁文件的已有
tarball，未更改全局配置。

此前真实 Code 1.138.0 Extension Host 八项报告仍对应当前宿主相关源码，证据边界为
真实编辑器宿主、自动交互回答和本地模拟
HTTP；不代表最低编辑器版本、真实后端评测或 新 push 功能。后续 #641 集成和新 CLI
编译另行记录，不借本次镜像覆盖未来验收。
