## 1. 登录步骤界面

- [x] 1.1 将 `noj-ui/pages/login.vue` 拆为密码登录界面和 TFA 验证界面，确认初始界面不展示 TFA 字段，收到 `TFA_REQUIRED` 后正确切换；项目级类型检查通过。
- [x] 1.2 在 TFA 界面增加当前账号提示、验证码输入、登录按钮和返回登录按钮，确认返回后清理 TFA 临时状态并保留用户名/密码内存值；页面构建检查覆盖该界面。

## 2. 现有 TFA 能力兼容

- [x] 2.1 将恢复码文件导入和恢复码选择入口迁移到独立 TFA 界面，确认文件仍只在浏览器本地解析；代码检查未发现文件上传或持久化操作。
- [x] 2.2 确认 TFA 登录失败停留在第二步，登录请求仍只提交单个 `code`，且不自动尝试其他恢复码；`auth.login` 调用参数保持单码提交。

## 3. 验证与收尾

- [x] 3.1 在 `noj-ui` 运行 `deno fmt --check`、`deno lint`、`deno check`/`deno task check` 和 `deno task build`；`deno task check` 与 Nuxt 生产构建均通过。
- [x] 3.2 运行 `deno task test`，并通过 OpenSpec 严格校验 `separate-tfa-login-step`，核对现有 TFA E2E 不回归；UI 测试 31 个通过，后端 TFA 单元/服务/路由测试 23 个通过。
