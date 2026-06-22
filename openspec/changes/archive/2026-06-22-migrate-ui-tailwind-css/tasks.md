## 1. 基础设施搭建

- [x] 1.1 安装依赖：`@nuxtjs/tailwindcss`、`@tailwindcss/typography`
- [x] 1.2 创建 `tailwind.config.ts`，定义颜色 token 映射到 `--c-*` CSS 变量
- [x] 1.3 在 `tailwind.config.ts` 中配置自定义动画（spin）、代码字体族
- [x] 1.4 在 `nuxt.config.ts` 中注册 `@nuxtjs/tailwindcss` 模块
- [x] 1.5 验证 Tailwind 集成：构建通过

## 2. MonacoEditor 迁移

- [x] 2.1 删除 `MonacoEditor.vue` 的 `<style scoped>` 块
- [x] 2.2 在模板容器 div 上应用 Tailwind
      类：`w-full border border-border rounded-lg overflow-hidden`
- [x] 2.3 验证：编辑器显示正确，边框和圆角与原版一致（构建通过）

## 3. ProblemDescription Markdown 样式迁移

- [x] 3.1 在 `tailwind.config.ts` 中配置 `@tailwindcss/typography` 插件
- [x] 3.2 定义 `prose-neuro` 自定义主题
- [x] 3.3 删除 `ProblemDescription.vue` 的 `<style>` 全局样式块
- [x] 3.4 包裹模板内容为 `<div class="prose prose-neuro max-w-none">`
- [x] 3.5 视觉验证：Markdown 样式渲染正确（构建通过）

## 4. problems.vue 迁移

- [x] 4.1 删除整个 `<style scoped>` 块
- [x] 4.2–4.9 全部 Tailwind 转换完成
- [x] 4.10 验证：列表页渲染完整（构建通过）

## 5. problems/[id].vue 迁移

- [x] 5.1 删除 `<style scoped>` 块
- [x] 5.2–5.10 全部 Tailwind 转换完成
- [x] 5.11 验证：题目详情 + 编辑器和提交功能正常（构建通过）

## 6. submissions/[id].vue 迁移

- [x] 6.1 删除 `<style scoped>` 块
- [x] 6.2–6.10 全部 Tailwind 转换完成
- [x] 6.11 验证：提交结果页所有状态渲染正确（构建通过）

## 7. 收尾验证

- [x] 7.1 全局 grep 确认 5 个文件均无 `<style>` 块残留
- [x] 7.2 构建生产包：`npm run build` 通过
- [ ] 7.3 视觉回归：页面截图与原版对比确认一致
