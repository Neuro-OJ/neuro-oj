# Agent Note: 门面 README 精简与文档站外链

Status: implemented

## Problem

根目录 `README.md` 膨胀到 254 行，把用户、出题人、运营者和开发者四类读者的内容
——题型表、与传统 OJ 的对比表、环境与资源要求表、逐条运维命令、故障排查、品牌设计
——全部堆在 GitHub 首屏。这与 `noj-docs` 文档站的职责重复且长期漂移：同一份信息存
在两处，每次协议、命令或资源基线变化都要双改，README 反而成为过时内容的温床。
同时，仓库内大量指向 `./noj-docs/docs/...` 的相对链接使读者在 GitHub 与文档站之间
来回跳转，且无法从 GitHub 直达已发布的文档。

## Decision

把根目录 `README.md` 收敛为门面：只保留项目定位、核心特性、最短可跑通的生产部署
路径、按角色的文档入口、项目结构、贡献与许可证，共约 75 行。

- 面向用户、出题人、运营者的细节一律外链到 `https://docs.noj.xyber-nova.space`；
  README 不再承载题型表、对比表、环境/资源表、运维命令清单、故障排查与品牌设计。
- 快速开始保留从 Release 下载并校验 `noj-cli`、再由 `install` 完成安装的最小命令，
  其余部署细节（环境、资源、TLS、升级、备份）指向文档站生产部署页。
- 排版遵循 GitHub Markdown 常见写法：顶部 `div align="center"` 居中标题块，
  标准 shields 徽章从 7 个减到 3 个（License、CI、文档站），标题不使用 emoji，
  章节间不插入额外分隔线，最多保留一张角色表。不做自定义品牌配色或过度 HTML。
- 面向贡献者的链接仍保留仓库相对路径（`CONTRIBUTING.md`、`AGENTS.md`、
  `SECURITY.md`、`LICENSE`），因为它们本就在仓库内。
- 因 `noj-docs` 配置 `cleanUrls: false`，文档站链接带 `.html` 后缀。

连带修复 `AGENTS.md` §13 故障排查条目：原 `README.md#故障排查` 锚点随章节删除而
失效，改为直接指向文档站常见问题页。

## Alternatives considered

- **只精简介绍、对比表与项目状态，保留现有部署内容**：README 仍会承载环境与资源
  表、运维命令清单等易漂移内容，重复问题未解决。
- **完全删除快速开始，只留一行文档站入口**：丢失"能跑起来"的最短路径，新运营者需
  先跳转文档站才能看到第一条命令，门面价值下降。
- **徽章套用品牌色（`#1B2B4A` / `#00d68a`）与 `flat-square`**：需要自定义 shields
  URL，且与"遵循 GitHub 常见方案、不加过多风格"的目标冲突，已放弃。
- **在 README 内嵌自定义 HTML/样式做视觉美化**：GitHub 会清洗 `style` 与 `class`，
  收益有限且偏离常见写法。

## Consequences

- README 与文档站的单一事实来源边界清晰：用户/运营细节只维护文档站。
- README 中不再有随版本变化的具体内容（版本号、资源数值、命令全集），漂移面收窄；
  快速开始的 Release 标签 `vX.Y.Z` 仍需在发版时更新。
- 新增文档或运营内容时，默认动作是补充 `noj-docs` 并在 README 外链，而非扩写 README。
- 仓库内其他文件若继续使用 `./noj-docs/docs/...` 相对链接，其维护方式不变。
- 已通过 `scripts/verify-md-links.ts` 的 Markdown 链接门禁（482 个文件）。
