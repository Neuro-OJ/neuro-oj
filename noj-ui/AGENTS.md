# noj-ui — Neuro OJ 核心前端

基于 **Nuxt 3 + Vue 3** 的用户界面。

## 职责

- 用户注册、登录、个人中心
- 题目列表与题目详情展示
- 代码编辑器（提交代码）
- 评测结果展示（实时 / 历史）
- 通过 RESTful API 与 noj-core 交互

## 技术栈

| 组件       | 选择                               |
| ---------- | ---------------------------------- |
| 框架       | Nuxt 3 (Vue 3)                     |
| 语言       | TypeScript                         |
| 组件库     | 待定（Nuxt UI / Ant Design Vue）   |
| 代码编辑器 | 待定（Monaco Editor / CodeMirror） |
| 部署       | Node.js / 静态导出                 |

## 目录约定

```
noj-ui/
├── package.json
├── nuxt.config.ts     # Nuxt 配置
├── tsconfig.json
├── app.vue            # 根组件
├── pages/             # 文件路由（Nuxt 自动路由）
├── components/        # 可复用组件
├── composables/       # 组合式函数（状态/逻辑复用）
├── layouts/           # 页面布局
├── server/            # Nitro 服务端 API（代理 to noj-core）
├── public/            # 静态资源
└── assets/            # 构建资源（CSS、图片等）
```

## 编码规范

- 使用 `<script setup lang="ts">` 语法
- 使用 Composition API（避免 Options API）
- 组件命名：PascalCase
- 页面文件：kebab-case，按资源组织
- API 调用统一封装在 `composables/` 中
- 使用 `useFetch` / `useAsyncData` 进行数据获取
- 类型定义放在 `types/` 目录

### 示例组件

```vue
<script setup lang="ts">
interface Props {
  title: string
}

defineProps<Props>()
</script>

<template>
  <div class="card">
    <h2>{{ title }}</h2>
  </div>
</template>
```

## API 交互约定

- noj-core 地址通过服务端私有环境变量 `NUXT_API_BASE` 配置
- 所有 API 调用统一通过 `server/api/` 代理（避免 CORS + 隐藏内部地址）
- 错误处理：全局封装，统一 toast 提示

## 贡献要求

- **所有提交必须 GPG 签名**（参见根目录 README.md 配置步骤）
- **仅通过 PR 贡献**，禁止直接推送到 main
- 提交信息遵循 Conventional Commits（`feat(ui): ...` / `fix(ui): ...`）

## 相关文档

- [Nuxt 3 文档](https://nuxt.com/docs)
- [Vue 3 文档](https://vuejs.org/)
