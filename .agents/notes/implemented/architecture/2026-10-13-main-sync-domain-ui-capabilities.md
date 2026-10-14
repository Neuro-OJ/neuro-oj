# Agent Note: 在工作空间架构中保留 main 的界面题、预测提交与模型能力

Status: implemented

## Problem

工作空间主题分支与后续 main 同时修改题包、代码题编辑器和 LLM 管理页面。main
新增了预测单文件提交、界面题、模型别名和 Provider RPM/TPM；主题分支取消 P/U、
采用显式 Domain
路径，并将模型和密钥归属使用域。直接选择任何一侧会丢失另一侧行为。
旧管理页面即使合并新控件，也会在进入页面前固定跳往 main 的 Domain 页面，不能
作为这些新功能已接入实际产品的证据。

## Decision

- 旧题包入口继续固定 main，委托已有 Domain 原子导入与草稿编辑；不恢复 P/U
  分类、全局 Provider 配置或旧导入权限分支。格式 2 保留模型能力别名 `models`，
  仅校验语法；真实 Provider 和模型由使用域解析。格式 1 P 转换与 U 拒绝保持。
- 在真正使用的 Domain 导入链校验界面题的 `ui.html` 存在及大小。文件留在不可变
  版本的支持包中，读取接口先授权当前绑定、共享和目标版本，再复用安全的支持包读取。
  界面脚本模板不通过普通 `/template` 端点公开。
- Domain 题目与比赛作答直接复用沙箱 `UiFrame`，参数使用原有域、账号、题目、版本
  草稿键和普通同域提交系统。使用受授权的 Domain `/ui` 入口，不依赖旧全局轮询。
  界面自测复用已有 Domain 自测面板；等参数更新传递到子组件后执行。
- 预测模式通过现有域文件提交入口上传单个白名单文件。草稿编辑保留工作区配置，
  保存预测模式时省略 Solution；界面和预测模式均保留首次发布后不可修改的约束。
- 实际 Domain LLM 页面新增 RPM/TPM、目标 Provider 连接测试与模型别名治理。
  别名写入按其资源 revision 使用 CAS，新建为 0；确认删除后重新核对域和账号。
  冲突保留表单及编辑基线，重读列表不把其他操作者的新版本冒充当前草稿的基线。
- CLI 没有题包 vendor 生成脚本；按现有刻意副本约定，从 canonical 校验文件同步
  内容并替换 CLI 本地导入路径，以同一共享 fixture 验证两份实现。

## Alternatives considered

- 只解决文本冲突：实际 Domain 页面仍缺界面、预测与模型治理能力，旧页面会先被
  重定向，无法交付 main 的新增行为。
- 把旧 `UiWorkspace` 的全局历史轮询直接接入 Domain 页面：会引入上下文旁路，
  因此复用 `UiFrame` 与已有 Domain 提交、草稿、自测组件。
- 在发布或导入时把模型能力绑定某部署 Provider：共享题在其他域不能独立选择
  执行配置，故只保留能力声明，由尝试创建时解析使用域映射。

## Consequences

本批仅修改隔离集成工作区，不重启已验收运行栈、不修改 Schema、迁移、锁文件或 操作
jj。Gateway/比赛可信执行协议由另一批负责，Schema 与最终整栈验收由根 Agent
统一管理。

验证：CLI 完整测试 759 通过、4 忽略；UI 完整单元测试 277 通过；完整组件测试 65
文件、240 通过，最终针对性 6 文件、23 通过。UI 两项类型检查与自有文件 格式、lint
通过。标准 catalog PGlite 与 PostgreSQL 聚焦测试各 11 通过（各另有引导测试 8
通过）， 覆盖共享 UI
的目标域固定版本、错误域、模板保密、版本冲突、共享撤销和作者能力 DTO。真实 PG
首轮定位了根批生成迁移中别名主键和社区复合外键的排序错误，根批 修复后对独立测试
Schema 从空库执行全部迁移并完成上述验证。日志为
`/tmp/noj-integration-catalog-focused-pg-third.log`；PGlite 日志为
`/tmp/noj-integration-catalog-focused-pglite-third.log`。本批未把单元或组件验证宣称为
真实 Browser/Judge 全链路验收；整合后的全量回归、构建与运行验收由根 Agent 协调。
