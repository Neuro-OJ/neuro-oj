# Changelog

本文件记录 Neuro OJ 的**用户可见变更**，重点是**破坏性变更**（命令、配置、文件
形态、安装方式）。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [Unreleased]

### 赛时社区静默补齐（N-01 残余）

- 公开赛未结束期间（含筹备期），普通用户除不能发布讨论与动态外，**也不能发布题解、
  发表/回复评论、编辑已有帖子与评论**；此前可经评论、编辑旧帖或给非赛题发题解向全场广播赛题解法。
- `GET /api/v1/community/config` 新增 `contest_silence` 字段，题解资格接口新增
  `blocked_reason: "contest_silence"`；前端据此预先禁用发布、评论与编辑入口，删除入口保留。

### LLM 网关安全加固（审计 G-03 / G-04）

- **破坏性**：Provider 的 Base URL 默认只允许 **https 公网地址**；指向 `localhost`、Docker 服务名、
  私网 / 回环 / 云元数据 IP 的 Provider（含已登记的存量 Provider）将被拒绝，调用返回
  `provider_base_url_blocked`。内网自建模型需在网关环境变量 `NOJ_LLM_UPSTREAM_ALLOWED_HOSTS`
  中显式放行（逗号分隔）。
- 调用前就被限流 / 额度拒绝的请求不再保存 prompt 原文，且同一提交同一原因 60 秒内只记录一条。
- 新增 `NOJ_LLM_USAGE_RETENTION_DAYS`（默认 `90`，`0` 关闭），网关定期清理过期的 `llm_usage` 记录。

### CI 供应链（审计 S1）

- 全部 GitHub Actions 引用固定到 commit SHA（附版本注释），新增 `check-action-pins` 门禁防止回退。

---

## [0.10.3-alpha.1] - 2026-09-30

### 全站视觉系统升级与微质感对齐（PR #593）

- **Clean Cyber Azure 浅蓝科技调视觉系统**：
  - 主站（`noj-ui`）全面对齐 `noj-docs` 的品牌浅蓝科技调，天青蓝主色 `#0284c7`（亮色 Sky 600）/ `#38bdf8`（暗色 Sky 400），底色采用清爽天青 `#f5f8fc`，面板统一纯白；
  - 评测信号绿对齐规范采用 Emerald `#059669`（暗色 `#00e07a`）；
  - 全局前台题单、竞赛、排行榜等页面的深色粗重 Head Card 升级为统一清爽的浅色微质感面板；
  - 引入近直角工业形态（2-6px 圆角）与等宽数字 `tabular-nums` 排版。

### 评测机可用性与开赛前安全整改（PR #594）

- **评测机可用性 5 项二次审计缺陷修复**：
  - 修复批量测试用例注入路径堆内存双份驻留（NOJ-A1，内存峰值降幅 50%）；
  - 批量注入写路径补充全面本地超时保护（NOJ-A2），消除单槽位永久卡死；
  - 修复 Redis 任务重投方向（NOJ-A7），避免退避失效与高频连接空转；
  - 评测机启动期按 member 前缀精准回收孤儿 Claim（NOJ-D2）；
  - 容器优雅停机追加 `stop_grace_period` 配置（NOJ-D3），保证退出阶段评测 drain 充分完成。
- **开赛前安全加固与信道防护**：
  - 用户封禁即刻吊销 JWT 凭据；题目转 P 号排他锁与数值类型加固；
  - LLM 网关响应截断、单次 Token 原子吊销；
  - Nitro 服务端代理路径穿越防御与未授权绕过拦截；
  - 赛时社区全局静默、全站榜单隔离与保密信道防泄露。

### 管理后台全链路体验重构（Phase 1 至 Phase 4）

- **全局导航与顶栏工作台**：
  - 侧边栏重组为 6 大清晰业务域（概览监控、题务教务、评测与算力、社区与风控、用户与安全、系统运维）；
  - 新增 `AdminTopbar` 全局顶栏，提供动态面包屑、管理员身份、环境指示芯片与 `Ctrl+K` 全局直达命令面板（`AdminCommandPalette`）；
- **行动导向运维中枢**：
  - 仪表盘升级为行动导向中心，集成待办提醒、核心指标网格、评测队列健康态势与实时审计流；
- **表格效率增强与右侧抽屉化交互**：
  - `AdminTable` 支持全选/行选择、批量操作与 URL Query 双向记忆；
  - 竞赛、角色、用户封禁、举报治理、内容审查、题务预检全面从生硬居中弹窗升级为平滑右侧抽屉（`USlideover`）；
  - 竞赛题目关联支持原生抓手拖拽与箭头重排序，自动同步题号与分值限次内嵌标签。

---

## [0.10.2-alpha.1] - 2026-09-28

### 安全与防作弊（PR #592 审计整改）

- **竞赛防作弊与题目保密**：
  - 答疑提问默认私密，仅主办方"公开回复"才把提问与答复广播；
  - 题解/讨论读写双门控：服务层写入门控 + 列表/详情/收藏/Tab 计数/搜索读门控，覆盖 discussion 与赛前筹备期；
  - 客观题竞赛模式赛期只回执"已提交"，详情/历史屏蔽分数与逐题对错；
  - 题库/题单/个人主页/全局搜索在 SQL 层整行隐藏正在进行未结束公开赛的题目；
  - 封榜视图对非管理员只返回本人一行；
  - 竞赛 SSE 对非管理员剔除 `submission_id`；提交 SSE 订阅加归属校验；
  - 提交队列状态：匿名与非所有者一律拒绝。
- **沙箱隔离与网络安全**：
  - 新增 `noj-eval-net` 评测隔离网络；judge 默认改为该网络并拒绝 bridge/host；
  - 管道写入 3s 超时与 Written/PeerGone 三态，消除编排死锁；
  - 支持包批量注入（单 tar 流 + 单次 exec）；
  - 支持包下载/校验失败直接终止任务，不再静默放行；
  - tmpfs 追加 `noexec,nosuid,nodev`。
- **功能下线（精简与瘦身）**：
  - 迁移 0095：下线社区自动动态（全栈移除表与端点，消除封榜击穿侧信道）；
  - 下线 IP 反作弊与 client_ip 收集，保留代码查重与 IP 封禁。

### 文档站重构与视觉升级

- **知识域路径自闭环与多侧边栏重构**：
  - 划分 5 大核心知识域（做题指南、出题指南、运维部署、评测机制与架构、参考手册），侧边栏各条目严格在所属知识域内闭环，消除跨分类跳转迷航；
  - 物理清理所有历史跳转空桩文件；
  - 新增《做题快速开始》、《客观题套卷出题与导入指南》、《对象存储配置与运维指南》。
- **清爽浅蓝科技调（Clean Cyber Azure）视觉重设计**：
  - 文档站改用清透浅天青底色（`#f5f8fc` / 面板 `#ffffff` / 深海海军蓝黑 `#0b0f19`），与做题竞技主站暖纸底解耦；
  - 引入天青微网格背景（Azure Blueprint Grid）、H2 底部渐变高光指示条、TOC 动态微圆点与首页呼吸脉冲状态徽标；
  - 现代轻质半透明 Callout 容器与深海蓝黑终端代码窗口；
  - 全局 2–6px 近直角工业质感与 `tabular-nums` 排版。

---

## [0.10.1-beta.3] - 2026-09-27

### 新增

- **页脚展示构建身份**：品牌列新增两行技术信息——`前端`（noj-ui
  构建身份，编译进产物） 与 `后端`（noj-core 运行身份，来自镜像
  ENV），各含版本号、commit、构建时间。时间按访问者 本地时区显示，悬停可看完整
  SHA 与原始 ISO 时间。运维文档新增「确认线上正在运行哪个构建」 一节（页脚 /
  `/healthz` / `/api/v1/site/meta` / 镜像 OCI label 四个口径）。 构建身份由
  Release 流水线以 build-arg 注入 `NOJ_BUILD_VERSION` / `NOJ_BUILD_COMMIT` /
  `NOJ_BUILD_TIME`，**无需**修改 `.env.prod`；本地源码运行回退为模块清单版本 +
  本地 git 短 SHA（未提交改动缀 `-dirty`）+ 进程启动时刻。

### 修复

- **编辑器初始代码模板对所有线上题目恒 404**：模板此前只在请求时按
  `manifest.number + title` 去服务器本地 `data/problems-src/`
  查找，而容器化生产既没有 私有题源、题包 manifest 又普遍不写
  `number`（题号由导入时自增分配），因此编辑器打开时
  代码框恒为空白且无任何提示。现在模板随题包上传、导入时落库（`problems.template_content`），
  运行期解析顺序为「落库内容 → 已存储支持包内的 `template.py` →
  本地源码目录」；存量题目 无需重新导入即可恢复。
- **管理后台多个列表整列空白**：通用表格 `AdminTable` 只要调用方提供了 `#cell`
  插槽就直接 返回其产出，而各页面的插槽只覆盖部分列（`v-if` 链没有
  `v-else`），未覆盖列渲染成注释
  占位节点，表现为整列空白——题目管理页的「题号」「标题」、标签管理页的「名称」「关联题目数」
  等 6
  个界面受影响。现在判定"插槽是否真的渲染出内容"，未覆盖列回退显示原始字段值。
- **健康探针与 CLI 报告过期版本号**：`/health*` 三处与 `scripts/noj.ts` 的
  `.version()` 硬编码 `0.9.5`（当时实际版本已是
  `0.10.1-beta.2`）。现统一读构建身份单一真相源，并有 测试断言其与真相源一致。

### 变更

- **题目包打包不再排除模板文件**：`noj-cli problem pack` 与 `problems:build`
  现在把 `template.py`（或 `manifest.template`
  指定的文件）打进包——平台据此填充编辑器初始代码。
  参考实现（`submission*`）仍必须排除。出题人若按旧规范手工删掉模板，导入日志会出现
  `manifest.template 声明的模板文件不在包内` 提示。

---

## [0.10.1-beta.2] - 2026-09-27

### 修复

- **`noj-cli install` / `update` 对 0.10.1-alpha.2 以来的所有 Release
  必然失败**：GitHub 会把 **以 `.` 开头的 Release 资产名**改写成
  `default.<name>`（服务端行为——即使用 uploads API 显式传 `name` 也一样），而
  CLI 下载的是 `.env.prod.example` 原名，于是资产 URL 恒 404。 `install` 第 1 步
  bootstrap 与 `update` 第 4 步部署文件同步都会以
  `提交部署文件失败，已回滚：下载 .env.prod.example 失败：HTTP 404`
  终止（两者都没有跳过 开关），`update --latest`
  的"资产就绪"过滤按原名比对也永远不命中。
  - 修复方式：Release 侧模板资产改用非点号名 `env.prod.example`（`release.yml`
    先 `cp` 再 `sha256sum` 发布，并内置"资产名不得以点号开头 /
    文件必须存在"的自检）；CLI 侧把 `RELEASE_FILES` 拆成
    `{ asset, target }`——资产名用于拼下载 URL 与校验文件名， `target`
    仍是安装目录里的文件名 `.env.prod.example`。用户可见行为不变：模板依然落盘为
    `.env.prod.example`，`.env.prod` 不受影响。
  - **已发布的 `0.10.1-alpha.2` / `0.10.1-alpha.3` / `0.10.1-beta.1` 无法用 CLI
    安装或升级** （也就取不到 `docker-compose.prod.yml` 的 MinIO
    修复）；受影响的实例请手工同步 compose 文件后
    `docker compose up -d`，或直接升级到本版本及以后。

### 变更

- 版本号同步为 `0.10.1-beta.2`（noj-cli / noj-core / noj-llm-gateway / noj-ui /
  noj-lmcc-extension / noj-judge + CLI `VERSION` 常量与断言；`Cargo.lock` 由
  `cargo metadata` 重新生成，仅版本行）。
- 本版在 `0.10.1-beta.1` 基础上只多出上面的 install / update 修复：**beta.1 的
  公开赛题目保密与 MinIO 镜像源迁移同样包含在本版**。

---

## [0.10.1-beta.1] - 2026-09-27

### 变更（需要运维注意）

- **MinIO 镜像来源迁移（官方已停止免费分发）**：Docker Hub
  `minio/minio`、`minio/mc` 整组织 404（仓库已删除），`quay.io/minio/*` 无
  manifest，`dl.min.io` 二进制返回 **410 Gone** —— 原先钉的
  `minio/minio:RELEASE.2024-11-07` 与 `minio/mc:RELEASE.2025-08-13`
  均无法拉取，**新装 / 换机部署会失败**
  （运行中的实例因本地有镜像缓存暂未暴露）。
  - `docker-compose.prod.yml`（以及 dev / E2E compose）改用 Bitnami
    冻结镜像源，**MinIO 版本不变** （RELEASE.2024-11-07），prod 按多架构 digest
    钉死；`noj-cli` 的 mc 客户端常量同步更换。
  - prod 的 `minio` 改为以 root 启动入口脚本：入口会 `chown -R`
    数据卷属主后把服务**降权为 `minio` 用户**运行，
    因此**存量实例升级无需手工步骤**；数据卷挂载点改为
    `/bitnami/minio/data`（卷内容不变，对象不受影响）。
  - `minio-init` 的策略模板替换由 bash 专有展开改为 POSIX `sed`（新镜像的
    `/bin/sh` 是 dash， 否则会以 `Bad substitution` 失败、bucket
    与策略不会被创建）。
  - `docker-compose.prod.yml` 属发布资产：**该变更需随新版本发布**才对
    `noj-cli install/update` 生效。
  - 长期建议：评估迁移到受支持的托管 S3（`S3_ENDPOINT` 可指向阿里云 OSS / R2
    等），以摆脱冻结镜像源。

### 新增

- **公开赛关联题目保密**：题目被加入**公开赛**（`contests.kind='public'`，邀请赛除外）
  后，在竞赛结束时间之前，除**题目所有者**与**管理员**外，所有人访问该题目的题库页面与
  独立接口都按"不存在"处理（读取 404、独立提交/自测 403）；竞赛 `end_time`
  一过自动恢复
  可见（赛后复盘、补题、题解继续可用）。所有者/管理员打开该题时会看到
  "当前题目已经被关联到竞赛 XXX，仅管理员和题目所有者可见，请注意保密工作"横幅
  （`GET /problems/:id` 新增 `contest_secrecy` 字段，只对这两类查看者下发）。
  题库与搜索列表仍保留条目（点入即 404）。

### 变更（破坏性）

- **竞赛关联题目的独立入口在赛前/赛中对所有人关闭（含参赛者）**：参赛者必须通过竞赛
  入口（`/contests/:id/problems/:label`、`/contests/:id/submit`）做题与提交；把题目
  收藏成 `/problems/<编号>` 直链在赛前/赛中会 404。携带**有效竞赛上下文**的接口
  （客观题套卷 `GET /problems/:id/questions?contest_id=`、starter code
  `GET /problems/:id/template?contest_id=`）不受影响。
- `noj-lmcc-extension`
  只调用题库入口，因此被公开赛关联的题目在插件里"能搜到但无法 提交"；LMCC
  若以公开赛承载考试，需改用邀请赛或先扩展插件携带竞赛上下文。
- `GET /problems/:id/template` 补齐访问校验（此前**完全没有校验**，私有题的
  starter code 对任意登录用户可读）：现与题目详情同口径，无权限一律 404。

### 变更

- 版本号同步为 `0.10.1-beta.1`（noj-cli / noj-core / noj-llm-gateway / noj-ui /
  noj-lmcc-extension / noj-judge + CLI `VERSION` 常量与断言；`Cargo.lock` 由
  `cargo metadata` 重新生成，仅版本行）。

---

## [0.10.1-alpha.3] - 2026-09-26

### 修复

- **生产镜像里邮件 Provider
  从未被编译进二进制，所有发信链路不可用**（`0.10.1-alpha.2`
  部署实例实测）：`deno compile` 只对**字面量**动态导入做静态分析，而 `email.ts`
  的装配点 先用 `PROVIDER_MODULES[provider]` 取出模块路径字符串、再
  `await import(modulePath)`， 于是 aliyun / tencent / disabled / mock 四个
  Provider 全部不在产物内。本地开发与单元 测试跑的是源码、CI
  也不执行该分支，缺陷只在生产容器里以
  `Module not found: file:///tmp/deno-compile-noj-server/src/domains/system/services/email-providers/aliyun.ts`
  暴露（管理后台测试邮件 503、注册邮箱验证与找回密码 500）。改为字面量加载器
  `PROVIDER_LOADERS`（`() => import("./email-providers/x.ts")`），保留惰性加载与
  `resetEmailProvider()` 语义。
- **阿里云 DirectMail 请求字段大小写错误，SDK
  静默丢弃全部字段**：`@alicloud/dm20151123` 的请求模型只识别 camelCase
  属性（再由模型 `names()` 映射为 wire 上的 `AccountName` 等）， 原实现传
  PascalCase，服务端因此只报
  `MissingAccountName: AccountName is mandatory for this action`——该报错看似"发信地址
  未配置"，实为字段名不被识别。改为 camelCase，并抽出 `buildSendMailParams()`
  供契约测试。
- **腾讯云 SES 用 `btoa` 编码邮件正文，中文模板必然抛错**：`btoa` 只接受 Latin-1
  字符， 而本站邮件正文含中文，调用即抛 `InvalidCharacterError`。改为对 UTF-8
  字节做 base64 （`@std/encoding/base64`），并抽出
  `encodeHtmlBase64()`。该修复仅静态验证（无腾讯云凭据）。

### 新增

- 仓库级门禁 `scripts/verify-compile-safe-imports.ts`（含 7 条自测，已注册进
  `scripts/gate-list.ts`）：扫描 `deno compile`
  产物对应的源码根（`noj-core/src`、 `noj-core/scripts`、`noj-cli/src`），禁止
  `import(<非字面量>)`。门禁自带正/反例控制断言，
  解析规则失效即失败；对修复前的同一份代码会报出 2 处违规，可直接复现该故障。
- `tests/shared/email-providers.test.ts`
  新增两条离线契约测试：阿里云请求字段必须能被 SDK 模型映射为 wire
  参数、腾讯云中文正文 base64 必须可还原为原始 UTF-8 字节。

### 变更

- 版本号同步为 `0.10.1-alpha.3`（noj-cli / noj-core / noj-llm-gateway / noj-ui /
  noj-lmcc-extension / noj-judge + CLI `VERSION` 常量与断言；`Cargo.lock` 由
  `cargo metadata` 重新生成，仅版本行）。

---

## [0.10.1-alpha.2] - 2026-09-25

### 修复

- **网关运行镜像的 dev 依赖仍未清除（`0.10.1-alpha.1` 的修法不充分）**：把
  `drizzle-kit` 移出 `imports` 并不够——`nodeModulesDir: "auto"` 安装的是
  **`deno.lock` 中解析出的整个 npm 包集合**，而 alpha.1 的 lock 仍把 dev
  链（`drizzle-kit` → Go 编写的 `esbuild`） 解析在内，于是镜像里依旧出现 18 个
  `@esbuild*` 目录、6 个 Go 二进制，Trivy 门禁继续失败 （已在本地完整复现 CI
  的镜像内容）。 本版把 lock 收敛到**非 dev
  图**（`src/main.ts`、`src/mod.ts`、`tests/*.ts`、`scripts/*.ts`， 排除
  `drizzle.config.ts`）：25 262 B → **3 662 B**，dev 链 0 处提及；并给
  `db:generate` 任务加 `--no-lock`，避免开发者运行生成迁移时把 dev 链写回 lock。
  实测（同一 Dockerfile 构建）：镜像内 Go 二进制 **0 个**、`/app/node_modules`
  仅 `drizzle-orm` / `hono` / `ioredis` / `postgres`、Trivy 同参数复扫**退出码
  0**、 `--network none` 启动**无任何下载**、镜像 432 MB → **254 MB**。

### 变更

- 版本号同步为 `0.10.1-alpha.2`（noj-cli / noj-core / noj-llm-gateway / noj-ui /
  noj-lmcc-extension / noj-judge + CLI `VERSION` 常量与断言）。

---

## [0.10.1-alpha.1] - 2026-09-25

### 修复

- **生产镜像发布链路阻塞（网关运行镜像混入构建期依赖）**：`noj-llm-gateway` 的
  `deno.json` `imports` 里登记了**仅构建期使用**的 `drizzle-kit`（只服务
  `drizzle.config.ts` 与 `db:generate`），而 `nodeModulesDir: "auto"`
  会把它整棵树 装进运行镜像；其传递依赖 `esbuild` 由 Go 编写，触发发布流水线
  Trivy 门禁的 49 项 HIGH/CRITICAL Go stdlib CVE。 影响不止该镜像缺 `v0.10.0`
  标签：`build-and-gate` 矩阵失败使 `verify-release` / `publish-cli` /
  `publish-release` 全部不执行，Release 因此**没有 `noj-cli` 二进制， 也没有
  `docker-compose.prod.yml` / `.env.prod.example` 资产**；而 `noj-cli install`
  第 1 步会无条件从同版本 Release 下载这两个文件并校验 SHA-256，导致**任何版本、
  任何 ref 的 `install` 都在 bootstrap 步骤 404**（`v0.9.5` 的 Release
  缺同样资产， 同一个原因）。 修法：把 `drizzle-kit` 移出
  `imports`，`drizzle.config.ts` 改用完整 URL 说明符，
  使运行期依赖图不再包含该链。镜像 432 MB → **254
  MB**，容器启动不再联网补装依赖。

### 变更

- 版本号同步为 `0.10.1-alpha.1`：noj-cli / noj-core / noj-llm-gateway / noj-ui /
  noj-lmcc-extension / noj-judge，以及 CLI 的 `VERSION` 常量与其断言测试。

---

## [0.10.0] - 2026-09-25

### 破坏性变更

#### 1. 首次安装不再有自举脚本

- **删除**：`setup.sh`、`scripts/deploy/install.sh`。
- **现在**：从 Release 手动下载 `noj-cli-linux-amd64` 与 `.sha256`，校验后执行
  `noj-cli install --dir <目录>`。`install` 自己从同版本 Release 拉取
  `docker-compose.prod.yml` / `.env.prod.example` 并校验 SHA-256， 再生成
  `.env.prod`（600，含自动生成的强随机密钥）、校验配置、拉镜像并等待健康检查。
- **为什么**：自举脚本存在的唯一理由是"CLI
  尚未安装"，而它带来了两条并存的安装路径 （`install.sh` 的 `--files-only` /
  `install-env` 等）与一处版本漂移面 （CLI 与部署文件取自不同来源）。

#### 2. 移除 JSON 编排模式与开发部署模式

- **删除的命令**：`deploy`、`maintain`、`stack`、`run-server`、`doctor`。
- **删除的配置**：`noj-deploy.json`、`noj-secrets.json`（若目录里仍有，可直接删除）。
- **删除的命令面**：`noj-cli deploy init --mode dev` 等开发部署入口。
- **现在**：配置真相源唯一 —— `.env.prod` + `docker-compose.prod.yml`。
- **源码开发**是两段式：`docker compose up -d`（仅基础设施）+ 各模块
  `deno task dev`。
- **为什么**：该模式实测**从未被使用**（全仓零个真实
  `noj-deploy.json`）且**已损坏** （`devTemplate`
  指向源码目录中不存在的二进制）。保留它会让"同一个词
  （`status`/`logs`/`backup`）在两个深度上含义不同"的混乱永久化。

#### 3. 备份形态统一为 `.nojbackup` 单文件

- **旧**：`snapshot-<ts>/` 目录，其中只有 `env.prod.gpg` 加密， `postgres.dump`
  / `redis.rdb` / `minio/` 均为**明文**。
- **新**：`snapshot-<ts>.nojbackup` 单文件 + 同级 `.sha256`，**整包** GPG
  AES-256 加密；包内 `manifest.json` 标 `payload_layout=prod-raw`，
  `postgres.dump` 与 `redis.rdb`
  为**原始二进制**（经文件重定向采集，不经字符串）。
- **为什么**：目录形态有两个后果——搬迁会漏文件；"加密备份"名不副实
  （能读目录的人就拿得到全库转储）。
- **迁移**：旧目录快照已不受支持。请用旧版工具恢复/导出后重新创建备份。

#### 4. `backup` 子命令与默认行为

| 命令                                                   | 说明                                                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `backup create [--retention-days N] [--min-free-mb N]` | 产出单个 `.nojbackup`（+ `.sha256`）；采集前校验可用空间，成功后按保留天数清理过期快照                   |
| `backup verify [--deep] [--payload-sha]`               | 三档校验：文件完整性 / 结构可解析 / 摘要比对                                                             |
| `backup list` / `backup prune`                         | `prune` **默认 dry-run**，`--confirm` 才真正删除；legacy 目录默认保留                                    |
| `backup restore --dry-run`                             | 只规划并校验，**零副作用**（不触 docker、不改配置）                                                      |
| `backup drill`                                         | 隔离环境真实恢复演练：独立 Compose 项目/子网、**不映射宿主机端口**；RPO/RTO 超限 = 失败(1)，资源不足 = 2 |
| `backup schedule install\|status\|remove`              | crontab **标记区块**（只动自己那几行）                                                                   |

> `prune` 两个条件都不给时**不删任何东西**；这是刻意的安全默认。

> **口令文件**：`--passphrase-file` > `NOJ_BACKUP_PASSPHRASE_FILE`（进程环境）>
> `.env.prod` 中的同名键。`verify`/`restore`/`drill` 都按此顺序解析——
> `--no-encrypt` 只关闭**整包**那一层加密，包内 `env.prod.gpg` 恒为加密，
> 因此这些命令始终需要口令。

#### 5. 命令接线改为纯 TS（不再有 bash 转发）

- **旧**：`noj-cli status` → `bash scripts/deploy/production.sh status` →
  `deploy.sh`。
- **新**：`noj-cli status` → `src/prod/lifecycle.ts` → `docker compose ps`。
- **删除的脚本**：根 `noj`、`production.sh`、`backup-schedule.sh`、
  `judge-install.sh`，以及 `test-*.sh`（9 个，其覆盖由 `noj-cli` 的 TS
  测试承接）。
- **效果**：`noj-cli` 的编译产物在**仅含 docker/curl/openssl**
  的环境即可完成全部 命令，不再需要仓库脚本。

#### 6. 过渡期：两个脚本已废弃

`scripts/deploy/deploy.sh` 与 `restore-drill.sh` 暂时保留，但**每次执行都会**：

1. 打印弃用警告并给出替代命令；
2. 要求输入 `y` 确认（输入其它内容 → 退出且**无副作用**）；
3. 自动化环境需显式设置 `NOJ_ACCEPT_DEPRECATED=1` 跳过；
4. **非 TTY 且未设置该变量 → 明确报错退出**（不会挂起）。

这两个脚本（及其依赖 `backup.sh`）将在后续版本删除。

### 新增

- `noj-cli backup drill`：隔离恢复演练（独立项目/子网、不映射端口、失败也清理）。
- `noj-cli backup schedule`：crontab 标记区块管理（幂等、危险表达式拒绝）。
- `noj-cli judge *`：独立 Judge Worker 部署。**强制**专用 rootless Docker
  socket， 拒绝 `/var/run/docker.sock` 与 `/run/docker.sock`；不安装/不替换宿主
  Docker daemon。
- `noj-cli problem init` 交互引导：含字段校验、回退（`:b`）与进度提示；
  EOF/连续无效输入**有界报错**而非挂死。
- `--json` 通道：所有生产命令的 stdout 在 `--json` 下**逐字节**为合法 JSON。
- 三档备份校验、`prune` 默认 dry-run、`restore --dry-run` 零副作用。

### 修复

- **`problem init` 在 Ctrl-D（EOF）时无限循环**并把进程堆吃满：现在有限次后
  明确报错，并给出可直接粘贴的自动化命令。
- **定时备份会静默失败**：cron 条目原先指向
  `scripts/deploy/backup.sh`（已删除）， 现指向
  `<安装目录>/bin/noj-cli backup create`。
- **`uninstall --all` 永久自锁**：完整性判据原含已删除的 `deploy.sh`，
  现改为"CLI 二进制 + 两个生产特征文件"。
- **迁移 `0000` 系列的跨 schema 外键**与 judge 结果竞态（见历史提交）。
- **`noj-cli judge` 此前完全不可用**：该命令的子命令已实现并有 36 个测试通过，
  但未接入命令表与分发——调用会得到"未知命令"。现已接通全部 8 个子命令，
  并补上缺失的 `judge install-env`（依赖检查 + rootless 隔离指引）。
- **`--help` 在窄终端（≤40 列）下破版**：26 行溢出到 80 列，且部分内容重复打印。
  现在按终端宽度自适应（`COLUMNS=30` 起零溢出）。
- **`--help` 曾承诺 `--profile <prod|stack>`**，而 `stack` 已被拒绝 （报"无效的
  --profile: stack；可选值: prod"）——help 与实现自相矛盾。已改为
  `--profile <prod>`。
- **`noj-cli status --dir <不存在>` 的退出码随 `--profile` 显隐而变**（2 / 1）。
  现统一为 1（运行失败），与 `--profile` 是否显式无关。

### 文档

- `AGENTS.md` §5.2 改写为**两段式开发流程**，并标明已删除的命令与脚本。
- `noj-cli/README.md`、`noj-docs` 的生产部署与运维文档按现状重写。
- `ROADMAP.md` 校准：移除未实现的多语言承诺；补上已实现项的代码证据与端点。
- 新增 CHANGELOG（本文件）。

---

## 历史版本

`v0.9.5` 及更早版本见 GitHub Releases：
<https://github.com/Neuro-OJ/neuro-oj/releases>
