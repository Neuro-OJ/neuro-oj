## 1. 设计 token 基础

- [x] 1.1 新增 `docs/design/noj-design-tokens.md`，记录暖纸/墨字/品牌蓝/评测绿的亮暗色值、对比度和用途
- [x] 1.2 更新 `noj-ui/app.vue` 的 `:root`：替换中性色、新增 `--c-signal`/`--c-signal-deep`/`--c-signal-rgb`、更新品牌蓝为 `#1B2B4A`
- [x] 1.3 更新 `noj-ui/assets/css/main.css`：将新 token 映射到 Tailwind `@theme` 与 Nuxt UI `--ui-*` 变量
- [x] 1.4 将默认圆角调整为 2–6px 近直角，并核对现有组件没有硬编码大圆角
- [x] 1.5 为分数、耗时、排名等数值场景启用 `tabular-nums`，形成统一规范

## 2. UI 风格与信号色

- [x] 2.1 梳理现有 `text-primary` / `bg-primary` 等使用点，区分“品牌蓝”和“评测信号绿”语义
- [x] 2.2 将主按钮、选中态、焦点环、进行中状态迁移到评测绿 `#00d68a`
- [x] 2.3 将 Logo、导航、品牌链接保留/迁移到蓝黑墨 `#1B2B4A`，暗色使用 `#7C96D6`
- [x] 2.4 更新状态色（成功/警告/错误/信息）以匹配新视觉
- [x] 2.5 运行 UI/SSR/构建验证，确认组件颜色没有不可读组合

## 3. 文档同步

- [x] 3.1 更新 `AGENTS.md`：新增“品牌与设计系统”章节，指向 `docs/design/`，并说明 token 是项目规范
- [x] 3.2 更新 `noj-ui/CLAUDE.md`：补充新 token、圆角、信号色相关说明
- [x] 3.3 更新 `noj-docs` 文档站主题，使文档站配色与 NOJ 品牌一致
- [x] 3.4 更新根 `README.md` 与宣传相关描述，体现新品牌视觉
- [x] 3.5 检查其他开发文档（如 `docs/engineering/`、模块 README）中提及品牌色的地方并同步

## 4. 验证与归档

- [x] 4.1 运行 `deno fmt` / `deno lint` / 相关 UI 构建检查
- [x] 4.2 运行设计文档链接检查与 OpenSpec 校验
- [x] 4.3 人工检查亮色/暗色、移动端、编辑器页面中的品牌色
- [ ] 4.4 完成变更后按 OpenSpec 流程 `/opsx:archive` 归档，更新主 specs
