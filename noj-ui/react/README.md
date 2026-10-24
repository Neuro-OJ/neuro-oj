# React 前端迁移（第一批）

当前范围是 React 基础与练习核心流程。React 代码位于本目录，使用 React 19、React Router 和 shadcn/ui
6；`pages/react/[...path].vue` 仅提供 Nuxt SSR、Cookie 请求上下文与客户端挂载适配。后端 API、Nitro 认证代理及 Deno
部署产物继续共用。

## 路由

| 入口                     | 页面                                                           |
| ------------------------ | -------------------------------------------------------------- |
| `/react`                 | 首页：轮播、签到、公告、随机题目、最新评测与关注动态           |
| `/react/login`           | 账号登录、记住我、动态码/恢复码；第三方登录沿用现有 OAuth 入口 |
| `/react/problems`        | 题库与 URL 筛选、分页                                          |
| `/react/problems/:id`    | 题面 SSR、版本选择、产物/预测文件上传                          |
| `/react/editor/:id`      | Monaco、分版本草稿、模板、自测与正式代码提交                   |
| `/react/submissions`     | 本人提交列表与筛选                                             |
| `/react/submissions/:id` | 实时状态、测试点、各版本判定及全部评测尝试                     |

竞赛、训练、社区、管理、账户设置、出题、客观题与界面题的专用流程仍由原页面提供。 原 URL 和全部 Vue
页面保留。当前不切换全站默认路由，也不把这些领域标记为已迁移。 新页面沿用原项目文案，不添加框架、迁移状态或宣传说明。

## 运行与验证

```bash
deno install
deno task dev
# 浏览器打开 http://localhost:3000/react

deno task check:types:react
deno task check:types:nuxt
deno task lint
deno task test
deno task test:react
deno task test:components
deno task build
```

浏览器回归使用本地夹具，不需要数据库或真实账号。先启动构建产物，再在另一终端运行测试：

```bash
NUXT_API_BASE=http://127.0.0.1:8071 NUXT_NOJ_ENV=development PORT=3072 HOST=127.0.0.1 \
  deno run -A .output/server/index.mjs

E2E_UI_URL=http://127.0.0.1:3072 deno task test:react:browser
```

测试进程在 `127.0.0.1:8071` 提供临时上游；此端口必须空闲。 `NOJ_REACT_SCREENSHOTS` 可设置截图输出目录。CI
对生产构建执行同一任务。

## 边界约定

- React 业务请求统一使用 `state.tsx` 提供的 API 层，禁止读取 JWT、直接访问 core 或把 token 放入本地存储。登录/改密
  Cookie 的安全边界仍在既有 Nitro 代理中。
- `bootstrap.ts` 和 React Context 均按请求创建；shadcn/ui 使用静态 Tailwind
  样式。不得新增服务器进程级用户状态或资源缓存。
- `scripts/react-tsx.ts` 仅转换本目录的 TSX。文件声明 React JSX 运行时，避免 Vue 与 React 的类型、编译和 Refresh
  配置互相污染。当前开发模式采用模块更新/页面重载，不引入全局 React Refresh。
- `utils/markdownRender.ts` 与 Vue 共用，保留 DOMPurify、KaTeX 和图片策略。
- 提交和自测必须携带实际作答的 `version_id`。版本冲突保留代码，由用户确认刷新，不自动换版重提。
- 本地草稿按账号、内部题目 ID、版本和语言隔离；模板异步响应不得覆盖用户编辑。
- SSE 与轮询仅在非终态持续；离开页面、出现明确错误或进入终态时释放资源。
- 通用组件使用 shadcn/ui，布局沿用 Tailwind 与 NOJ token。配色沿用现有规范。

## 组件来源

`components/ui/` 基于 [shadcn/ui 官方 registry](https://ui.shadcn.com/docs/registry) 的 `new-york-v4` Radix 组件，按 NOJ
近直角规范调整圆角，保留 MIT 许可。 `components.json` 记录安装位置；组件源码归仓库维护。
