## Purpose

定义 Neuro OJ 题目列表页功能规范，包括题目浏览、搜索、筛选、分页及通过状态展示。用户可在页面中浏览所有题目，按条件快速筛选目标题目。

## Requirements

### Requirement: 题目列表展示

系统 SHALL 在 `/problems` 页面以表格形式展示题目列表，每行包含以下列：

- **题号**（`id`）：等宽字体展示
- **标题**（`title`）：可点击的链接，点击跳转至 `/problems/:id`
- **难度**（`difficulty`）：带颜色标识的标签，easy=绿色/简单、medium=黄色/中等、hard=红色/困难
- **分类**（`categories`）：分类标签列表；无分类时显示 `--`
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

### Requirement: 按标题/题号搜索

系统 SHALL 在页面顶部提供搜索输入框，支持按标题或题号关键词搜索题目。

搜索输入框 SHALL 具有防抖（debounce）机制，用户停止输入 300ms 后自动发起搜索。

搜索关键词 SHALL 通过 URL 参数 `keyword` 反映，支持 URL 分享。

#### Scenario: 搜索关键词

- **WHEN** 用户在搜索框输入"归一化"
- **THEN** 系统发起 `GET /api/v1/problems?keyword=归一化` 请求，表格展示匹配结果

#### Scenario: 按题号模糊搜索

- **WHEN** 用户在搜索框输入"100"
- **THEN** 系统发起请求，返回题号模糊匹配 "100" 的题目（如 1001、1002）

#### Scenario: 搜索后切换页面

- **WHEN** 用户在搜索关键词"树"的结果中翻页到第 2 页
- **THEN** URL 参数为 `?keyword=树&page=2`

#### Scenario: 清空搜索

- **WHEN** 用户清空搜索框内容
- **THEN** 系统移除 `keyword` 参数，返回全部题目

### Requirement: 按难度筛选

系统 SHALL 提供难度筛选控件，支持 easy、medium、hard 三个选项。筛选值 SHALL 通过 URL 参数 `difficulty` 反映。

#### Scenario: 按难度筛选

- **WHEN** 用户选择难度 "easy"
- **THEN** 系统发起 `GET /api/v1/problems?difficulty=easy` 请求

#### Scenario: 取消难度筛选

- **WHEN** 用户再次点击已选中的难度
- **THEN** 系统移除 `difficulty` 参数，清除筛选

### Requirement: 按分类筛选

系统 SHALL 提供分类筛选下拉选择器，分类数据通过 `GET /api/v1/categories` 获取。筛选值 SHALL 通过 URL 参数 `category_id` 反映。

分类列表 SHALL 仅在页面加载时获取一次并在客户端缓存。

#### Scenario: 加载分类选项

- **WHEN** 用户访问 `/problems` 页面
- **THEN** 系统调用 `GET /api/v1/categories` 获取分类树并渲染为分类筛选下拉框

#### Scenario: 按分类筛选

- **WHEN** 用户选择某个分类（如"数据结构"）
- **THEN** 系统发起 `GET /api/v1/problems?category_id=<id>` 请求

#### Scenario: 分类加载失败

- **WHEN** 分类 API 请求失败
- **THEN** 系统隐藏分类筛选控件，不阻塞题目列表展示

### Requirement: 分页导航

系统 SHALL 提供完整分页导航组件，包含页码数字按钮、上一页/下一页按钮。当前页高亮显示。

分页状态 SHALL 通过 URL 参数 `page` 和 `limit` 反映。

#### Scenario: 点击页码跳转

- **WHEN** 用户点击分页组件中的页码 "3"
- **THEN** URL 更新为 `?page=3`，系统发起 `GET /api/v1/problems?page=3` 请求

#### Scenario: 第一页时上一页禁用

- **WHEN** 当前为第 1 页
- **THEN** "上一页"按钮处于 disabled 状态

#### Scenario: 最后一页时下一页禁用

- **WHEN** 当前为最后一页
- **THEN** "下一页"按钮处于 disabled 状态

#### Scenario: 筛选后分页重置

- **WHEN** 用户在非第 1 页时切换筛选条件
- **THEN** 页码自动重置为第 1 页

### Requirement: 显示用户通过状态

系统 SHALL 为每道题目显示当前登录用户的通过状态。未登录用户不显示通过状态。

通过状态分为三级：

- **已解决**：用户有至少一条该题目的 score >= 100 的提交记录（绿色对勾标识）
- **尝试过**：用户有提交记录但未获得满分（黄色标识）
- **未开始**：用户无该题目的提交记录（无标识）

当用户登录时，SHALL 在页面加载后异步获取用户的已解决题目列表，用于标记状态。

#### Scenario: 已登录用户显示通过状态

- **WHEN** 已登录用户访问 `/problems` 页面
- **THEN** 每道题显示对应的通过状态（已解决/尝试过/未开始）

#### Scenario: 未登录用户不显示状态

- **WHEN** 未登录用户访问 `/problems` 页面
- **THEN** 题目列表不显示通过状态列

### Requirement: 响应式布局

系统 SHALL 适配移动端和桌面端布局：

- **桌面端**（≥768px）：完整表格展示，含所有列
- **移动端**（<768px）：隐藏非关键列（时间限制、内存限制、分类），保留题号、标题、难度、通过率、通过状态

#### Scenario: 移动端表格适配

- **WHEN** 在屏幕宽度 <768px 的设备上访问 `/problems`
- **THEN** 表格仅显示核心列，通过折行或截断保持可读性
