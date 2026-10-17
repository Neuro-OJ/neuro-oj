# Agent Note: 新增界面题提交模式（submission_mode = ui）

Status: implemented

## Problem

Prompt 工程、超参数调节类题目，选手只需关心几个可调参数，却要手写 Python 脚本：
需要理解语法与字符串转义，提交记录里看到的是代码而非参数本身，选手还能在 Solution 容器里
执行任意代码。出题人也没有办法给每道题定制交互界面。

## Decision

后端评测机制不变（judge 仍然运行 Python 脚本），变的只是"脚本从哪来"：由题包自带的 HTML 界面驱动。

- `problems.submission_mode` 新增取值 `ui`（迁移 `0115` 只替换 CHECK 约束，无回填）；noj-cli vendor
  副本同步放开。OI 题与客观题不支持（OI 沿用"仅 code"校验）。
- **题包**：根级固定文件名 `ui.html`（≤512KiB），与 `template.py`（脚本模板）、`evaluate.py` 一起放进 zip。
  不加 manifest 字段：导入时 `problem.json` 会被剥离，运行期无从得知自定义文件名。导入校验
  `submission_mode=ui` 必须带 `ui.html`。`ui.html` 留在存储的支持包里，天然随版本管理
  （不改版本内容 / 草稿 / 发布链路）。
- **读取**：新增 `GET /api/v1/problems/:id/ui`，访问口径同 `/template`（题目可见性 + 竞赛上下文），
  按作答版本读取支持包内的 `ui.html`；界面题的 `/template` 一律 404（脚本模板是出题人的评测逻辑）。
- **提交**：语言固定 `ui`，`submissions.code` 保存参数 JSON 原文（对象；字段名须字母开头的
  字母数字下划线，≤100 个字段），文件名固定 `params.json`。`assertSubmissionLanguage` 在正式提交与
  自测两处校验。
- **注入**：集中在 `buildJudgeTask`（JudgeTask 唯一构造入口）：参数以 Base64 嵌入，生成
  `PARAMS = {...}` + 每字段同名变量 + 出题人脚本模板，wire 上为 `python3` / `main.py`。脚本模板取目标
  **版本**的 `template_content`（`scriptTemplateOf`），经正式提交、自测、挂起恢复、批量重测/升级四处传入
  （`BuildJudgeTaskInput.script_template`，不进入 JudgeTask）。judge 无需任何改动；JudgeTask 的
  `submission_mode` 对界面题映射为 `code`（`toJudgeSubmissionMode`）。
- **前端**：`components/uiproblem/UiFrame.vue` 在 `sandbox="allow-scripts"`（无 same-origin）的 iframe
  里渲染 `ui.html`，文档头注入 `default-src 'none'` CSP（禁一切网络）与 `window.NOJ` SDK，通过
  postMessage 通信（`values / submit / self-test` ↔ `init / set / result / disabled`），宿主只认
  `event.source === iframe.contentWindow` 的消息。`UiWorkspace.vue` 是做题工作区：左侧题面、右侧界面 +
  运行历史。
- **运行历史与回滚**：每轮提交/自测的参数本就随记录落库，不新增存储。core 新增
  `GET /api/v1/problems/:id/self-tests`（仅本人、不含代码，访问口径同创建自测）；前端合并提交与自测，
  按需拉取参数做行级 diff（LCS，`utils/textDiff.ts`）与一键回滚（经 `NOJ.onSet` 刷新界面），
  回滚保留前一版本供撤销，回滚后一旦继续编辑即失效。
- 出题文档 `noj-docs/docs/problemsetters/ui-problem.md`，含 `window.NOJ` 接口与沙箱限制说明。

## Alternatives considered

- **只出一道"改 PROMPT 字符串"的样例题**：不改平台，选手体验与安全边界都不改善。
- **专门的"提示词题"提交模式**（首版，已放弃）：选手编辑单段文本，核心包装为 `get_prompt()` 模块。
  只能覆盖纯文本提示词，无法表达温度、开关、多段 system/user 等参数，且每种题型都要改平台。
  界面题是它的超集：一个只含 `<textarea>` 的 `ui.html` 即可。
- **平台内置通用参数面板**（`problem.json` 声明字段）：不用写 HTML，但控件穷举有限，无法做定制交互。
- **`ui.html` 存进版本内容 / problems 列**：要同时改内容类型、草稿、发布投影、迁移，改动面远大于
  收益；放进支持包 zip 已有版本引用与删除守卫。
- **允许 manifest 自定义界面文件名**：运行期读不到 manifest（导入时剥离），模板读取已因此踩过坑。
- **iframe 开 allow-same-origin 或放开 CSP**：界面是出题人提供的第三方代码，可能读 cookie 或外发
  参数；不透明源 + 禁网络把风险压到只能通过 `window.NOJ` 与宿主通信。
- **前端 localStorage 保存每轮版本**：换设备/清缓存即丢失，且与服务端记录重复。

## Consequences

- 题包 `problem.json` 声明 `"submission_mode": "ui"`，根级放 `ui.html`、`template.py`、`evaluate.py`。
- 参数同样受 100KB `MAX_CODE_LENGTH` 约束；注入后体积约为 JSON 字节数的 4/3，远低于 MQ 上限。
- 界面与判卷版本一致：做题页带 `version_id` 取界面；但竞赛固定版本与题库默认版本不一致时，
  以页面解析出的作答版本为准（与模板读取同口径）。
- 若题目发布新版本改了字段名，历史参数在新界面上可能对不上控件——回滚历史版本前应以对应版本的界面为准。
- LMCC VS Code 插件仍只列出 `code` 题，界面题需在网页端作答。
