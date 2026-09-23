# Agent Note: 公告/轮播分离（首页展示位解耦）

Status: implemented

## Problem

首页轮播位此前由**公告**驱动（issue #231）：`noj-ui/pages/index.vue` 拉
`/api/v1/announcements?per_page=5` 并把公告渲染成轮播卡。这带来三个问题：

1. **语义混淆**：运营想换首页横幅/轮播图，必须发一条"公告"；公告既是通知又是
   展示位，通知语义被稀释。
2. **无法配置化**：轮播图不能独立管理（排序、启停、图片、跳转），改一版首页要
   发公告，历史公告还会混进轮播。
3. **公告只有单一通道**：只有首页轮播，缺少"常驻不可关闭的公告列表"与
   "可关闭的导航横幅"两种更合适的告知形态。

## Decision

- **新建 `carousel_slides` 表**（迁移 0089）：`kind(image|text)`、`image_storage_url`、
  `title`/`subtitle`/`gradient_key`、`link_url`、`sort_order`、`is_enabled`；
  索引 `(is_enabled, sort_order)`；CHECK `kind IN ('image','text')`。
- **归 `system` 域**（与公告同处），服务 `system/services/carousel.ts`，公开路由
  `GET /api/v1/carousel/slides`，管理路由 `/api/v1/admin/carousel/slides`
  （CRUD + `reorder` + `/images` 上传），权限复用 `announcement:manage`
  （同一运营展示位）。图片上传复用 `StorageProvider` + `validateImageFile`
  （magic bytes / 类型 / 5MB 上限），删除幻灯片时尽力清理其图片。
- **`kind` 语义**：`image` 必须有 `image_storage_url`；`text` 必须有非空 `title`；
  `gradient_key` 白名单校验；`link_url` 为空则整卡不可点。
- **公告双通道**：
  - 首页**常驻公告区块**（`AnnouncementSection.vue`，不可关闭）：全部 active 公告
    （title + excerpt + 「点击查看详情」）。
  - 导航栏下方**可关闭横幅**（`AnnouncementBanner.vue`）：取最新一条带
    `banner_text` 的 active 公告（新端点 `GET /api/v1/announcements/banner`，
    无用户态）。
- **横幅关闭纯前端**：`useAnnouncementDismiss()` 写 localStorage（键
  `noj:announcement-dismissed`），值为**公告 id 集合**——绑 id 而非全局布尔，
  发新公告会再出现。不建表、不建端点、不做 per-user 过滤。
- **首页重构**：抽出 `Carousel.vue`（slides 驱动，无 slide 时默认欢迎占位，
  保留暂停/圆点无障碍语义），在首页插入 `AnnouncementSection`。
- **公告表单**加 `banner_text` 输入（留空 → null，不出横幅）；后端
  `Create/UpdateAnnouncementInput` 与详情/管理列表透传该字段。

## Alternatives considered

- **轮播仍在 `catalog` 域**：计划初稿写 catalog，但轮播与公告同为运营展示位、
  且复用 `announcement:manage` 权限，放 `system` 域避免跨域权限耦合。
- **横幅关闭存后端（per-user）**：需建表 + 端点 + 鉴权，而"关闭横幅"是纯展示
  偏好，无合规/安全价值；localStorage 绑 id 即可，且天然跨设备无关。
- **公告与轮播共表 + 类型区分**：会让"通知"与"展示位"生命周期继续纠缠，与分离
  目标相反。
- **轮播图直接存外链 URL**：绕过 StorageProvider 的类型/尺寸校验与访问控制，
  存在 SSRF/盗链/XSS 风险；统一走上传端点。
- **`text` 型用固定单一渐变**：运营无法区分多张文案卡；保留 `gradient_key` 白名单，
  未知 key 回退默认（前端纯函数兜底，不崩溃）。

## Consequences

- 首页轮播不再受公告增删影响；公告的增删改也不影响轮播。二者通过各自的 SSE
  （`announcement:updated`）分别刷新——轮播目前无 SSE，页面加载时拉取。
- `GET /api/v1/announcements/banner` 必须**注册在 `/:id` 之前**，否则 "banner"
  会被当作公告 id 解析（已在路由中保证）。
- 未配置任何 slide 时首页轮播退化为默认欢迎占位；未配置 `banner_text` 时不出横幅。
- 横幅关闭状态存于用户浏览器；换浏览器/清缓存后会重新出现（符合"关掉后不再
  出现，但发新公告会再出现"的验收口径）。
- 新增审计动作 `carousel.create/update/delete/reorder`；新增写端点均有限流证据。
- 轮播图片上限 5MB（大于头像的 2MB，因展示位分辨率更高）。
- **图片读取**：`noj-storage://` 无法直接作 `<img src>`，故新增公开端点
  `GET /api/v1/carousel/slides/:id/image`（`Content-Type`/`ETag`/缓存），前端据此渲染。
- **审计链路**：carousel 管理路由经组级 `withActorContext` 注入 RequestContext
  （管理员路径跳过了注入上下文的 `adminMiddleware`）；`audit_logs_action_check`
  经迁移 0090 扩容以接受 `carousel.*`。
- `updateSlide` 为**部分更新**：`undefined` = 沿用既有，`null` = 显式清空；
  切换 `kind` 时清理不再适用的字段。
- 删除幻灯片按引用计数清理图片（local 内容寻址下同图共享文件，避免误删他卡）。
