# Agent Note: 关闭跟随系统的暗色模式，修复原生复选框/单选框黑块

Status: implemented

## Problem

操作系统为暗色时，客观题编辑器标签复选框、小题答案单选/复选框、答题选项等原生
`<input type="checkbox|radio">` 在白底卡片上渲染为纯黑色块。

根因：Nuxt UI 默认启用 `@nuxtjs/color-mode`（`preference: system`），系统暗色时给
`<html>` 加 `.dark`；Nuxt UI 生成的 `#build/ui.css` 对 `body` 应用
`scheme-light dark:scheme-dark`，于是 `body` 及其中所有原生控件的 `color-scheme`
变为 `dark`（`<html>` 本身为 `normal`）。但站点并未真正支持全站暗色：`--c-*` 仅在
编辑器 `.editor-dark` 内切换，`main.css` 以非 layer 的 `:root` 覆盖 `--ui-bg` 等变量使其
保持亮色，86 个组件中有 259 处硬编码 `bg-white`/`bg-gray-50`，也没有主题切换入口。
`--ui-text-inverted` 等未覆盖变量随之半切换为暗色，此前已为 solid 按钮、选中 Tab、
复选框对勾分别打过 `.dark` 补丁，均为同一根因。

## Decision

- `nuxt.config.ts` 设置 `ui.colorMode: false`，不再安装 color-mode，`<html>` 不会出现
  `.dark`，全站 `color-scheme` 与实际亮色渲染一致。
- 删除 `main.css` 中已失效的 `.dark` 补丁（按钮白字、Tab 白字、复选框对勾、`.dark body`、
  `.dark .bg-tech-grid`）。
- `app.vue` 中 `.editor-dark` 增加 `color-scheme: dark`：编辑器暗色主题是唯一真正切换
  `--c-*` 的区域，其内原生控件与滚动条随之使用暗色外观。

## Alternatives considered

- 让暗色模式完整生效（`.dark` 下切换 `--c-*`、把 259 处硬编码亮色背景改为 token）：
  改动面过大且缺少主题切换 UI 与设计验收，留待正式做全站暗色时进行。
- `colorMode.preference: 'light'`：仍会注入 color-mode 脚本，且浏览器本地存储中残留的
  偏好值仍可能让 `.dark` 生效，不如直接关闭彻底。
- 仅在三个组件上加 `scheme-light`：只是症状补丁，其他页面的原生控件与 Nuxt UI 半切换问题仍在。

## Consequences

- 全站固定亮色；模板中零星的 `dark:` 变体（约 12 处）暂不生效，保留以便将来启用暗色。
- 正式支持全站暗色时需：恢复 `ui.colorMode`，为 `.dark` 定义整套 `--c-*` 与
  `--ui-*`（含 `--ui-text-inverted`），并清理硬编码亮色背景。
- `@nuxtjs/color-mode` 仍保留在 `package.json` 依赖中（未改动 `deno.lock`），不再被加载。
