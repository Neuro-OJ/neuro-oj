## RENAMED Requirements

- FROM: `### Requirement: 按分类筛选`
- TO: `### Requirement: 按标签筛选`

## MODIFIED Requirements

### Requirement: 题目列表展示

系统 SHALL 在 `/problems` 页面以表格形式展示题目列表，每行包含以下列：

- **题号**（`display_id`）：等宽字体展示，格式为 `{type}{number}`（如 `P1001`、`U42`）
- **类型**（`type`）：标签展示（U=用户题 蓝色标签 / P=专题 紫色标签）
- **标题**（`title`）：可点击的链接，点击跳转至 `/problems/:id`
- **难度**（`difficulty`）：带颜色标识的标签，easy=绿色/简单、medium=黄色/中等、hard=红色/困难
- **标签**（`tags`）：题目标签列表；无标签时显示 `--`
- **通过率**（`acceptance_rate`）：百分比展示
- **通过状态**（已解决/尝试过/未开始）：图标或文字标识

#### Scenario: 成功加载题目列表

- **WHEN** 用户访问 `/problems` 页面
- **THEN** 系统通过 `GET /api/v1/problems` 加载题目列表，并以表格形式渲染

#### Scenario: 题目列表加载中

- **WHEN** 用户访问 `/problems` 页面且题目数据正在加载
- **THEN** 系统显示加载中动画和"加载中..."文字

#### Scenario: 题目列表加载失败

- **WHEN** 题目列表 API 请求失败
- **THEN** 系统显示错误提示和"重试"按钮

#### Scenario: 无可用题目

- **WHEN** 后端返回空题目列表
- **THEN** 系统显示"暂无题目"的空状态提示

### Requirement: 按标签筛选

系统 SHALL 提供标签筛选下拉选择器，标签数据通过 `GET /api/v1/tags` 获取并按 kind 分组展示。筛选值 SHALL 通过 URL 参数 `tag` 反映。

标签列表 SHALL 仅在页面加载时获取一次并在客户端缓存。

#### Scenario: 加载标签选项

- **WHEN** 用户访问 `/problems` 页面
- **THEN** 系统调用 `GET /api/v1/tags` 获取标签并按 kind 分组渲染为标签筛选下拉框

#### Scenario: 按标签筛选

- **WHEN** 用户选择某个标签（如"数据结构"）
- **THEN** 系统发起 `GET /api/v1/problems?tag=<id>` 请求

#### Scenario: 标签加载失败

- **WHEN** 标签 API 请求失败
- **THEN** 系统隐藏标签筛选控件，不阻塞题目列表展示

### Requirement: 响应式布局

系统 SHALL 适配移动端和桌面端布局：

- **桌面端**（≥768px）：完整表格展示，含所有列
- **移动端**（<768px）：隐藏非关键列（时间限制、内存限制、标签），保留题号、标题、难度、通过率、通过状态

#### Scenario: 移动端表格适配

- **WHEN** 在屏幕宽度 <768px 的设备上访问 `/problems`
- **THEN** 表格仅显示核心列，通过折行或截断保持可读性
