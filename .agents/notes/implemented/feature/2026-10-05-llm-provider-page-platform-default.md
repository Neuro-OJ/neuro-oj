# Agent Note: LLM Provider 页就近配置平台默认 Provider / 模型

Status: implemented

## Problem

LLM 题评测要求同时配置 `llm_default_provider_id` 与 `llm_default_model`（noj-core runtime 系统设置，无回退），缺任一项提交即 400「平台未配置默认 LLM Provider / 模型」。

线上运营者在「LLM → Provider 管理」建好 Provider 后仍然报错：

- 这两项只能在「系统设置」的「运行时配置（可编辑）」表里改，而该表是几十项平铺、**不按分类分组**；
- 文档写的「系统设置 → LLM」入口在 UI 上并不存在（`category: "llm"` 只用于只读 env 面板分组）；
- Provider 页没有任何提示需要另行配置默认模型。

## Decision

- `noj-ui/pages/admin/llm/providers.vue` 顶部新增「平台默认 Provider / 模型」卡片：
  - 复用 `GET /api/v1/admin/system/settings` 读取两项当前值与来源（后台设置 / 环境变量 / 未配置）；
  - Provider 用下拉框从当前列表选择（停用项标注「已停用」，未知 ID 原样保留为选项），模型为文本输入；
  - 保存时校验两项同时非空，只对有变化的键调用 `PUT /api/v1/admin/system/settings/:key`（带 `If-Match` 乐观锁）；
  - 已生效的默认 Provider 不在列表中或已停用时给出警告；列表中默认 Provider 名称旁带「默认」标记。
- 纯前端改动，不新增后端接口：两个页面同属管理员后台，权限一致。
- 文档中所有「系统设置 → LLM」改为指向 Provider 管理页顶部。

## Alternatives considered

- **新增专用后端接口（如 `/admin/gateway/llm/platform-default`）一次写两项**：可做原子写入，但需要新增路由与测试；当前通用设置接口已足够，部分写入失败时卡片会显示错误且保留表单值，可重试。
- **只让系统设置页按分类分组**：仍需运营者知道去系统设置找，就近入口更直接；分组可后续单独改进。

## Consequences

- 两项设置有两个编辑入口（Provider 页 / 系统设置页），底层是同一组键，不存在不一致。
- 两次 PUT 非原子：若第一项成功、第二项失败，会出现「只配一半」状态，卡片顶部状态标记会显示「未配置」，提示运营者重试。
