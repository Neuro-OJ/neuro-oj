# NOJ 文档站

`noj-docs` 是 Neuro OJ 面向做题人、运营者和出题人的正式文档站，使用 [VitePress](https://vitepress.dev/) 构建（统一到项目 Vue 生态）。

## 本地预览

```bash
cd noj-docs
npm install
npm run docs:dev
```

默认预览地址为 `http://localhost:5173`。

## 构建

```bash
cd noj-docs
npm run docs:build
```

构建产物输出到 `docs/.vitepress/dist/`。构建会检查内部链接（坏链会报错），提交文档变更前应至少运行一次。

## 预览构建产物

```bash
npm run docs:preview
```

## 目录结构

- `docs/` — Markdown 内容（`index.md` 为首页 hero 布局，`users/` `operators/` `problemsetters/` `reference/` 四个分区）
- `docs/.vitepress/config.ts` — 站点配置（nav、sidebar、搜索、主题）
- `docs/.vitepress/theme/` — 主题自定义（品牌色与 noj-ui 一致，后续美化从这里扩展）

## 维护约定

- 正文优先使用中文，代码标识符、命令、状态名和协议字段保留原文。
- 面向读者写作，避免混入内部开发流程或实现讨论。
- 出题人文档必须与 `noj-core/data/problems-src`、统一题目包构建脚本和 `noj-judge` Python SDK 的当前行为一致。
- 当评测协议、SDK 或 seed 脚本变化时，同步更新对应文档。
- 自定义容器使用 VitePress 语法（`::: warning 标题`）；标题锚点使用 `{#anchor}` 行尾语法。
