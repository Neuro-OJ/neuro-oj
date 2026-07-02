## Context

当前支持包（support package）的生命周期完全在 Web 界面之外：管理员通过本地 CLI 工具 `deno task build-packages` 从 `data/problems-src/<id>/` 构建 zip，再手动放置到 `data/packages/` 目录。题目创建 API 接受 `support_package_path` 字符串字段，但前端从未发送此字段。系统缺少通过 Web 界面上传和管理支持包的能力。

**现有约束：**
- Redis MQ 消息最大 16MB，支持包经 Base64 编码后约膨胀 33%，实际 zip 上限约 12MB
- noj-judge 解压 zip 时有安全防护：1000 条目上限、64MB/文件、512MB 总量、路径穿越检测
- `support_package_path` 列已存在于 `problems` 表，无需 schema 迁移
- Hono 框架原生支持 `c.req.parseBody()` 处理 multipart/form-data
- 项目无现有文件上传组件或 API 模式

## Goals / Non-Goals

**Goals:**
- 提供 RESTful API 上传支持包 zip 文件（multipart/form-data）
- 提供 API 删除已上传的支持包
- 在题目编辑器中集成文件上传 UI（含拖拽、状态显示）
- 提供清晰的 zip 文件结构引导文档
- 上传时验证文件类型（仅 .zip）
- 存储上传文件至 `data/packages/<problem_id>.zip`

**Non-Goals:**
- 不在创建/更新题目 API 中直接接受文件上传（保持 JSON contract 不变，使用独立端点）
- 不解压或深度验证 zip 内部结构（由 noj-judge 评测时完成）
- 不修改 noj-judge 的任何逻辑
- 不提供支持包版本管理或多文件上传
- 不支持非 zip 格式的上传

## Decisions

### 1. 独立上传端点 vs 集成到创建/更新 API

**选择：独立端点** `POST /api/v1/problems/:id/support-package`

**理由：**
- 创建题目和上传支持包是两个独立的操作——用户可能先创建题目草稿、后上传支持包
- 保持现有 `POST/PUT /api/v1/problems` 的 JSON contract 不变，避免破坏性变更
- 允许在不修改其他字段的情况下替换支持包
- 符合 RESTful 子资源惯例（support-package 是 problem 的子资源）

**替代方案被拒：**
- 集成到创建 API 中作为 multipart：会使 API 设计复杂化（混合文件和其他字段），且不支持后续替换
- Base64 内嵌 JSON：大文件 Base64 编码后体积膨胀，浪费带宽和内存

### 2. Zip 文件结构：无顶级文件夹

**选择：zip 内文件直接存放在根层级，不包含顶级文件夹**

**理由：**
- 与现有 `build-packages.ts` 行为一致——它 `cd` 到源目录后 `zip -r`，文件在 zip 根层级
- 与 noj-judge `extract_zip()` 行为一致——它直接将 zip 内容解压到工作目录
- 简化用户操作：无需关心顶级文件夹命名

**要求文档将明确说明：**
```
支持包 zip 结构：
├── evaluate.py        # 必需：评测脚本
├── visible.jsonl      # 可选：公开测试用例
├── hidden.jsonl       # 可选：隐藏测试用例
└── ...                # 其他 evaluate.py 需要的文件

注意：
- evaluate.py 必须存在于 zip 根目录
- 不包含顶级文件夹——以上文件直接位于 zip 根层级
- submission.py 会被评测系统自动注入，无需放入
```

### 3. 存储路径

**选择：** `data/packages/<problem_id>.zip`（与现有 build-packages 产物路径一致）

**理由：**
- 与种子数据和 build-packages 使用同一目录
- `data/packages/` 已被 `.gitignore` 忽略
- 路径格式简单，`<problem_id>` 是稳定的 UUID

### 4. UI 组件设计

**选择：新建独立的 `SupportPackageUpload.vue` 组件，嵌入 `ProblemEditor.vue`**

**理由：**
- 复用性：文件上传是通用能力，独立组件便于未来其他场景复用
- 关注点分离：ProblemEditor.vue 已较长（~350 行），新增上传逻辑应独立
- 拖拽上传、进度显示、错误处理等上传相关状态由组件内部管理

**插入位置：** ProblemEditor.vue 中评测配置区域（judge_image、judge_command 字段之后），作为"题目支持包"卡片区域。

### 5. 后端 multipart 处理

**选择：使用 Hono 内置 `c.req.parseBody()` 解析 multipart/form-data**

**理由：**
- Hono 原生支持，无需引入额外依赖
- 与现有 Hono 框架一致
- `parseBody()` 返回解析后的表单数据（含文件流），可直接写入磁盘

### 6. 安全措施

| 措施 | 理由 |
|------|------|
| 文件类型验证（magic bytes + 扩展名 `.zip`） | 防止上传非 zip 文件 |
| 仅允许题目所有者/管理员上传 | 与题目编辑权限一致 |
| 删除支持包同时清空数据库字段 | 防止残引用指向已删除文件 |

## Risks / Trade-offs

- **[风险] 并发上传同一题目的支持包** → 缓解：文件写入使用原子操作（先写临时文件再 rename），最后写入者胜出
- **[风险] 磁盘空间耗尽** → 缓解：暂无自动清理机制，需运维监控。未来可添加磁盘使用量告警
- **[取舍] 不验证 zip 内部结构** → 有意识的设计选择。zip 结构错误将在首次评测时暴露（no-judge 容器日志可见）。深层验证复杂度高且收益有限

## Open Questions

- 无——所有关键决策已在上述分析中解决
