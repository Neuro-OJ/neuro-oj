## MODIFIED Requirements

### Requirement: MkDocs Material 配置

文档站 SHALL 使用 MkDocs Material，并提供可搜索、可导航的静态文档体验；文档站主题 SHALL 同步 NOJ 品牌设计 token（暖纸、墨字、品牌蓝、评测绿），不得继续使用与前端不一致的默认主题色。

#### Scenario: 本地预览

- **WHEN** 维护者在 `noj-docs` 内运行文档中声明的预览命令
- **THEN** MkDocs 为文档站启动本地开发服务器，并使用 NOJ 品牌主题配置

#### Scenario: 读者导航

- **WHEN** 读者打开生成后的文档站
- **THEN** 导航中展示做题人、运营者、出题人和参考四个主要分区，且主题色与 NOJ 品牌 token 一致

#### Scenario: 品牌视觉同步

- **WHEN** 维护者变更 `docs/design/` 中的品牌 token
- **THEN** 文档站主题配置与 `noj-ui` 的 token 保持一致，避免文档站与前端出现两套视觉
