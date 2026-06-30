## 1. 后端：支持包上传 API

- [x] 1.1 创建 `src/services/support-package.ts`：实现 `saveSupportPackage(problemId, file)` 和 `deleteSupportPackage(problemId)` 函数，处理文件流写入 `data/packages/<problem_id>.zip`、文件删除、数据库 `support_package_path` 更新
- [x] 1.2 修改 `src/routes/problems.ts`：新增 `POST /api/v1/problems/:id/support-package` 路由，使用 `c.req.parseBody()` 解析 multipart，验证文件类型（仅 .zip），调用 saveSupportPackage
- [x] 1.3 修改 `src/routes/problems.ts`：新增 `DELETE /api/v1/problems/:id/support-package` 路由，验证权限，调用 deleteSupportPackage
- [x] 1.4 修改 `src/services/problems.ts` 的 `toProblemResponse` 返回：在响应中追加 `has_support_package` 布尔字段（基于 `support_package_path` 是否为 null）
- [x] 1.5 修改 `src/types/problems.ts`：在 `ProblemResponseWithCategories` 类型中增加 `has_support_package: boolean`
- [x] 1.6 文件类型校验逻辑已实现（路由层和 service 层双重验证）

## 2. 前端：支持包上传组件

- [x] 2.1 创建 `components/SupportPackageUpload.vue`：文件拖拽区域 + 文件选择按钮，显示已上传文件名和状态，支持上传、替换、删除操作
- [x] 2.2 实现前端文件验证：仅接受 `.zip` 扩展名
- [x] 2.3 实现上传逻辑：使用 `FormData` + `$fetch` 调用 `POST /api/v1/problems/:id/support-package`
- [x] 2.4 实现删除逻辑：调用 `DELETE /api/v1/problems/:id/support-package`，含 SweetAlert2 确认弹窗

## 3. 前端：题目编辑器集成

- [x] 3.1 修改 `components/ProblemEditor.vue`：在评测配置区域（judge_image/judge_command 之后）集成 SupportPackageUpload 组件
- [x] 3.2 创建模式下，首次保存成功后激活上传区域（`savedProblemId` 在创建成功后赋值）
- [x] 3.3 编辑模式下，加载 `support_package_path` 和 `has_support_package` 供组件初始化
- [x] 3.4 添加"支持包文件结构"引导说明（折叠面板），展示 zip 内应有的文件结构

## 4. 验证

- [ ] 4.1 手动测试：创建题目 → 上传支持包 → 查看题目详情确认 `has_support_package: true`
- [ ] 4.2 手动测试：编辑题目 → 替换支持包 → 删除支持包
- [ ] 4.3 手动测试：上传非 zip 文件 → 确认返回 400
- [ ] 4.4 手动测试：非所有者上传 → 确认返回 403
- [x] 4.5 运行 `deno task test` 确认现有测试未受影响（37 passed, 0 failed）
