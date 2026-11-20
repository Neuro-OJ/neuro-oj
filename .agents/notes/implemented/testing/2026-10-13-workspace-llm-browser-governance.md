# Agent Note: Domain 模型治理真实浏览器与调用冻结验收

Status: implemented

## Problem

主线整合后，Domain Provider 同时包含域归属、资源 revision 与
RPM/TPM，模型能力别名也具有独立
CAS。服务测试不能证明普通域负责人的页面操作、两个标签页中的输入保留，或真实
Judge 调用上游时使用冻结的目标域模型。

## Decision

- 新增独立浏览器旅程和专属夹具，使用唯一 `llmgov-*`
  前缀的公开源域及两所私有学校。API
  仅准备账号、成员、负责人关系、题包及公开引用，不改变全局注册或创建政策。
- 两位普通域 owner 实际登录 Web，创建各自 Provider，填写并保存 RPM 60 / TPM
  1000000，在页面运行真实连接测试，并将同名 `fast` 能力映射到不同实际模型。
- 同域两个标签页各持有 revision 1。第一个页面保存后，另一个提交收到实际 HTTP
  409，原模型输入仍保留，持久配置保持第一个页面的选择。
- 两学校共享同一个不可变版本，提交经真实 MQ、Judge 与 Gateway 调用专用 Mock
  上游。评测器检查上游返回的真实模型回显和 8 Token
  用量后才给满分，不将账本或空用量当作调用成功。
- 首次受理后只读检查尝试快照与在途状态，再通过 Web
  修改目标域别名。原尝试继续使用冻结模型，后续新提交使用新模型；另外学校使用其独立模型。核对非空
  Gateway
  用量中的域、Provider、源题、版本与尝试归属，以及上游只记录模型的请求证据。
- 浏览器实际查看域内用量，且对另一学校查询第一学校的提交用量得到空列表。测试结束关闭
  Chromium 和数据库连接，保留新建验收资源与评测历史。

## Alternatives considered

- 只调用 API 或组件 mock 无法覆盖页面交互，没有采用。
- 修改数据库成绩或尝试状态会破坏真实执行证据，没有采用；数据库只读。
- 只检查 Gateway 用量中的模型无法独立证明转发参数，没有采用。专用 Mock 安全回显
  `request.model`，GET 仅提供请求路径与模型，不保存密钥或提示正文。
- 内置 Browser runtime
  已连接检查，但没有可用浏览器实例；读取故障说明并确认列表为空后，使用仓库标准
  Playwright Chromium 入口。

## Consequences

2026-10-13 在独立集成运行栈实际运行标准
`deno task test:domain browser --filter=ui/workspace-llm-governance`：core
8104、正式 UI 3003、Gateway 8008、专用上游 8009、隔离数据库
`noj_main_integration`。Judge 使用新的真实镜像与 SDK，未重启旧开发或验收栈。

- 完整浏览器旅程：1 passed（3 steps）/ 0 failed / 18 filtered out，耗时 1 分 16
  秒。
- Provider 创建与真实连接测试步骤通过，两个学校各自保存域 ID 和 RPM/TPM。
- 模型别名 CAS 与输入保留步骤通过。
- 三次真实提交均完成评测，得分 10000；每个提交各有一条成功的 8 Token
  用量。原尝试快照没有因后续别名修改而改变。
- 上游安全记录确认第一学校旧冻结模型和新模型各实际收到一次调用；第二学校模型收到其连接测试与评测调用。
- 两个新增 TypeScript 文件的格式、lint 与类型检查通过。运行日志
  `/tmp/noj-browser-llm-governance-first.log` 不提交。

本用例需要隔离数据库的只读快照核对和专用 Mock 的模型检查能力。标准 CI 的环境与
Mock 对齐由主 agent 统一完成；本记录不声称 CI 或其他 Browser
旅程已通过，也不将本次 Mock 上游调用视为商业 Provider 账单验收。
