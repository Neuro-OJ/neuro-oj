# noj-docs / 根目录文档与配置 审计报告

> 基线：`main` @ `31150781` · 只读静态审查 + 对抗性复核 · 真阳性 28 条（全部经逐条代码验证）

| 严重级 | 数量 |
|---|---|
| 中 | 8 |
| 低 | 17 |
| 信息 | 3 |

## 中

### NOJ-142 README 评测镜像名与构建脚本路径过时
- **位置**：`README.md:171`　**维度**：文档准确性
- **描述**：故障排查称「默认评测镜像为本地 noj-judge-python；检查 noj-judge/docker/ 构建脚本」，镜像名过时，且 noj-judge/docker/ 下只有 Dockerfile，构建脚本实际位于 noj-judge/scripts/build-sdk-images.sh。
- **证据**：`README.md:171；实际镜像 noj-evaluator-python / noj-solution-python（seed-system.ts:83/90），构建脚本 noj-judge/scripts/build-sdk-images.sh，docker/ 目录仅含 evaluator-python/solution-python/python 三个 Dockerfile。`
- **建议**：改为「默认评测镜像为 noj-evaluator-python / noj-solution-python；执行 noj-judge/scripts/build-sdk-images.sh 构建」。
- **验证**：确认 README.md:171 写默认镜像 noj-judge-python 且指向 noj-judge/docker/ 构建脚本；实际 seed-system.ts:83/90 为 noj-evaluator-python/noj-solution-python，构建脚本为 noj-judge/scripts/build-sdk-images.sh，docker/ 下仅三个 Dockerfile。文档过时属实。维持中。

### NOJ-124 judge 启动时经 Redis RPC 获取白名单的说法已过时且自相矛盾
- **位置**：`noj-docs/docs/operators/judge-workers.md:41`　**维度**：文档准确性
- **描述**：judge-workers.md:41 写『Judge Worker 启动时会通过 Redis RPC 获取白名单，并只预热和使用允许的镜像』，但同文件 49-50 行又写『judge 不再于启动时拉取』，二者自相矛盾；runtimes.md:26 与 judge-workers.md:122 同样沿用『启动时通过 Redis RPC 获取白名单』的过时说法。实现中 noj-judge 启动流程只有 Redis PING + Docker PING + 拉任务循环，无任何白名单 RPC 拉取，白名单校验在 noj-core 侧完成。
- **证据**：`文档原文 judge-workers.md:41『启动时会通过 Redis RPC 获取白名单』vs 49-50『镜像白名单校验在 core 侧题目 CRUD 与调度阶段完成，judge 不再于启动时拉取』；代码事实 noj-judge/src/main.rs:43-63 仅 Redis PING + Docker PING，全文件无 whitelist/RPC 拉取；noj-judge/src 下不存在 mq/rpc.rs（grep 无 whitelist/judge_images 命中）。`
- **建议**：删除 judge-workers.md:41-47 与 122、runtimes.md:26 中『启动时经 Redis RPC 获取白名单』的过时描述，统一为白名单校验在 noj-core 侧完成。
- **验证**：确认。judge-workers.md:41『启动时通过 Redis RPC 获取白名单』与同文 49-50『judge 不再于启动时拉取』直接矛盾；122 行与 runtimes.md:26 沿用『启动时经 Redis RPC 获取白名单』过时说法；代码事实 main.rs:43-63 仅 Redis PING+Docker PING，noj-judge/src 无 rpc.rs、无白名单拉取，白名单校验确在 core 侧。merged_from 已合并一条重复。

### NOJ-126 备份说明把支持包目录写成 data/packages（实际为 data/storage）
- **位置**：`noj-docs/docs/operators/local-start.md:146`　**维度**：文档准确性
- **描述**：文档称『local 模式的支持包在 noj-core/data/packages/』应纳入备份，但纯净评测包实际由 LocalStorageProvider 写入 `data/storage/`；`data/packages/` 只是 problems:build 的构建产物（导入载体，gitignored 可重建）。按文档备份会漏掉真正需要备份的评测包。
- **证据**：`文档原文『支持包：`local` 模式的支持包在 `noj-core/data/packages/`』；代码事实 noj-core/src/lib/storage/local.ts:69-70 `SUPPORT_PACKAGE_DIR ?? "data/storage"`，且 support-package.md:87 三层模型亦标注 `data/storage/<hash>.zip` 为 LocalStorageProvider 存储后端。`
- **建议**：将备份路径改为 `noj-core/data/storage/`（纯净评测包），并说明 `data/packages/` 为可重建的构建产物。
- **验证**：核实成立。local-start.md:146 称支持包在 noj-core/data/packages/；但 LocalStorageProvider(local.ts:69-70)实际以内容哈希写入 data/storage/，data/packages 仅为 problems:build 的可重建导入载体(gitignored)。按文档备份会漏掉真正的评测包存储目录，运维级数据丢失风险，维持中。

### NOJ-123 solution-sdk 与 rpc 文档声称支持 tuple，实际 codec 明确拒绝
- **位置**：`noj-docs/docs/problemsetters/solution-sdk.md:46`　**维度**：文档准确性
- **描述**：solution-sdk.md 把『元组（tuple）』列为可传递类型，rpc.md:156 也写『tuple | 编码为列表』，但实现中的类型校验明确拒绝 tuple（与 evaluator-sdk.md:70 的『set、tuple…不支持』一致）。两处文档与实现及另一处文档互相矛盾，会误导出题人使用 tuple 而实际抛 RejectedError。
- **证据**：`文档原文 solution-sdk.md:46『…列表、元组和字符串键字典』、rpc.md:156『tuple \| 编码为列表，返回后不保留 tuple 类型』；代码事实 noj-judge/sdk/evaluator/noj_evaluator_sdk/serialization.py:25『不允许：set、tuple、自定义类…』及同文件 validate_type 无 tuple 分支。`
- **建议**：删除 solution-sdk.md 与 rpc.md 中的 tuple，统一为 `None/bool/int/float/str/bytes/list/dict`（dict key 必须 str）。
- **验证**：solution-sdk.md:46 列『元组』、rpc.md:156 写『tuple | 编码为列表』；serialization.py validate_type(22-48) 无 tuple 分支且注释明言『不允许：set、tuple』，会抛 RejectedError。且 solution-sdk.md:62 自身又写『只允许 None/bool/int/float/str/bytes/list/dict』，文档与实现及文档间互相矛盾属实，保留中。

### NOJ-140 web-editor 引用错误 manifest 文件名
- **位置**：`noj-docs/docs/problemsetters/web-editor.md:38`　**维度**：文档准确性
- **描述**：统一题目包 manifest 文件名被写成 manifest.json，但代码与其余文档一致为 problem.json。出题人按 manifest.json 命名会导致导入报「zip 根级缺少 problem.json」。
- **证据**：`web-editor.md:38「包结构、manifest.json、导入语义…」；noj-core/src/lib/bundle-parser.ts:124-126 要求根级 problem.json；support-package.md:11、glossary.md:113、storage.md:50、ab-example.md:106 均为 problem.json。`
- **建议**：将 manifest.json 改为 problem.json。
- **验证**：web-editor.md:38 写 `manifest.json`，而 bundle-parser.ts:124-126 明确校验根级 `problem.json` 缺失即报错，其余文档均为 problem.json。出题人照文档命名会导致导入失败，属有实际后果的文档错误，维持『中』。

### NOJ-122 术语表仍声称 solution 段含『入口文件 entry』，该字段已移除
- **位置**：`noj-docs/docs/reference/glossary.md:69`　**维度**：文档准确性
- **描述**：术语表描述 runtime_config 时写『solution 段指定 image 与入口文件 entry』，但双容器架构后 solution 入口已硬编码为 main.py，`entry` 字段已从类型中移除，出题人不可配置。
- **证据**：`文档原文『solution 段指定 `image` 与入口文件 `entry`』；代码事实 noj-core/src/types/index.ts:22-29 `SolutionRuntime` 仅含 `image/call_timeout_ms/memory_limit_mb`，无 `entry`；noj-judge/src/dual/mod.rs:41 `SOLUTION_ENTRY_FILE = "main.py"`（硬编码）。`
- **建议**：删除『入口文件 entry』表述，改为 solution 入口为评测内部约定（硬编码 main.py）。
- **验证**：确认 glossary.md:69 写『solution 段指定 image 与入口文件 entry』，但 SolutionRuntime(types/index.ts:22-29) 仅含 image/call_timeout_ms/memory_limit_mb 无 entry，dual/mod.rs:41 SOLUTION_ENTRY_FILE="main.py" 硬编码。文档描述已过时属实。维持中。

### NOJ-130 env.example 中 JWT_SECRET 占位符是≥32字符的已知密钥，绕过长度校验与占位符黑名单
- **位置**：`scripts/dev/env.example:11`　**维度**：安全
- **描述**：该占位值 'please-replace-with-at-least-32-random-characters-aaaaaa'（56 字符）长度满足 main.ts 的 ≥32 字符强校验，且不以 change-this/replace-me/placeholder 开头，因此 noj-core/scripts/check-env.ts 的占位符黑名单（/^change-?this/i、/^replace-?me/i、/^placeholder/i 等）无法命中它。此模板正是 devtool.sh init-env 复制的默认模板（devtool.sh:56 ENV_TEMPLATE=env.example）。开发者若按 README 一键流程复制后未改，生产即以一个已提交进 git 的公开密钥签发 JWT，攻击者可伪造任意用户/管理员的 JWT。对比 noj-core/.env.example:14 的 change-this-... 值会被 check-env 拦截，本文件的值是唯一完全绕过双防护的版本。
- **证据**：`JWT_SECRET=please-replace-with-at-least-32-random-characters-aaaaaa`
- **建议**：改用与 noj-core/.env.example 一致的 change-this- 前缀占位值，或在 check-env.ts 黑名单追加 /^please-/i 与 /please-?replace/i；更稳妥的是把该模板 JWT_SECRET 置空并在模板顶部加入与 noj-core/.env.example 相同的生产安全警告头。
- **验证**：事实准确：scripts/dev/env.example:11 的 56 字符值满足 main.ts ≥32 校验，且逐条比对 check-env.ts 黑名单（^change-this/^changeme$/^replace-?me 等）无一命中；对比 noj-core/.env.example:14 的 change-this-… 会被拦截。但该值属 scripts/dev 开发模板而非生产 .env.example，check-env.ts 本就不在 main.ts 启动链路强制（仅 length 校验），且值本身自述 please-replace，需开发者用开发模板部署且不改密钥才可利用，故下调为中。

### NOJ-131 已知默认管理员凭据 admin@noj.local / AdminPass123! 未被占位符校验拦截，且 dev 流程禁用强制改密
- **位置**：`scripts/dev/env.example:47-48`　**维度**：安全
- **描述**：两个模板（scripts/dev/env.example:47-48 与 noj-core/.env.example:29-31）都以未注释的明文给出管理员默认凭据 admin@noj.local / AdminPass123!。该值满足项目自身密码策略（12位+大小写+数字），且不含 change-this/example/test/placeholder 等关键字，check-env.ts 无法标记它。scripts/dev/env.example 顶部没有任何'仅限开发/生产必须更换'的警告头；且 .env.example:33 注释说明 devtool.sh bootstrap admin 会把 NOJ_FORCE_PASSWORD_CHANGE 设为 false，即在推荐开发流程下该已知密码可直接登录管理员账号而无需改密。一旦服务暴露在首次登录前，攻击者可用公开的默认凭据夺取管理员。
- **证据**：`ADMIN_EMAIL=admin@noj.local\nADMIN_PASS=AdminPass123!`
- **建议**：模板中的 ADMIN_PASS 改为空值或明显占位（如 change-me），并让 check-env.ts 对 admin@noj.local / AdminPass123! 等已知默认值告警；scripts/dev/env.example 补充与 noj-core/.env.example 一致的'仅限开发，生产必须注入真实凭据'警告。
- **验证**：属实：scripts/dev/env.example:47-48 与 noj-core/.env.example:29-31 均以未注释明文给出 admin@noj.local / AdminPass123!；check-env.ts 占位符黑名单（change-this/changeme/example/test/xxx/placeholder/your-*/replace-me/TODO）不覆盖该值；.env.example:33 注释确认 devtool.sh bootstrap admin 会设 NOJ_FORCE_PASSWORD_CHANGE=false。默认凭据+不强制改密，服务在首次登录前暴露即被接管。真实，维持「中」。

## 低

### NOJ-205 .gitignore 未忽略 *.pem/*.key 等敏感密钥文件类型
- **位置**：`.gitignore:15`　**维度**：密钥卫生
- **描述**：.gitignore 环境段仅忽略 .env/.env.*，未覆盖 *.pem、*.key、*.crt、*.der、*.p12、*.jks 等私钥/证书类型。当前工作树中未发现此类文件（glob 结果为空），属防御性缺口：一旦开发者生成密钥文件放入仓库范围，会被默认跟踪提交。
- **证据**：`第 14-18 行仅含 .env / .env.* / !.env.example / !.env.e2e.template`
- **建议**：新增 *.pem、*.key、*.crt、*.der、*.p12、*.jks 及 id_rsa* 等敏感类型到忽略列表。
- **验证**：.gitignore:14-18 仅 .env/.env.* 等，确无 *.pem/*.key/*.crt/*.der/*.p12/*.jks。防御性缺口属实，保留低。

### NOJ-141 AGENTS.md JudgeTask 示例镜像名为旧单容器名
- **位置**：`AGENTS.md:75`　**维度**：文档准确性
- **描述**：顶层 AI 入口文档的 JudgeTask 示例中 evaluator 与 solution 的 image 仍为旧单容器镜像 noj-judge-python；双容器架构后应为 noj-evaluator-python / noj-solution-python。§14 故障排查也沿用旧名。
- **证据**：`AGENTS.md:75 与 AGENTS.md:81「"image": "noj-judge-python"」、AGENTS.md:855「默认镜像 noj-judge-python」；实际 seed 为 noj-core/src/services/seed-system.ts:83/90 的 noj-evaluator-python / noj-solution-python，构建脚本 noj-judge/scripts/build-sdk-images.sh:66-67 亦为二者。`
- **建议**：将示例与故障排查中的 noj-judge-python 改为 noj-evaluator-python / noj-solution-python。
- **验证**：核实 AGENTS.md:75/81 示例仍为 noj-judge-python；seed-system.ts:83/90 实际为 noj-evaluator-python/noj-solution-python。文档示例陈旧，纯文档漂移，中→低。

### NOJ-143 AGENTS.md 目录结构引用不存在的 scripts/db 与 scripts/build
- **位置**：`AGENTS.md:276-277`　**维度**：文档准确性
- **描述**：目录结构中列出 scripts/db/（数据库迁移与种子）与 scripts/build/（题目支持包构建），但实际 scripts/ 下仅有 dev/ 与 e2e/，这两项目录不存在。
- **证据**：`AGENTS.md:276「├── db/」、AGENTS.md:277「├── build/」；实际 scripts/ 仅 dev/、e2e/（find scripts -maxdepth 2）。`
- **建议**：删除 scripts/db 与 scripts/build 两行，或指向实际位置（迁移/构建在 noj-core/scripts/noj.ts）。
- **验证**：实测 scripts/ 下仅 dev/、e2e/、README.md，无 db/、build/；AGENTS.md 目录结构却列出 scripts/db 与 scripts/build，文档与现状不符，维持低。

### NOJ-148 AGENTS.md 评测 E2E test binary 清单不全
- **位置**：`AGENTS.md:261`　**维度**：文档准确性
- **描述**：目录结构与 §12.2 列的 E2E binary 均缺少 e2e_network_capability（共 6 个，实际 7 个）；noj-judge/AGENTS.md 已含该项。
- **证据**：`AGENTS.md:261 与 AGENTS.md:790 只列 6 个（…e2e_dual_container）；实际 noj-judge/tests/ 含 7 个 e2e_*.rs（含 e2e_network_capability.rs），noj-judge/AGENTS.md:65 已列 e2e_network_capability。`
- **建议**：补充 e2e_network_capability 到两处清单。
- **验证**：grep 确认 AGENTS.md 无 'e2e_network_capability'，而 glob 显示 noj-judge/tests 有 7 个 e2e_*.rs（含 e2e_network_capability.rs），§12.2 与目录清单均只列 6 个，文档遗漏属实，维持低。

### NOJ-149 AGENTS.md 评测运行时 Dockerfile 路径过时
- **位置**：`AGENTS.md:238`　**维度**：文档准确性
- **描述**：目录结构仅列 docker/python/Dockerfile 为「评测运行时」，但双容器后运行时为 docker/evaluator-python/ 与 docker/solution-python/，docker/python/ 为遗留单容器 Dockerfile。
- **证据**：`AGENTS.md:238「docker/python/Dockerfile # 评测运行时」；实际 noj-judge/docker/ 含 evaluator-python/、solution-python/、python/。`
- **建议**：更新为 evaluator-python/solution-python 两个运行时目录。
- **验证**：AGENTS.md:238 仅列 `docker/python/Dockerfile` 为评测运行时，实际 noj-judge/docker/ 现含 evaluator-python/、solution-python/（双容器）与遗留 python/，glob 已确认三目录均存在。文档过时，维持『低』。

### NOJ-150 AGENTS.md 与 noj-core/CLAUDE.md 路由清单缺 announcements
- **位置**：`AGENTS.md:172`　**维度**：文档准确性
- **描述**：路由目录清单漏掉 announcements 与 admin-announcements（两处文档均缺），与 src/routes 实际不符。
- **证据**：`AGENTS.md:172 与 noj-core/CLAUDE.md:107 的 routes 列表均止于 users；实际 noj-core/src/routes/ 另有 announcements.ts 与 admin-announcements.ts。`
- **建议**：在 routes 清单补充 announcements / admin-announcements。
- **验证**：核实 AGENTS.md:172 与 noj-core/CLAUDE.md routes 清单止于 users，而 src/routes/ 实际含 announcements.ts/admin-announcements.ts。文档清单缺失属实，维持低。

### NOJ-201 docker-compose.yml 默认弱口令且端口对外暴露，存在生产沿用风险
- **位置**：`docker-compose.yml:18`　**维度**：密钥卫生
- **描述**：PostgreSQL 使用 noj/noj/noj（17-19 行），Redis 无认证且 6379 直接映射宿主机，MinIO 使用 minioadmin/minioadmin（33-34 行）且 9000/9001 对外。该文件虽定位为开发基础设施，但凭据为公开弱口令且无任何 NOJ_ENV 生产护栏，直接 `docker compose up -d` 用于生产会导致 DB/对象存储被默认口令接管。与 .env.example 的 DATABASE_URL=postgres://noj:noj@... 交叉一致（同一弱口令）。
- **证据**：`POSTGRES_PASSWORD: noj（17-19 行）；MINIO_ROOT_PASSWORD: minioadmin（33-34 行）；redis 无 requirepass（2-9 行）`
- **建议**：生产部署改用 secrets 注入或 env 覆盖（${POSTGRES_PASSWORD:?err}），Redis 加 requirepass，MinIO 用随机 ROOT_PASSWORD；端口仅在开发环境绑定 127.0.0.1。
- **验证**：确认 docker-compose.yml POSTGRES_PASSWORD=noj、MINIO minioadmin/minioadmin、redis 无认证且端口未绑 127.0.0.1。该文件定位开发基础设施，AGENTS.md §5.1 已文档化这些默认凭据，生产沿用风险属假设性，由中下调为低。

### NOJ-136 faq 密码重置锚点死链
- **位置**：`noj-docs/docs/intro/faq.md:9`　**维度**：文档准确性
- **描述**：「忘记密码请走密码重置流程」链接指向 ../users/account.md#forgot-password，但 account.md 中该标题为「## 忘记密码」，无自定义锚点，实际生成 slug 为「忘记密码」，#forgot-password 为死锚点。
- **证据**：`链接：faq.md:9 → ../users/account.md#forgot-password；目标 headings：account.md:24「## 忘记密码」，构建产物 .vitepress/dist/users/account.html 中 <h2 id="忘记密码">，不存在 forgot-password。`
- **建议**：将链接改为 ../users/account.md#忘记密码，或给标题加 {#forgot-password} 自定义锚点。
- **验证**：faq.md:9 链接 ../users/account.md#forgot-password，但 account.md:24 标题为『## 忘记密码』无自定义锚点，VitePress 生成 slug 为『忘记密码』，#forgot-password 确为死锚点。文档死链影响轻微，从下调为低。

### NOJ-120 密码最小长度文档写 12 位，代码实际为 8 位
- **位置**：`noj-docs/docs/intro/getting-started.md:13`　**维度**：文档准确性
- **描述**：文档声称注册密码「至少 12 位」，但实现中最小长度是 8 位。同样的说法还出现在 intro/faq.md:13 与 users/account.md:18（『规则与注册相同』间接指向 12 位）。属安全相关且重复出现的事实性错误。
- **证据**：`文档原文『密码 \| 至少 12 位，含大小写字母与数字』；代码事实 noj-core/src/services/auth.ts:40 `const MIN_PASSWORD_LENGTH = 8;`，且 noj-core/src/routes/auth.ts:97 `if (body.password.length < 8)`。`
- **建议**：将三处『至少 12 位』改为『至少 8 位』，或同步把代码常量提升为 12 并保持文档一致。
- **验证**：核实：getting-started.md:13『至少 12 位』；auth.ts:40 MIN_PASSWORD_LENGTH=8；routes/auth.ts:97 `length < 8`。文档/代码确实不一致，且 auth.ts:33-39 注释明确说明降为 8 是刻意取舍。属纯文档准确性错误（非代码漏洞），高→低。

### NOJ-137 CLI 文档引用不存在的 deno task noj
- **位置**：`noj-docs/docs/operators/cli.md:22`　**维度**：文档准确性
- **描述**：文档称「deno task noj --help 可查看完整用法」，但 noj-core/deno.json 的 tasks 中不存在名为 noj 的任务；CLI 入口是 scripts/noj.ts，只能通过 deno run 调用。按此命令执行会报 task not found。
- **证据**：`cli.md:22「deno task noj --help」；实际 noj-core/deno.json tasks 仅有 dev/start/db:migrate/init:system/bootstrap:admin/problems:build/problems:import/dev-setup/db:generate 等，无 noj 任务。`
- **建议**：改为 deno run -A scripts/noj.ts --help（或 deno run --env-file=.env -A scripts/noj.ts --help）。
- **验证**：确认 cli.md L22 写 'deno task noj --help'，而 noj-core 无 noj 任务（CLI 入口为 scripts/noj.ts，经 deno run 调用），执行会报 task not found。文档命令错误属实，属文档准确性问题、影响有限，由中下调为低。

### NOJ-121 环境变量名 NOJ_ENV 被误写成『Neuro OJ_ENV』
- **位置**：`noj-docs/docs/operators/local-start.md:98`　**维度**：文档准确性
- **描述**：生产部署相关段落把环境变量 `NOJ_ENV` 误写为带空格的『Neuro OJ_ENV』，运营者按此配置会写入一个不存在的变量名。同文件第 118 行与 intro/faq.md:55 亦复现该错误。
- **证据**：`文档原文『`Neuro OJ_ENV` \| production 时…』『**Neuro OJ_ENV=production**』；代码事实 noj-core/.env.example 与 settings 相关代码均使用 `NOJ_ENV`（如 noj-core/src/lib/*，见 .env.example 注释及 CLAUDE.md 环境变量表）。`
- **建议**：将三处『Neuro OJ_ENV』更正为 `NOJ_ENV`。
- **验证**：核实 local-start.md:98/118『Neuro OJ_ENV』带空格拼写错误。真实文档错误，但为易察觉的笔误（复制即 shell 报错），中→低。

### NOJ-128 noj-ui 启动步骤写『deno install』，无此必要且会报错
- **位置**：`noj-docs/docs/operators/local-start.md:60`　**维度**：文档准确性
- **描述**：文档在 noj-ui 启动步骤中写 `deno install`，但 noj-ui 依赖由 `deno task dev`（`npm:nuxt`）自动安装，`deno install` 无脚本参数会直接报错，并非依赖安装步骤。
- **证据**：`文档原文『cd noj-ui → deno install → deno task dev』；代码事实 noj-ui/deno.json 的 `dev` 任务为 `deno task copy-monaco && deno run -A npm:nuxt dev`，无 install 任务；scripts/dev/devtool.sh:603 直接 `deno task dev`。`
- **建议**：删除 `deno install` 一行，仅保留 `deno task dev`。
- **验证**：local-start.md:60 写 deno install，但 noj-ui 无 install 任务（dev 走 deno task copy-monaco + npm:nuxt dev），裸 deno install 无参数会报错。文档步骤错误真实，维持低。

### NOJ-133 备份恢复示例硬编码 noj:noj 数据库凭据
- **位置**：`noj-docs/docs/operators/local-start.md:144`　**维度**：安全
- **描述**：「备份与恢复」章节的 pg_dump 示例直接写死连接串 'postgres://noj:noj@localhost:5432/noj'。备份章节面向实际运维（可能被用于生产），示例将开发默认凭据当作可用值展示，且未提示替换为真实凭据或从环境变量读取。属开发默认值，仅作提示。
- **证据**：`pg_dump "postgres://noj:noj@localhost:5432/noj" -F c -f backup.dump`
- **建议**：改为占位符形式（如 pg_dump "$DATABASE_URL" ... 或 postgres://USER:PASS@...），并加一句'替换为真实数据库凭据，勿在生产使用默认 noj/noj'。
- **验证**：属实：local-start.md:144 备份示例硬编码 'postgres://noj:noj@localhost:5432/noj'，未提示替换为真实凭据。属开发默认值文档提示，维持「低」。

### NOJ-125 A+B 示例题源文件清单错误（submission.py 已移除）
- **位置**：`noj-docs/docs/problemsetters/ab-example.md:10-14`　**维度**：文档准确性
- **描述**：文档把 1003 样例题源目录列成 evaluate.py / hidden.jsonl / submission.py / visible.jsonl，但实际目录已无 submission.py，且缺 problem.json / statement.md / template.py 三个实际存在的文件。
- **证据**：`文档原文『noj-core/data/problems-src/1003/ ├─ evaluate.py ├─ hidden.jsonl ├─ submission.py └─ visible.jsonl』；代码事实 noj-core/data/problems-src/1003/ 实际为 evaluate.py、hidden.jsonl、problem.json、statement.md、template.py、visible.jsonl；noj-core/src/services/support-package.ts:179-180 注明『submission.py（参考实现已从源码目录移除）』。`
- **建议**：把目录清单改为 evaluate.py / hidden.jsonl / problem.json / statement.md / template.py / visible.jsonl。
- **验证**：文档 ab-example.md:10-14 列 submission.py，但实际 noj-core/data/problems-src/1003/ 为 evaluate.py/hidden.jsonl/problem.json/statement.md/template.py/visible.jsonl（无 submission.py），support-package.ts:179-180 亦注明参考实现已移除。清单错误属实，但纯文档列出错、无安全/正确性影响，降为低。

### NOJ-129 rpc 文档写输出缓冲约 4 MiB，实际累计输出上限为 1 MiB
- **位置**：`noj-docs/docs/problemsetters/rpc.md:196`　**维度**：文档准确性
- **描述**：文档称『单个输出缓冲最多约 4 MiB，超过后会追加截断提示』，但收集容器输出（stdout/stderr 累积）的上限常量是 1 MiB；4 MiB 只是协议行切分的内部缓冲上限，二者被混淆。
- **证据**：`文档原文『当前单个输出缓冲最多约 4 MiB』；代码事实 noj-judge/src/dual/mod.rs:37 `MAX_OUTPUT_BYTES = 1024*1024`（1 MiB，输出累积上限），noj-judge/src/dual/protocol.rs:58 `MAX_BUFFER_BYTES = 4*1024*1024`（行切分缓冲，非收集输出）。`
- **建议**：将『4 MiB』更正为『1 MiB（累计输出）』，或区分『输出累积 1 MiB / 协议行缓冲 4 MiB』两个上限。
- **验证**：核实成立。rpc.md:196 称「单个输出缓冲最多约 4 MiB」；代码事实为 MAX_OUTPUT_BYTES=1024*1024(1 MiB，mod.rs:37，输出累积上限)与 MAX_BUFFER_BYTES=4*1024*1024(4 MiB，protocol.rs:58，行切分缓冲)，二者被混淆。文档准确性问题，维持低。

### NOJ-200 第二处模板 scripts/dev/env.example 同样内置固定管理员默认口令
- **位置**：`scripts/dev/env.example:48`　**维度**：密钥卫生
- **描述**：scripts/dev/env.example（devtool.sh init-env 使用的模板）同样硬编码 ADMIN_PASS=AdminPass123!，与 noj-core/.env.example 一致。devtool.sh init-env 直接拷贝该模板生成 noj-core/.env，导致开发/生产沿用同一固定口令，且无任何自检拦截。
- **证据**：`ADMIN_PASS=AdminPass123!`
- **建议**：与 noj-core/.env.example 同步改为占位符或移除默认值；在 devtool.sh init-env 流程中增加 check-env --strict 校验。
- **验证**：scripts/dev/env.example:48 确实硬编码 ADMIN_PASS=AdminPass123!。但模板注释说明未设 ADMIN_EMAIL/ADMIN_PASS 时会自动生成 24 字符随机临时管理员，且 NOJ_FORCE_PASSWORD_CHANGE 默认 true 强制首登改密，存在缓解，从下调为低。

### NOJ-204 scripts/e2e/setup.sh 存在 15 字符短测试 JWT 兜底值
- **位置**：`scripts/e2e/setup.sh:18`　**维度**：密钥卫生
- **描述**：E2E_JWT_SECRET 缺省兜底为 e2e-test-secret（仅 15 字符），不满足 main.ts 的 ≥32 字符强校验，会导致 noj-core 启动即被拒。AGENTS.md 已注明该旧值已被 32 字符值取代，但此处兜底仍残留，属测试固定值、非生产风险。
- **证据**：`E2E_JWT_SECRET="${E2E_JWT_SECRET:-e2e-test-secret}"`
- **建议**：将兜底值替换为与 env.e2e.template 一致的 32+ 字符值，或删除兜底并强制要求显式传入。
- **验证**：确认 setup.sh:18 E2E_JWT_SECRET 兜底 e2e-test-secret（15 字符），不满足 ≥32 强校验，若未显式设置该值 noj-core 启动即被拒；属测试固定值、非生产风险。维持低。

## 信息

### NOJ-146 README noj-core 测试文件计数过时
- **位置**：`README.md:212`　**维度**：文档准确性
- **描述**：称 noj-core「71 个测试文件」，实际 noj-core/tests 下现有 94 个 .ts 文件。
- **证据**：`README.md:212「71 个测试文件」；find noj-core/tests -name '*.ts' \| wc -l = 94。`
- **建议**：更新计数或去掉具体数字。
- **验证**：核实成立。README.md:212 称「71 个测试文件」；glob noj-core/tests/**/*.ts 实测 94 个 .ts 文件(含 helper/_setup)，计数过时。文档准确性，维持信息。

### NOJ-147 README noj-tests 测试文件计数过时
- **位置**：`README.md:222`　**维度**：文档准确性
- **描述**：称跨模块 E2E 为「23 个测试文件」，实际 e2e 目录已到 29 号（含两个 28_ 文件）共 30 个测试文件，另 helper.ts。
- **证据**：`README.md:222「23 个测试文件」；noj-tests/e2e/ 实际含 01~29 编号（28_announcements 与 28_clarifications 两个文件）共 30 个 *.test.ts。`
- **建议**：更新计数；顺带提示测试文件 28_ 编号重复（28_announcements/28_clarifications）。
- **验证**：属实：README.md:222 称「23 个测试文件」，实际 noj-tests/e2e/ 共 30 个 *.test.ts（01~29 号，含 28_announcements 与 28_clarifications 两个 28_ 文件），另 helper.ts。维持「信息」。

### NOJ-203 E2E 编排多处硬编码固定 JWT_SECRET 与管理员口令（测试专用）
- **位置**：`docker-compose.e2e.yml:78`　**维度**：密钥卫生
- **描述**：docker-compose.e2e.yml（78/113 行 JWT_SECRET=e2e-ci-secret-fixed-value-with-32-chars-min-abc，80/121 行 ADMIN_PASS=e2e_admin_pass，19 行 POSTGRES_PASSWORD=e2e）、env.e2e.template:10 与 .github/workflows/e2e.yml:73 三处固定同一测试密钥。均为 E2E 测试固定值，非生产凭据；但三处需同步维护、且 JWT_SECRET 为公开固定值，若被误用于非 CI 环境有伪造令牌风险。
- **证据**：`JWT_SECRET=e2e-ci-secret***min-abc（已按约定掩码）`
- **建议**：维持单一来源并加注释同步约束（当前已有注释）；明确仅限测试，生产入口 main.ts 的 JWT_SECRET 校验应确保不使用该公开值。
- **验证**：核实 docker-compose.e2e.yml:78/113 JWT_SECRET、:80/121 ADMIN_PASS、:19 POSTGRES_PASSWORD 均为硬编码固定值。属实但均为 E2E 测试专用、非生产凭据（发现亦自述），仅需同步维护，低→信息。
