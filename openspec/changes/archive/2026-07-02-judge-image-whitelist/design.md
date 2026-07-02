## Context

当前 `judge_image` 在题目创建/更新时为零校验自由文本字段。任何认证用户可在创建 U 型题目时指定任意 Docker 镜像名（如 `evil-image:latest`）。虽然 noj-judge 的 `ensure_image_local()` 会在评测时拒绝不存在于本地的镜像，但在 API 层缺乏早期拦截：

- 若运维团队在 judge 节点上提前拉取了恶意镜像（无论有意还是疏忽），API 层应提供前端校验
- 镜像名可包含任意字符，缺乏格式约束
- 管理员无集中界面管理"哪些镜像可视作安全"的列表

### 现有约束

- noj-judge 不从 registry 拉取镜像，仅使用本地已构建的镜像
- `PoolConfig.images` 环境变量定义预热的镜像集合
- `problems` 表已有 `judge_image TEXT NOT NULL` 列，无需迁移
- 管理后台所有页面使用 `AdminTable.vue` + `AdminModal.vue` 组件模式
- 管理路由挂载在 `/api/v1/admin`，经 `authMiddleware` + `adminMiddleware` 双重保护
- 项目使用 Drizzle ORM + PostgreSQL，迁移通过 `drizzle/meta/` 管理

## Goals / Non-Goals

**Goals:**
- 新增 `judge_images` 表，管理员可通过 API 增删改查白名单条目
- 两种匹配模式：`exact`（精确版本匹配）和 `all_versions`（镜像全版本匹配）
- 管理后台提供 UI 界面管理白名单
- 题目创建/编辑时提供镜像下拉列表（含管理员配置的介绍文案）
- 白名单非空时，题目创建/更新接口强制校验 `judge_image` 是否在白名单中
- `all_versions` 模式添加前警告管理员安全风险（但不阻止）
- 白名单为空时行为不变（向后兼容）

**Non-Goals:**
- 不与 Docker Registry 交互（不拉取镜像列表或元数据）
- 不修改 noj-judge 的镜像检查逻辑
- 不校验 noj-judge 节点上镜像是否实际存在
- 不移除自由文本输入作为 fallback（白名单为空时仍可用）
- 不处理已有题目的镜像迁移

## Decisions

### 1. 数据库表设计

```sql
CREATE TABLE judge_images (
  id TEXT PRIMARY KEY,           -- UUID
  image TEXT NOT NULL,           -- Docker 镜像名，如 "noj-judge-python" 或 "noj-judge-python:v1.0"
  mode TEXT NOT NULL DEFAULT 'exact',  -- "exact" | "all_versions"
  description TEXT NOT NULL DEFAULT '', -- 管理员配置的介绍，在题目编辑器下拉中展示
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT judge_images_mode_check CHECK (mode IN ('exact', 'all_versions'))
);
```

`image` 列不强制唯一——允许同一镜像配置多条规则（如一个 exact 条目 + 一个 all_versions 条目用于不同上下文），但 UI 层面提示重复。

### 2. 匹配逻辑

**`exact` 模式**：提交的 `judge_image` 必须与数据库中某条 `mode='exact'` 的记录的 `image` 字段完全相等（区分大小写）。

**`all_versions` 模式**：提交的 `judge_image` 去掉标签部分（`:` 之前的部分）后，必须与数据库中某条 `mode='all_versions'` 的记录的 `image` 字段完全相等。

示例：
- 白名单含 `all_versions: "noj-judge-python"` → 匹配 `noj-judge-python`、`noj-judge-python:latest`、`noj-judge-python:v1.0`、`noj-judge-python:dev`
- 白名单含 `exact: "noj-judge-cpp:gcc13"` → 仅匹配 `noj-judge-cpp:gcc13`

### 3. 公开列表 API

新增 `GET /api/v1/judge-images`（无需认证），返回所有白名单条目。响应格式：

```json
{
  "data": [
    {
      "id": "uuid",
      "image": "noj-judge-python",
      "mode": "all_versions",
      "description": "Python 3.12 评测环境，支持标准库和常用科学计算包"
    }
  ]
}
```

### 4. 白名单校验策略

**选择：始终强制校验。白名单为空时拒绝所有镜像。**

**理由：**
- 安全优先：白名单为空意味着管理员尚未审查任何镜像，不应允许使用任何镜像
- 启动即安全：系统首次部署后，管理员必须显式配置至少一条白名单，题目创建才可用
- 错误消息区分两种情况：
  - 白名单为空：`"系统尚未配置允许的评测镜像，请联系管理员"`
  - 镜像不在白名单中：`"评测镜像 'xxx' 不在允许列表中"`

**种子数据：** `seed.ts` 中预置一条 `all_versions: "noj-judge-python"` 记录，确保开箱可用（与现有样例题目的 judge_image 值一致）。

### 5. 题目编辑器 UI 变更

**选择：将 `judge_image` 从 `<input type="text">` 改为 `<select>` 下拉框，完全替换自由文本输入。**

**理由：**
- 白名单为空时不允许任何镜像，因此不存在"需要自由输入"的回退场景
- `<select>` 提供结构化的选择体验，明确展示管理员配置的镜像列表
- 每项下拉框展示 `image` 和 `description`，管理员可撰写说明引导用户选择正确镜像

**实现方案**：下拉选项来自 `GET /api/v1/judge-images`，每项显示镜像名 + 介绍。白名单为空时下拉为空，提交时后端校验拒绝。种子数据确保初始至少有一条记录。

### 6. 管理界面

**选择：新增 `/admin/judge-images` 页面，复用 AdminTable + AdminModal 模式。**

页面结构：
- 表格列：镜像名、模式（exact/全版本）、介绍（截断）、创建时间
- 新增按钮 → AdminModal 表单（镜像名输入 + 模式选择 + 介绍文本域）
- 编辑按钮 → AdminModal 表单（预填当前值）
- 删除按钮 → AdminModal 确认弹窗（danger 模式）
- `all_versions` 添加警告：当管理员选择 `all_versions` 模式时，弹窗显示一段醒目警告文案，说明该操作允许该镜像的所有版本标签，攻击者可能利用此宽松规则使用非预期镜像版本。管理员确认后继续进行。

### 7. 管理路由组织

**选择：在 `src/routes/admin.ts` 中新增路由，挂在现有 `/api/v1/admin` 组下（自动继承 authMiddleware + adminMiddleware）。**

不创建单独的路由文件。理由：
- 与现有 admin 路由组织结构一致
- judge-images 的 CRUD 量很小（4 个端点），不必要拆分

## Risks / Trade-offs

- **[风险] 白名单为空时所有题目创建被阻止** → 缓解：种子数据预置 `noj-judge-python` 记录，确保初次部署即可用。管理后台页面顶部提示管理员配置白名单
- **[取舍] 不验证镜像在 judge 节点上是否存在** → 有意识的设计选择。镜像存在性由 noj-judge 在评测时验证，分离关注点避免 core ↔ judge 耦合
- **[风险] 镜像名大小写敏感匹配** → Docker 镜像名本身区分大小写，保持一致；UI 下拉框约束输入，减少手动输入偏差
- **[取舍] 不自动同步 noj-judge POOL_IMAGES** → 无自动化链路。管理员需手动保持白名单与 judge 配置一致。未来可添加自动化同步
