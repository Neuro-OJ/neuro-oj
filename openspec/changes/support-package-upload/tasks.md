## 1. 后端：支持包上传 API

- [x] 1.1 创建 `src/services/support-package.ts`
- [x] 1.2 新增 `POST /api/v1/problems/:id/support-package` 路由
- [x] 1.3 新增 `DELETE /api/v1/problems/:id/support-package` 路由
- [x] 1.4 响应追加 `has_support_package` 布尔字段
- [x] 1.5 `ProblemResponseWithCategories` 增加 `has_support_package`
- [x] 1.6 文件类型校验（zip 扩展名）

## 2. 前端：支持包上传组件

- [x] 2.1 创建 `SupportPackageUpload.vue`
- [x] 2.2 前端 .zip 文件验证
- [x] 2.3 FormData 上传逻辑
- [x] 2.4 SweetAlert2 确认删除

## 3. 前端：题目编辑器集成

- [x] 3.1 ProblemEditor.vue 集成组件
- [x] 3.2 创建模式保存后激活上传
- [x] 3.3 编辑模式加载 `has_support_package`
- [x] 3.4 文件结构折叠引导

## 4. 验证

- [x] 4.1 创建题目 → 上传支持包 → `has_support_package: true` ✅
- [x] 4.2 替换 → 删除 → `has_support_package: false` ✅
- [x] 4.3 上传非 zip 文件 → 400 "仅支持 .zip 格式文件" ✅
- [x] 4.4 非所有者上传 → 403 "无权管理此题目的支持包" ✅
- [x] 4.5 `deno task test` 通过（37 passed, 0 failed）
