## 1. 数据库：新建 judge_images 表 + 种子数据

- [ ] 1.1 在 `src/db/schema.ts` 中定义 `judgeImages` 表（id, image, mode, description, created_at, updated_at），含 CHECK 约束限制 mode 为 'exact' 或 'all_versions'
- [ ] 1.2 生成 Drizzle 迁移文件（`deno task db:generate`），确认 SQL 迁移文件正确
- [ ] 1.3 修改 `scripts/seed.ts`：在 `seedProblems` 前插入初始白名单记录（`all_versions: "noj-judge-python"`, 介绍: "Python 3.12 评测环境"），确保开箱可用

## 2. 后端：镜像白名单管理 API（管理员）

- [ ] 2.1 创建 `src/services/judge-images.ts`：实现 `listJudgeImages`、`createJudgeImage`、`updateJudgeImage`、`deleteJudgeImage`
- [ ] 2.2 在 `src/routes/admin.ts` 中新增路由组 `/judge-images`：
  - `GET /` → 列出所有白名单条目
  - `POST /` → 新增白名单条目（校验 mode 合法、image 非空）
  - `PUT /:id` → 更新白名单条目（description、mode、image）
  - `DELETE /:id` → 删除白名单条目
- [ ] 2.3 在 `src/types/` 中新增 `JudgeImageInput`、`JudgeImageResponse` 类型定义

## 3. 后端：公开列表 API + 题目创建/更新校验

- [ ] 3.1 在 `src/routes/problems.ts` 中新增 `GET /api/v1/judge-images`（注意：此路由必须在 `/:id` 之前注册或独立注册），返回所有白名单条目
- [ ] 3.2 修改 `src/services/problems.ts` 的 `createProblem` 和 `updateProblem`：始终校验 `judge_image` 是否匹配白名单（exact 完全相等；all_versions 匹配镜像名前缀）。白名单为空时拒绝所有镜像，提示"系统尚未配置允许的评测镜像"；镜像不匹配时提示"评测镜像 'xxx' 不在允许列表中"
- [ ] 3.3 在 `src/services/judge-images.ts` 中实现 `validateJudgeImage(image: string)` 函数，返回 boolean

## 4. 前端：管理后台镜像白名单页面

- [ ] 4.1 创建 `pages/admin/judge-images.vue`：使用 AdminTable 展示白名单列表（列：镜像名、模式标签、介绍截断、创建时间）
- [ ] 4.2 实现新增/编辑弹窗（AdminModal）：镜像名输入框、mode 选择（精确版本 / 所有版本）、介绍文本域
- [ ] 4.3 实现 `all_versions` 模式安全警告：当管理员选择"所有版本"时，弹窗内展示橙黄色警告文案，说明安全风险（不阻止操作）
- [ ] 4.4 实现删除确认弹窗（AdminModal danger 模式）
- [ ] 4.5 在管理后台侧边栏（`layouts/admin.vue`）添加"评测镜像"导航项

## 5. 前端：题目编辑器镜像下拉选择

- [ ] 5.1 修改 `components/ProblemEditor.vue`：`judgeImage` 来源改为 `GET /api/v1/judge-images`，渲染为 `<select>` 下拉框（每项显示镜像名 + 介绍）
- [ ] 5.2 下拉为空时（白名单未配置），显示禁用状态并提示"暂无可用镜像，请联系管理员"
- [ ] 5.3 下拉选项显示格式：主文本为镜像名（如 `noj-judge-python`），副文本/小字为介绍

## 6. 验证

- [ ] 6.1 手动测试：管理员添加 exact 模式镜像 → 创建题目选择该镜像 → 成功
- [ ] 6.2 手动测试：管理员添加 all_versions 模式镜像 → 创建题目使用附带标签的镜像名 → 匹配成功
- [ ] 6.3 手动测试：白名单非空时尝试使用不在白名单中的镜像 → 后端返回 400
- [ ] 6.4 手动测试：白名单为空时创建题目 → 后端返回 400 "系统尚未配置允许的评测镜像"
- [ ] 6.5 手动测试：管理后台增删改查白名单条目 → 全部正常
- [ ] 6.6 手动测试：all_versions 模式警告文案展示 → 确认后可继续
- [ ] 6.7 运行 `deno task test` 确认现有测试未受影响
- [ ] 6.8 手动测试：seed 脚本执行后 `judge_images` 表包含初始 `noj-judge-python` 记录
