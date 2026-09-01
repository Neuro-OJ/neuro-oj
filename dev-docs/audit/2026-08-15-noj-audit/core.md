# noj-core 审计报告

> 基线：`main` @ `31150781` · 只读静态审查 + 对抗性复核 · 真阳性 113 条（全部经逐条代码验证）

| 严重级 | 数量 |
|---|---|
| 高 | 10 |
| 中 | 27 |
| 低 | 46 |
| 信息 | 30 |

## 高

### NOJ-032 必填项 DATABASE_URL 缺失未在启动期失败，静默降级为 PGlite 内存库
- **位置**：`noj-core/src/db/connection.ts:32-56`　**维度**：可靠性
- **描述**：DATABASE_URL 在文档中为必填（无默认值），但 main.ts 启动流程没有任何 DATABASE_URL 存在性校验。isPGliteMode() 在环境变量缺失时返回 true，getDb() 静默创建 PGlite 内存库。因此 `deno task start` 在 .env 缺失 DATABASE_URL 时会「成功」启动在一个易失的内存库上：迁移/root 用户都跑在内存里，数据重启即全部丢失；多实例各自持有独立空库。checkDbHealth()（PGlite 分支）会返回 ok:true，/health 掩盖了该误配置。PGlite 回退本应仅用于测试（deno task test 用 env -u DATABASE_URL），却被生产/开发启动路径复用。
- **证据**：`function isPGliteMode(): boolean {
  return !Deno.env.get("DATABASE_URL");
}
// getDb() 中：if (isPGliteMode()) { _pgliteInstance = new PGlite(); ... return; }`
- **建议**：在 main.ts 启动早期显式校验 DATABASE_URL（当 NOJ_ENV != test 时），缺失即致命退出并给出清晰错误提示；仅测试环境（NOJ_ENV=test 或显式测试标志）允许 PGlite 回退，避免生产静默运行在易失内存库上。
- **验证**：确认 connection.ts L32-34 isPGliteMode() 在无 DATABASE_URL 时返回 true，getDb() 静默创建 PGlite 内存库；main.ts 启动仅有 JWT_SECRET/TRUSTED_PROXIES 校验，无 DATABASE_URL 存在性校验，runMigrations/ensureRootUser 均在内存库上执行并'成功'，/health 的 PGlite 分支返回 ok:true。属静默 fail-open 到易失存储，生产误配将导致数据重启即丢且健康检查掩盖。利用链完整，维持高。

### NOJ-000 JWT 验证未固定算法（未显式拒绝 HS384/HS512）
- **位置**：`noj-core/src/lib/jwt.ts:99-102`　**维度**：安全
- **描述**：签发侧固定 HS256（line 71 setProtectedHeader({alg:'HS256'})），但 verifyToken 调用 jwtVerify 时未传 algorithms:['HS256']。jose 对 octet 对称密钥默认接受所有 HMAC 算法，即同一密钥签发的 HS384/HS512 令牌会被通过（'none' 因无对应 key 仍被拒）。不满足『固定 HS256 且拒绝其他 alg』的加固要求。
- **证据**：`const { payload } = await jwtVerify(token, secret, { issuer: JWT_ISSUER, audience: JWT_AUDIENCE });`
- **建议**：验证时显式限定算法：jwtVerify(token, secret, { algorithms: ['HS256'], issuer: JWT_ISSUER, audience: JWT_AUDIENCE })
- **验证**：真阳性。submitObjectivePaper 练习模式（contest_id=null）经 withExplanation 返回 details 中的 expected（objective-judge.ts:76 将标准答案写入 expected）与 explanation；入口仅 getPaperOrThrow+assertObjectivePaper（116-141 行），无『套卷正被进行中竞赛引用』拦截；路由 problems.ts:476 仅 authMiddleware。前提是该套卷同时可练习提交且处于进行中竞赛，触发即可读全标准答案，绕过 stripExpected 防泄题。维持高。

### NOJ-091 getClientIp 无条件信任 X-Real-IP，可伪造 IP 绕过 IP 限流与 IP 封禁
- **位置**：`noj-core/src/lib/rate-limit-env.ts:136-166`　**维度**：安全
- **描述**：getClientIp 对 X-Forwarded-For 做了 TRUSTED_PROXIES 白名单校验，但对 X-Real-IP 完全没有校验：XFF 缺失时直接返回 c.req.header("x-real-ip")。X-Real-IP 是客户端可控头，且 noj-ui 的 Nitro 反向代理未注入/改写任何 forwarded 头，客户端可自选任意 IP 直达 noj-core，从而每次换 IP 获得全新 login:ip:<ip> 桶（完全绕过 30s/10 次 IP 限流）并规避任意 IP/CIDR 封禁。TRUSTED_PROXIES 对该路径不生效。
- **证据**：`const xff = c.req.header("x-forwarded-for");
  if (xff) { ... /* 白名单校验 */ }
  return c.req.header("x-real-ip") \|\| "unknown";`
- **建议**：对 X-Real-IP 同样套用 TRUSTED_PROXIES 校验，仅在连接对端命中白名单时信任；或统一只用经白名单校验的 XFF 最右非代理项。
- **验证**：rate-limit-env.ts:166 对 X-Real-IP 无任何白名单校验（XFF 分支才校验 TRUSTED_PROXIES）；已确认 noj-ui Nitro 代理不注入/改写 forwarded 头，客户端省略 XFF 自设 X-Real-IP 即可伪造来源 IP，绕过 30s/10 次 IP 限流并规避任意 IP/CIDR 封禁。账号维度限流仍生效，但 IP 封禁绕过成立，安全影响真实。

### NOJ-115 本地存储路径穿越：任意文件读取与删除（支持包 URL 未校验）
- **位置**：`noj-core/src/lib/storage/local.ts:53-56, 125-130, 137-149`　**维度**：安全
- **描述**：parseStorageUrl 将 noj-storage://local/<key> 中 / 之后的字符串原样作为 key（types.ts:128-137），LocalStorageProvider.get/delete 不校验 provider 也不校验 key，filePathFor 直接 `${storageDir}/${key}${suffix}` 拼接（仅当 key 以 .png/.jpg/.jpeg/.webp 结尾时才不加 .zip 后缀）。key 含 ../ 即可逃逸存储根目录。该 key 来源 support_package_storage_url 为客户端可控字段（problems-crud.ts:169、302-303；types/problems.ts:67、88），create/update 路由与服务层均未校验。攻击者登录后创建/更新自己的 U 型题目，写入 noj-storage://local/../../../../<目标>.zip（或图片扩展名），再通过 GET /problems/:id/support-package（routes/problems.ts:333-355）触发 storage.get 读取、DELETE /problems/:id/support-package（390-404）触发 storage.delete 删除。core 以 -A 全权限运行，可读取/删除 core 进程可访问的任意 .zip/.png/.jpg/.jpeg/.webp 文件（扩展名后缀为唯一限制）。
- **证据**：`function filePathFor(storageDir, key) {
  const suffix = KNOWN_EXTS.test(key) ? "" : ".zip";
  return `${storageDir}/${key}${suffix}`;
}
get(url) { const parsed = parseStorageUrl(url); return Deno.readFile(filePathFor(this.storageDir, parsed.key)); }`
- **建议**：在 storage 层对 key 做规范化与根目录约束：拒绝含 ..、以 / 开头的 key，解析后用 resolve() 归一化并断言结果仍在 storageDir 内（否则抛错）。同时在 create/updateProblem 输入层对 support_package_storage_url 做格式白名单校验（仅允许服务端生成的 noj-storage:// 形态或直接拒绝客户端传入该字段，改为由 upload 流程生成）。
- **验证**：利用链完整成立：support_package_storage_url 为客户端可控字段（CreateProblemInput:67/UpdateProblemInput:88），createProblem(problems-crud.ts:169)与 updateProblem(302-303) 均原样落库无格式校验；parseStorageUrl(types.ts:134-135) 将首个 / 后的字符串原样作 key，filePathFor(local.ts:53-56) 直接 ${storageDir}/${key}${suffix} 拼接且无 .. 拒绝；GET/DELETE support-package 路由触发 storage.get/delete。但 LocalStorageProvider 明确标注『仅开发测试、生产禁用』且构造时告警，生产应走 s3（S3 key 非文件系统路径无穿越），且 .zip/图片扩展名后缀约束了可读/删文件类型，故由严重下调为高。

### NOJ-116 S3 对象任意读取/删除：未校验的 support_package_storage_url 直达 GetObject/DeleteObject
- **位置**：`noj-core/src/lib/storage/s3.ts:102-119, 126-145`　**维度**：安全
- **描述**：S3StorageProvider.get/delete 直接以 parseStorageUrl(url).key 作为对象键执行 GetObjectCommand/DeleteObjectCommand，无 provider 校验、无 key 白名单。key 来自客户端可控的 support_package_storage_url（problems-crud.ts:169、302-303），因此攻击者可将该字段设为 noj-storage://s3/<任意对象键>，借助支持包下载/删除端点读取或删除桶内任意对象（如 packages/<他人题目UUID>.zip 或头像 avatar/<UUID>.<ext>），绕过题目归属权限。虽然 S3 键通常为 UUID 较难猜测，但结合题目列表/头像等公开信息仍可枚举部分对象。
- **证据**：`async get(url) { const parsed = parseStorageUrl(url); ... new GetObjectCommand({ Bucket: this.bucket, Key: parsed.key }); }
async delete(url) { const parsed = parseStorageUrl(url); if (!parsed.key) return; ... new DeleteObjectCommand({ Bucket: this.bucket, Key: parsed.key }); }`
- **建议**：与服务端可预测的 key 命名空间（packages/<problemId>.zip、avatar/<userId>.<ext>）绑定校验：读取/删除前解析 key 并核对是否属于当前题目/用户；或将 support_package_storage_url 从客户端输入中移除，仅由服务端 upload 流程生成并存储，禁止 create/update 直接写入。
- **验证**：S3StorageProvider.get/delete 直接以 parseStorageUrl(url).key 作为对象键执行 GetObject/DeleteObject，无 key 命名空间或归属校验；key 来自客户端可控字段。且键可预测——problem-bundle.ts:61 约定 `packages/${problemId}.zip`，题目 UUID 经公开列表/详情接口暴露，故任意登录用户可为自有题目伪造 `noj-storage://s3/packages/<他人UUID>.zip` 读取他人隐藏测试数据或删除桶内对象，绕过 checkSupportPackagePermission 的归属校验（因校验的是攻击者自己的题）。利用链每个环节均成立，维持『高』。

### NOJ-031 生产 TRUSTED_PROXIES 致命校验在系统设置缓存初始化之前执行，读不到 DB 配置
- **位置**：`noj-core/src/main.ts:122-157`　**维度**：可靠性
- **描述**：生产环境 trusted_proxies 校验（122-139 行）调用 getSetting("trusted_proxies")，但此时 initSystemSettings()（157 行）尚未执行，内存缓存为空。getSetting 只会回退到 envFallback 环境变量 TRUSTED_PROXIES（不在 ENV_ONLY_DEFINITIONS 白名单中）或注册表 default ""。结果：管理员按错误提示「通过管理后台→系统设置」在 system_settings 表配置的 trusted_proxies 在重启时完全不可见，被误判为「未配置」并 Deno.exit(1)，造成启动循环失败。这与 135 行注释「与运行时 getTrustedProxies() 共用同一数据源——system_settings 表」矛盾：运行时 getTrustedProxies()（rate-limit-env.ts:75-76）在缓存初始化后读的确实是 DB。
- **证据**：`if (Deno.env.get("NOJ_ENV") === "production") {
  const trustedProxiesSetting = getSetting("trusted_proxies");  // 缓存尚未初始化
  ...
  Deno.exit(1);
}
...
await fatalStep("系统设置缓存初始化", () => initSystemSettings()); // 157 行才加载 DB`
- **建议**：将该生产校验移到 initSystemSettings() 之后执行，或在校验内直接查询 system_settings 表（或先 await initSystemSettings），使启动校验与运行时 getTrustedProxies() 读取同一 DB 数据源，并保证错误提示与实际配置方式一致。
- **验证**：main.ts:122-139 在生产校验中调用 getSetting("trusted_proxies")，而 initSystemSettings() 在 157 行才执行；getSetting 读的是空内存 Map→envFallback(TRUSTED_PROXIES)→registry default ""，DB 中经管理后台配置的值在启动期不可见，导致按错误提示走 DB 配置的部署重启即 Deno.exit(1) 启动死循环。env 变量路径仍可用，但提示与实现数据源确实矛盾，属真实生产阻断性缺陷。

### NOJ-066 结果消费 at-most-once：BRPOP 后崩溃/DB 失败即丢结果且无重投
- **位置**：`noj-core/src/mq/base-consumer.ts:69-96`　**维度**：正确性
- **描述**：runConsumer 用 redis.brpop 弹出消息（71），随后 JSON.parse 并 await handleMessage（91）。一旦消息被 BRPOP 移除，若进程在 handleMessage（saveEvaluationResult）提交前崩溃，或 DB 写失败（consumer.ts 54-60 仅 logger.error 后 continue），该结果即从队列永久消失。此时 noj-judge 已完成该任务不会重跑，submission 永远停在 judging，结果永久丢失。没有 RPOPLPUSH 处理中列表、没有 ack、没有死信队列/重试。
- **证据**：`const result = await redis.brpop(opts.queueName, blpopTimeout) ...; // 弹出即移除
await opts.handleMessage(message); // consumer.ts: catch(dbErr){ logger.error(...); } 仅记录日志，消息已丢`
- **建议**：改用可靠队列语义：BRPOPLPUSH 到 processing 列表，处理成功后再 LREM；或在 handleMessage 失败时把原始消息重新 LPUSH 回结果队列（配合重试计数/死信上限），并给 saveEvaluationResult 增加 DB 重试。
- **验证**：base-consumer.ts:71 BRPOP 弹出、91 await handleMessage；consumer.ts:54-60 catch(dbErr) 仅 logger.error 后 return，不 requeue/无死信。judge 侧已推送不会重跑，结果永久丢失、submission 卡 judging。核实无 RPOPLPUSH/ack/重试，成立。

### NOJ-074 结果 BRPOP 后写 DB 失败被吞掉、不 requeue，结果永久丢失且提交卡在 judging
- **位置**：`noj-core/src/mq/consumer.ts:54-60`　**维度**：可靠性
- **描述**：BRPOP 是原子弹出（base-consumer.ts:71），消息一旦弹出即从 Redis 移除。handleResultMessage 内部对 saveEvaluationResult 抛出的 DB 错误只 logger.error 并 return（第54-60行），不重试、不 requeue、无死信队列。因此「BRPOP 与写 DB 之间进程崩溃」或「写 DB 失败」都会让该评测结果永久丢失，对应提交永久停留在 judging。核心侧没有任何「扫描 judging 提交向 judge 重查结果」的兜底（judge 侧虽有 push_result_with_retry + 文件 fallback，但那只能保证 judge 发出，无法弥补 core 消费侧丢失）。
- **证据**：`} catch (dbErr) {
  logger.error("评测结果持久化失败", {...});
  // 不中断循环，错误仅记录日志
}`
- **建议**：消费侧引入 at-least-once：写 DB 失败时将该结果 LPUSH 回结果队列或写入死信/本地 fallback 文件并重试；或引入定时任务扫描 status='judging' 且超时的提交向 judge 重查结果。
- **验证**：BRPOP 原子弹出（base-consumer.ts:71），saveEvaluationResult 抛 DB 错误仅 logger.error 后 return（consumer.ts:54-60），无 requeue/死信/重试；core 侧无任何「扫描 judging 提交向 judge 重查」兜底。DB 写失败或弹出后崩溃即永久丢结果、提交卡 judging，且 DB 故障时会逐条吞掉队列内全部结果。真实，维持高。

### NOJ-067 DB 写入与 LPUSH 非事务，崩溃产生永久 Pending 孤儿提交且无恢复机制
- **位置**：`noj-core/src/services/submissions-crud.ts:362-389`　**维度**：正确性
- **描述**：createSubmission 先 insert submissions（status=pending，363-373），再 pushJudgeTask LPUSH（384），最后才把 status 更新为 judging（387-389）。三步不具原子性：若进程在 insert 之后、LPUSH 之前崩溃，提交停留在 pending 且队列中无该任务，judge 永远不会处理它，用户永远拿不到结果。全代码库（main.ts、services/）没有任何启动扫描或后台任务去发现『pending 但不在队列中』的提交并重投，属于永久性孤儿。
- **证据**：`await db.insert(submissions).values({ ..., status: "pending", ... }); // 先落库
await pushJudgeTask(task); // 再入队
await db.update(submissions).set({ status: "judging" })...; // 最后改状态`
- **建议**：引入 outbox 模式（先写提交+outbox 记录在同一事务，后台投递并在成功后标记），或启动时/定时扫描『status=pending 且 created_at 超过阈值』的提交重投队列；至少把入队失败回滚为 error 并保证幂等可重投。
- **验证**：确认。submissions-crud.ts:363-373 insert status=pending，384 pushJudgeTask，387-389 才改 judging，三步非原子；main.ts 启动步骤（grep 无 pending 扫描/重投）与 services/ 均无『pending 但不在队列』的重投/回收机制，insert 与 LPUSH 间崩溃即产生永久孤儿提交。LPUSH 失败虽会置 error（405-418），但覆盖不了崩溃窗口。merged_from 已合并一条重复描述。

### NOJ-075 批量重测用首条提交的 rejudge_seq 覆盖全部提交，多数结果被误判过时而静默丢弃
- **位置**：`noj-core/src/services/submissions-rejudge.ts:261-266,288-299`　**维度**：可靠性
- **描述**：rejudgeProblemSubmissions 事务内将所有提交 rejudge_seq 各 +1 后，仅从 allIds[0]（第一条）读取一次 rejudge_seq 作为 currentSeq（第261-266行），随后在循环里给每个 task 都赋 rejudge_seq: currentSeq（第299行）。当题目内不同提交 rejudge_seq 不一致（如某条曾被单独重测过）且 allIds[0] 的 seq 较低时，其余提交的任务 seq 会小于其 DB 中真实 seq；结果回来时 saveEvaluationResult 的 incomingSeq < sub.rejudge_seq 判断（submissions-result.ts:61）会将其当作『过时结果』静默 return，导致这些提交的评测结果永久丢失、卡在 judging。单条重测路径（第100-104、122行）正确按行取值，批量路径逻辑不一致。
- **证据**：`const [seqRow] = await db.select({ rejudge_seq: submissions.rejudge_seq }).from(submissions).where(eq(submissions.id, allIds[0])).limit(1);
const currentSeq = seqRow?.rejudge_seq ?? 0;
...
rejudge_seq: currentSeq, // 循环内对每条提交复用同一值`
- **建议**：在循环内使用 rejudgeRows 中每行各自的 rejudge_seq（sub.rejudge_seq）构造 task，而非复用 currentSeq。
- **验证**：核实成立。submissions-rejudge.ts 事务内(239-246)对全部提交 rejudge_seq+1，事务后仅读 allIds[0] 一次作 currentSeq(261-266)并在循环内对所有 task 复用(299)；submissions-result.ts:61 的 incomingSeq < sub.rejudge_seq 静默 return，且不更新状态。若题内不同提交 rejudge_seq 不一致(某条曾被单独重测，rejudgeSubmission 单独+1)，批量重测后这些提交任务 seq 小于其 DB 真实 seq，结果被当作过时丢弃、卡死在 judging。单条路径(100-104,122)按行取值正确，批量路径不一致。利用链：管理员批量重测(可触发)+存在混合 seq(前提) → 结果静默丢失(后果成立)。

## 中

### NOJ-053 drizzle-kit 完全无版本约束，lock 重建即漂移
- **位置**：`noj-core/deno.json:40`　**维度**：依赖卫生
- **描述**：drizzle-kit 以 `npm:drizzle-kit` 裸引用声明（无 @version），lock 当前锁定 0.31.10，与 drizzle-orm@0.45.2 版本严重错位（官方二者通常同版本号发布）。任何 `deno cache --reload` 或 lock 重建都会静默拉取最新 drizzle-kit，导致迁移生成行为漂移。
- **证据**：`"drizzle-kit": "npm:drizzle-kit"`
- **建议**：改为与 drizzle-orm 对齐的精确版本，如 `npm:drizzle-kit@0.45.2`，并定期用 `deno task db:generate` 验证二者兼容。
- **验证**：deno.json:40 `"drizzle-kit": "npm:drizzle-kit"` 无版本约束，与 drizzle-orm@0.45.2(34 行) 裸引用不符。属 dev-only 工具，但 lock 重建即漂移的风险属实，保留中。

### NOJ-005 mock 邮件 Provider 将含明文重置令牌的链接写入日志（生产默认回退 mock）
- **位置**：`noj-core/src/lib/email-providers/mock.ts:24-30`　**维度**：安全
- **描述**：mock Provider 用 logger.info 打印含明文 token 的 resetLink，字段名 'link' 不在 lib/logging.ts 的 SENSITIVE_KEYS（password/token/secret/code/...）中，故不会被脱敏，明文重置令牌落入日志。EMAIL_PROVIDER 默认值为 mock（lib/email.ts:35 getSetting('email_provider')?.value ?? 'mock'），生产环境若未配置真实 Provider 即回退 mock，导致重置令牌泄露到日志。
- **证据**：`logger.info("密码重置邮件（mock）", { module: 'email-mock', event: 'password_reset', to: email, link: resetLink, expiresIn: ... });`
- **建议**：将 link 加入脱敏白名单（或改为只打印 token 哈希）；生产环境强制校验 EMAIL_PROVIDER 非 mock（或对 mock 在 NOJ_ENV=production 下拒绝启动/拒绝发送）。
- **验证**：真阳性。POST /submissions（submissions.ts:95）与 POST /problems/:id/submit（problems.ts:476）仅挂 authMiddleware；app.ts 无全局 rateLimit 中间件（仅 requestContext/banlist/maintenance）。登录用户可无限刷提交灌满 Redis 队列与 DB。维持中。

### NOJ-054 腾讯云/阿里云 SDK 以内联 npm: 导入，未声明进 imports 映射
- **位置**：`noj-core/src/lib/email-providers/tencent.ts:45`　**维度**：依赖卫生
- **描述**：`tencentcloud-sdk-nodejs-ses`（tencent.ts:45，`^4.1.247`）与 `@alicloud/openapi-core`（aliyun.ts:51，`^1.0.7`）用内联 `await import("npm:...")` 直接引用，未列入 deno.json 的 imports 映射，成为审计不可见的'隐藏依赖'；且二者带宽泛 ^ 范围。deno.lock 虽有记录（第 41/20 行），但 imports 映射与 workspace.dependencies 均缺失，易被漏审。
- **证据**：`const { ses }: any = await import("npm:tencentcloud-sdk-nodejs-ses@^4.1.247");`
- **建议**：在 deno.json imports 中显式声明并固定精确版本，代码改用映射别名导入；或在 CLI 层统一登记这类动态 import 的依赖。
- **验证**：确认。tencent.ts:45 内联 `await import("npm:tencentcloud-sdk-nodejs-ses@^4.1.247")`、aliyun.ts:51 内联 `npm:@alicloud/openapi-core@^1.0.7`；deno.json imports 映射均无这两项（仅有 @alicloud/dm），确属审计不可见的隐藏依赖，带 ^ 宽范围。

### NOJ-061 local 存储 key 未清洗导致路径穿越（任意文件读取/删除）
- **位置**：`noj-core/src/lib/storage/local.ts:53-56`　**维度**：安全
- **描述**：LocalStorageProvider.filePathFor 将 parseStorageUrl 解析出的 key 直接拼进文件路径 `${storageDir}/${key}${suffix}`，未做任何 `..`/绝对路径清洗。key 来自 `noj-storage://local/<key>` URL，而 URL 又来自题目表的 support_package_storage_url 字段，该字段在 createProblem/updateProblem 中被原样接受、无校验（problems-crud.ts:169、302-304）。任何登录用户（可创建 U 型题）即可构造 `support_package_storage_url = "noj-storage://local/../../../../some.png"`，随后经 GET /problems/:id/support-package 或 createSubmission 触发 storage.get() 读取，经 DELETE /problems/:id 触发 storage.delete() 删除。可穿越目录读取/删除路径以 .png/.jpg/.jpeg/.webp/.zip 结尾的任意文件（否则自动追加 .zip 后缀）。S3 provider 同样直接使用未清洗的 parsed.key（s3.ts:106-109、131-136），可跨对象读取/删除同桶内任意对象。
- **证据**：`function filePathFor(storageDir: string, key: string): string {
  const suffix = KNOWN_EXTS.test(key) ? "" : ".zip";
  return `${storageDir}/${key}${suffix}`;
}`
- **建议**：在 parseStorageUrl 或 filePathFor 中对 key 做白名单清洗（如仅允许 base64url/已生成的文件名字符集，拒绝 `..`、`/`、`\`、空 key），或改用 resolve + 校验最终路径仍位于 storageDir 内；同时在 createProblem/updateProblem 入口拒绝非受控的 support_package_storage_url（仅允许服务端生成的 noj-storage:// URL）。
- **验证**：filePathFor 直接 `${storageDir}/${key}${suffix}` 拼接，parseStorageUrl 仅校验前缀、key 取首个 '/' 之后原样返回，support_package_storage_url 在 problems-crud.ts:169/302-303 原样入库无校验，download/delete 路径确认会触发 storage.get/delete。利用链成立。但存在两点缓解：local provider 显式标注『仅开发测试』（构造函数打印废弃警告，生产要求 s3）；且 KNOWN_EXTS 判定使 key 不以 .png/.jpg/.jpeg/.webp 结尾时被强制追加 .zip，穿越只能读/删这些扩展名结尾的文件，非任意文件。故由『高』下调『中』。

### NOJ-030 无优雅关闭：SIGTERM/SIGINT 无处理，请求不排空，在途评测结果丢失
- **位置**：`noj-core/src/main.ts:192-200`　**维度**：可靠性
- **描述**：main() 直接 `Deno.serve({ port }, app.fetch)` 后返回，整个 src/ 目录没有任何 `Deno.addSignalListener`/`SIGTERM`/`SIGINT`/`AbortSignal`/`server.shutdown()` 处理。收到终止信号时进程被直接杀死：处理中的 HTTP 请求不排空、Redis 连接不释放、消费者正执行的 BRPOP 不打断。由于消费者用 BRPOP（base-consumer.ts:71）实现 at-most-once，进程在 pop 之后、saveEvaluationResult 完成之前被杀，该条评测结果消息即永久丢失，提交停留在 judging。
- **证据**：`Deno.serve({ port }, app.fetch);
logger.info("noj-core 已启动", ...);
...
await main();`
- **建议**：为 Deno.serve 传入 AbortSignal（signal 选项），监听 SIGTERM/SIGINT 后调用 server.shutdown() 排空在途请求，再停止消费者、关闭 Redis 连接与 DB 连接后退出。评测结果消费改用可靠投递（BRPOPLPUSH 到处理队列 + 处理完成后确认），配合优雅关闭避免消息丢失。
- **验证**：属实：main.ts 无任何 Deno.addSignalListener/SIGTERM/AbortSignal/server.shutdown()，末尾 Deno.serve 后直接返回；base-consumer.ts:71 用 brpop 实现 at-most-once，pop 后进程被杀则该结果消息永久丢失。但触发条件是部署/重启恰逢在途消息，属运维可靠性而非远程可利用路径，损失窗口窄（单条在途结果），故由「高」下调「中」。建议仍值得补 AbortSignal+shutdown 与可靠投递。

### NOJ-007 被封禁用户的既有 JWT 对读请求（GET）仍可用
- **位置**：`noj-core/src/middleware/auth.ts:96-112`　**维度**：安全
- **描述**：checkBanStatus 仅对非 GET/HEAD/OPTIONS 方法（且非 BAN_WHITELIST）才查封禁状态。被封禁用户持有既有 JWT 时，写操作被拦，但所有读接口（/me、提交历史、私信 GET /conversations、/messages 等）仍可访问。登录端点虽拦截新登录，但 banUser 不吊销既有 token（revokeJti 仅在 routes/auth.ts 的 logout/change-password 调用）。
- **证据**：`if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.method !== "OPTIONS" && !BAN_WHITELIST.includes(c.req.path)) { const banState = await getUserBanState(userId); ... }`
- **建议**：封禁时同步 revokeJti；或将读接口（尤其私信/个人数据）也纳入封禁检查，仅放行必要的公开浏览。
- **验证**：真阳性。local-start.md:146 称支持包在 noj-core/data/packages/，但 LocalStorageProvider 实际写入 data/storage（local.ts:69-70），data/packages 只是 problems:build 可重建产物。按文档备份会漏掉真正评测包，有数据丢失风险。维持中。

### NOJ-097 IP 封禁对无法解析的 IP（unknown）fail-open 放行
- **位置**：`noj-core/src/middleware/banlist.ts:38-42`　**维度**：安全
- **描述**：banlistMiddleware 在 getClientIp 返回 "unknown" 时直接 return next() 放行。直连部署或代理未注入 XFF 时所有写请求都可能被判 unknown 而绕过 IP 封禁；限流路径则退化为单一共享桶 login:ip:unknown，可被单攻击者耗尽以 DoS 其他同桶用户。封禁路径与限流的 fail-closed 取向相反，是 fail-open。
- **证据**：`const clientIp = getClientIp(c);
  if (clientIp === "unknown") {
    // 没解析到 IP（如本机直连）—— 放行
    return next();
  }`
- **建议**：结合可信代理链与直连对端地址判定真实 IP；无法判定时对写操作 fail-closed，或至少不要让 unknown 汇聚成单一可耗尽共享桶。
- **验证**：核实成立。banlist.ts:38-42 clientIp==="unknown" 时 return next() 放行；rate-limit-env.ts:136-167 getClientIp 从不读取 socket 对端地址，无 XFF/X-Real-IP 时(直连部署)恒返 unknown，IP 封禁完全失效，且限流共享 login:ip:unknown 单桶可被耗尽。缓解因素：生产 main.ts 要求 TRUSTED_PROXIES、注释声明为设计取舍，但直连无代理场景仍 bypass，故维持中(部分为文档化设计权衡)。

### NOJ-092 账号维度限流/锁定按原始 login 字符串建 key，用户名/邮箱交替可绕过账号锁定
- **位置**：`noj-core/src/middleware/login-rate-limit.ts:88`　**维度**：安全
- **描述**：账号窗口计数与失败锁定 key 均以 body.login 原始串为键，而 loginUser 同时接受用户名或邮箱登录（or(eq(username),eq(email))）。攻击者交替用 "alice" 与 "alice@example.com" 提交，失败计数/窗口被拆到两个独立 key：账号窗口 5/30s 翻倍为 10/30s，且锁定阈值 10 次连续失败被拆分后永远达不到，账号级抗分布式爆破锁定完全失效。
- **证据**：`const key = (login \|\| "anonymous").toLowerCase().slice(0, 64);
return checkRateLimit(`${namespace}:acc:${key}`, LOGIN_LIMITS.acc);`
- **建议**：解析出用户后改用规范化 user.id 作为账号限流/计数/锁定的 key，避免用户名/邮箱二义性。
- **验证**：确认 login-rate-limit.ts:88 以原始 login 串建 key，loginThrottle.ts failKey/lockKey 用 u.toLowerCase()（u=body.login，见 routes/auth.ts:157/168），loginUser(auth.ts:221-224) 用 or(eq(username),eq(email)) 双路登录。交替用用户名/邮箱可将账号窗口 5/30s 翻倍、且锁定阈值 10 次被拆分永达不到，账号级抗爆破锁定失效属实。维持中。

### NOJ-093 注册接口无任何速率限制，可批量注册刷账号
- **位置**：`noj-core/src/routes/auth.ts:66-104`　**维度**：安全
- **描述**：POST /api/v1/auth/register 仅做字段校验与 allow_register 死开关，未挂任何限流（对比 /login、/change-password 均有 IP+账号限流）。攻击者可单 IP 高频批量注册（bcrypt cost 12 还放大 CPU 消耗），用于刷号、垃圾账号等。
- **证据**：`auth.post("/register", async (c) => {
  const allowRegisterSetting = getSetting("allow_register");
  if (allowRegisterSetting?.value === false) { throw new ForbiddenError(...); }
  ...
  const user = await registerUser(body, clientIp);`
- **建议**：为注册端点增加 IP 维度限流，并考虑邮箱/账号维度计数。
- **验证**：auth.ts:66-104 /register 仅做字段校验 + allow_register 死开关，无 loginIpRateLimit()；对比 /login(148) 与 /change-password(211) 均有限流。单 IP 可高频注册 + bcrypt cost12 CPU 放大属实，保留中。

### NOJ-094 忘记/重置密码接口无限流，可对被已知邮箱目标进行邮件轰炸
- **位置**：`noj-core/src/routes/auth.ts:364-413`　**维度**：安全
- **描述**：POST /forgot-password 与 /reset-password 均无速率限制。forgot-password 对存在的邮箱会发送重置邮件，攻击者可对已知邮箱高频触发发送造成邮件轰炸/邮件服务成本损耗。
- **证据**：`auth.post("/forgot-password", async (c) => {
  ...
  await requestReset(body.email, appBaseUrl, getClientIp(c));
  return c.json({ ok: true, ... }, 200);`
- **建议**：为 forgot-password/reset-password 增加 IP 与邮箱维度限流。
- **验证**：确认。routes/auth.ts:364-385 forgot-password 与 394-413 reset-password 均无任何限流中间件（对比 login 的 loginIpRateLimit），forgot-password 对存在的邮箱调 requestReset 发邮件，可被用于对已知邮箱邮件轰炸/成本损耗，属真实安全缺口。

### NOJ-096 私信发送接口无限流，可批量私信骚扰
- **位置**：`noj-core/src/routes/conversations.ts:51,95`　**维度**：安全
- **描述**：POST /（创建会话）与 POST /:id/messages（发送私信）均无任何速率限制（全文件无 rateLimit 引用）。登录用户可高频私信他人，造成骚扰与资源消耗。
- **证据**：`router.post("/", async (c) => { ... });
router.post("/:id/messages", async (c) => { ... });`
- **建议**：为私信发送端点增加 per-user 频率限制（最小发送间隔或计数桶）。
- **验证**：conversations.ts 全文件无 rateLimit 引用，POST /（:51）与 POST /:id/messages（:95）仅做 authMiddleware + 长度校验，登录用户可高频私信骚扰。真实，维持中。

### NOJ-049 提交队列状态接口存在 IDOR：任意登录用户可查任意提交的队列状态与 contest_id
- **位置**：`noj-core/src/routes/submissions.ts:213-224`　**维度**：安全
- **描述**：路由 GET /:id/status 调用 getSubmissionQueueStatus(id) 时未传入当前登录用户 userId（与 getSubmission 传 viewerId 的做法不一致）。queue.ts 的 getSubmissionQueueStatus 在 viewerUserId 为 undefined 时跳过所有者校验（queue.ts:283-285），导致任意登录用户可枚举 submission_id 查询任意提交的 status、contest_id、judge 时间戳与排队位置。queue.ts:255-257 的注释明确警告"两者均不传时按公开访问处理（生产路由不应走到此分支）"，但该生产路由恰好走到了此分支。
- **证据**：`router.get("/:id/status", authMiddleware, async (c) => { const id = c.req.param("id") as string; const result = await getSubmissionQueueStatus(id); ...`
- **建议**：改为 getSubmissionQueueStatus(id, c.var.userId)（或传入 c 以支持 admin 实时权限），使队列服务层的所有者校验生效；对非 owner 返回 404 或裁剪掉 contest_id。
- **验证**：确认 submissions.ts:218 调 getSubmissionQueueStatus(id) 未传 userId，queue.ts:283-285 在 viewerUserId===undefined 时跳过所有者校验，任意登录用户可查任意提交的 status/contest_id/时间戳。缓解：路由注释(208-212)声明『任意已登录用户均可查看』，且泄露字段敏感度低（无 code/score/output）。但服务层注释(252-253)明确警告『生产路由不应走到此分支』，说明路由未接入服务层已提供的 IDOR 防护，属真实访问控制缺口。维持中（介于中低之间）。

### NOJ-069 提交无频率限制，可刷爆评测队列
- **位置**：`noj-core/src/routes/submissions.ts:95-128`　**维度**：正确性
- **描述**：POST /api/v1/submissions 仅挂 authMiddleware，无任何 rateLimit（对比 /public/recent、/today-stats 均挂了 rateLimit）。客观题提交 POST /api/v1/problems/:id/submit（problems.ts 476-486）同样无频率限制。每个请求都会 insert 一条 submission 并 LPUSH 一个任务，攻击者/误操作者可无限刷提交灌满 Redis 队列与 DB。100KB 的代码大小上限只限制单条大小、不限制频率。
- **证据**：`router.post("/", authMiddleware, async (c) => { ... await createSubmission(userId, {...}) ... }); // 无 rateLimit`
- **建议**：给提交创建端点（编程题与客观题）增加 rateLimit 中间件（按用户/IP 维度限频），或在 createSubmission 内做 Redis 频率桶校验。
- **验证**：核实成立。submissions.ts:95 router.post("/", authMiddleware, ...) 无 rateLimit(对比 /public/recent、/today-stats 均挂 rateLimit)；problems.ts:476 POST /:id/submit 亦仅 authMiddleware 无 rateLimit。每次请求 insert submission + LPUSH 任务，登录用户可无限刷爆 Redis 队列与 DB，100KB 仅限单条大小不限频率。属真实 DoS 面，维持中。

### NOJ-025 巨型文件：community.ts 单文件 1583 行，职责严重超载
- **位置**：`noj-core/src/services/community.ts:1-1583`　**维度**：代码质量
- **描述**：该文件 44+ 个导出函数横跨 5 个独立业务域：配置/开关（getCommunityConfig/assertCommunityEnabled）、板块（listBoards/createBoard/updateBoard）、帖子与评论（createPost/updateComment 等）、社交互动（togglePostLike/toggleBookmark/toggleFollow）、通知（listNotifications/markNotificationsRead）、审核与处罚（createReport/resolveReport/createSanction/applyCommunityPreset）。职责过多导致单文件难以导航与评审，任何改动都需要在大文件内定位。
- **证据**：`export function listBoards(...); export async function createPost(...); export async function togglePostLike(...); export function listNotifications(...); export async function createSanction(...);`
- **建议**：按域拆分：community-config.ts、community-boards.ts、community-posts.ts（含评论）、community-social.ts（点赞/收藏/关注）、community-notifications.ts、community-moderation.ts（举报/审核/处罚）。保留薄转发层以维持现有导入兼容。
- **验证**：确认。community.ts 实读 1583 行，grep `^export (async )?function` 命中 44 个导出函数，横跨配置/板块/帖子评论/社交/通知/审核处罚 6 个业务域，单文件职责严重超载属实。

### NOJ-084 仪表盘 7 次串行 COUNT(*) 全表扫描且无缓存
- **位置**：`noj-core/src/services/dashboard.ts:52-131`　**维度**：性能
- **描述**：getDashboardStats 依次串行执行 7 个查询：users、problems、categories 全表 count(*)，submissions LEFT JOIN evaluation_results 的全表 count(*)（含 filter），submissions status='pending'、created_at>=24h、count(distinct user_id) 三次额外扫描。admin 仪表盘每次加载都重复这些全表统计，无任何缓存；submissions 的 join 全表计数随数据量增长最贵。
- **证据**：`db.select({count: sql`count(*)`}).from(users)...; .from(problems)...; .from(categories)...; .from(submissions).leftJoin(evaluationResults,...)...`
- **建议**：复用 stats-cache 的内存计数或引入 Redis 缓存/TTL；至少将 7 个查询用 Promise.all 并行；submissions 全表 count 可用物化统计或近似计数替代。
- **验证**：queryDashboardStats 串行 await 执行 7 个 count 查询：users、problems、categories、submissions LEFT JOIN evaluation_results 全表 count、pending、24h、distinct user_id（dashboard.ts:52-119），无缓存无并行。admin 仪表盘每次加载重复全表统计，属真实性能问题，维持『中』。

### NOJ-081 导航栏未读数 N+1：串行遍历全部会话逐条查未读（每条 1-3 查询）
- **位置**：`noj-core/src/services/messages.ts:444-462`　**维度**：性能
- **描述**：getUnreadCount 先取出用户参与的全部会话，再 for...of 串行 await getUnreadCountByConversation；后者内部每条又执行 readState 查询、lastReadMsg 查询、count 查询（最多 3 次 DB 往返）。该接口服务于导航栏未读徽标（conversations.ts:73），每个页面加载都会命中，会话数 N 时产生 3N 级串行查询，随会话数线性劣化且无批量/无 Promise.all。listConversations 的 unreadCounts 虽用了 Promise.all（279-281 行）但仍是 N 条独立 COUNT，同类问题。
- **证据**：`for (const conv of convRows) { total += await getUnreadCountByConversation(userId, conv.id); }`
- **建议**：改为单条 SQL 批量聚合：对 conversations 集合一次 LEFT JOIN messages/message_deletions/conversation_reads 按 conversation_id GROUP BY 取 COUNT；或维护一个 last_read_at 时间戳字段，用 created_at > last_read_at 单条 count。彻底消除逐条查询。
- **验证**：属实：getUnreadCount（messages.ts:459-461）for...of 串行 await getUnreadCountByConversation，后者每条最多 3 次 DB 往返（readState/lastReadMsg/count），接口被导航栏 unread-count（conversations.ts:71-74）每页调用。listConversations 虽用 Promise.all 仍是 N 条独立 COUNT。属真实 N+1，但 N 为单用户会话数（通常很小），且各查询走主键/复合索引，非全表热点，由「高」下调「中」。

### NOJ-082 会话列表拉取每个会话的全部消息再 JS 去重取最后一条
- **位置**：`noj-core/src/services/messages.ts:252-276`　**维度**：性能
- **描述**：listConversations 为预览最后一条消息，先 inArray 取出这些会话的所有消息并按 created_at DESC 排序，然后在 JS 里用 seen Set 去重。会话数多、历史消息多时会把 N 个会话的整段历史全部拉回内存（大结果集），只为取每条会话的最后一条预览。
- **证据**：`.where(or(...convIds.map((id) => eq(messages.conversation_id, id)))).orderBy(desc(messages.created_at)); // 随后 JS 去重`
- **建议**：改用 DISTINCT ON (conversation_id) ... ORDER BY conversation_id, created_at DESC 或 LATERAL 子查询，只取每会话最新一条；并加上 idx_messages_conversation_created 已存在可利用。
- **验证**：messages.ts:252-263 对全部会话 id 用 or(...) 拉取所有消息并按 created_at DESC 排序，随后 JS Set 去重取最后一条，确属大结果集内存去重，会话/历史消息量大时存在真实性能问题，维持中。

### NOJ-008 角色降级后 JWT 的 role claim 仍被客观题权限判定信任（短路过 RBAC）
- **位置**：`noj-core/src/services/objective-questions.ts:62-93`　**维度**：安全
- **描述**：isPaperOwnerOrAdmin 对 P 型套卷在调用 assertPermission（实时 RBAC DB 查询）之前先执行 `if (userRole === 'admin') return true`（line 70/83），而 userRole 来自 c.get('userRole') = JWT 中的静态 role claim（routes/problems.ts:416）。被降级的前管理员持有的旧 token 仍带 role=admin（最长 24h），且 updateRole/admin-roles.ts 不吊销 jti，可继续查看客观题答案/解析或管理套卷，绕过实时权限校验。
- **证据**：`if (paper.type === "P") { if (userRole === "admin") return true; if (c) { try { await assertPermission(c, "problem:write_any"); return true; } catch { return false; } } return false; }`
- **建议**：删除对静态 role claim 的短路判断，统一走 assertPermission 实时查询；角色变更时吊销受影响用户的 jti。
- **验证**：真阳性。create_container_with_security（dual/container.rs:183-196）create 成功后 start_container 失败经 ? 返回 Err，result.id 未交给任何 Drop guard（create_evaluator/create_solution 在得到 Err 前 DualContainer 尚未持有该 ID），且 src 内无 label 孤儿清扫（grep 无 list_containers）。Docker 负载下 start 失败即泄漏容器。维持中。

### NOJ-102 题目 RBAC 细粒度权限（problem:create/write_own/delete_own/package_manage_own）已 seed 但从未强制执行
- **位置**：`noj-core/src/services/problems-crud.ts:127-148, 240-255, 391-406`　**维度**：安全
- **描述**：seed-rbac.ts 为默认 user 角色授予了 problem:create、problem:write_own、problem:delete_own、problem:package_manage_own 四项权限，语义上管理员可通过从角色移除它们来收紧能力。但 CRUD 服务仅在 P 型题目（create_p/write_any/delete_any）或指定 number（write_any）时调用 assertPermission，U 型题目的创建、owner 自改、owner 自删、owner 自管支持包均无条件放行，从不检查上述 permission。管理员移除这些权限后，普通用户仍可正常创建 U 型题、编辑/删除自己的题、管理自己的支持包，权限模型形同虚设。
- **证据**：`// createProblem：仅 P 型/指定 number 检查权限，U 型创建无任何 assertPermission
if (type === "P") { await assertPermission(c, "problem:create_p"); }
// updateProblem（U 型 owner 路径）：直接跳过，无 write_own 断言
if (problem.owner_id !== (c?.var.userId ?? userId)) { await assertPermission(c, "problem:write_any"); }`
- **建议**：在 createProblem 的 U 型分支补 assertPermission(c,"problem:create")；在 updateProblem/deleteProblem 的 owner 分支补 assertPermission(c,"problem:write_own"/"problem:delete_own")；在 support-package.ts 的 owner 放行分支补 assertPermission(c,"problem:package_manage_own")。
- **验证**：属实：seed-rbac.ts USER_DEFAULT_PERMISSIONS 含 problem:create/write_own/delete_own/package_manage_own（28-33 行），但 problems-crud.ts 的 U 型创建（仅 type==='P' 才 assertPermission，127-134）、owner 自改（249 行非 owner 才 assert write_any）、owner 自删（400 行非 owner 才 assert delete_any）均不检查对应 own 权限；support-package.ts:156-159 同样 owner 路径无 package_manage_own。管理员从角色移除这些权限后普通用户仍可正常 CRUD 自己的 U 型题，权限形同虚设。维持「中」。

### NOJ-103 GET /api/v1/problems 可通过 ?type=U / ?owner_id= 匿名批量枚举他人 U 型题
- **位置**：`noj-core/src/services/problems-list.ts:141-150`　**维度**：安全
- **描述**：公开（无鉴权）的题目列表接口将 query.type 直接拼入 SQL 过滤条件，未做权限/归属约束。攻击者请求 ?type=U 即可一次性枚举全站所有用户的 U 型（私有练习）题，或 ?type=U&owner_id=<他人UUID> 精确拉取某个用户创建的题目；每条响应还附带该题的 description、runtime_config、support_package_storage_url 与 owner_id。这与代码注释『U 型仅通过 URL 或用户主页访问』的设计意图相悖，属于通过可篡改查询参数横向越权读取他人数据。
- **证据**：`// 未指定 type 时默认 P，但显式传入 type=U 即返回全部 U 型题，且无 owner 过滤
conditions.push(eq(problems.type, (query.type \|\| "P").toUpperCase()));
if (query.owner_id) conditions.push(eq(problems.owner_id, query.owner_id));`
- **建议**：对 U 型列表强制归属/权限约束：非 admin 传入 type=U 或 owner_id 时仅返回 owner_id=当前用户（需鉴权上下文）的结果，或直接拒绝（400/403）；并将 listProblems 接入 optionalAuthMiddleware 以区分匿名/登录/admin。
- **验证**：routes/problems.ts GET "/" 无任何鉴权中间件，query.type 直接透传 listProblems；problems-list.ts:142 显式传入 type=U 即绕过默认 P 过滤，且 148-149 支持 owner_id 精确过滤，返回 toProblemResponse 含 description/runtime_config/support_package_storage_url/owner_id，匿名可批量枚举他人 U 型题，横向越权读取真实存在，维持中。

### NOJ-033 degraded 模式下 /api/v1/queue 未优雅降级，Redis 不可用时返回 500
- **位置**：`noj-core/src/services/queue.ts:68-73`　**维度**：可靠性
- **描述**：getPendingSubmissionIds() 在 Redis 状态非 ready 时调用 `redis.connect()`。当 Redis 从启动起就不可用（degraded 模式）或运行中断连时，共享连接处于 connecting/reconnecting/end 态，connect() 会抛出（ioredis _connect 对 connecting/connect/ready 直接 reject "already connecting/connected"，连接失败时 reject "Connection is closed"）。该异常未被捕获，沿 getQueueOverview()（99 行调用处无 try/catch）抛到 Hono onError，返回 500 INTERNAL_ERROR。而 getSubmissionQueueStatus()（296-308 行）对同一调用做了 try/catch 静默降级（queue_position/queue_length 置 null），两者行为不一致。
- **证据**：`const redis = getRedis();
if (redis.status !== "ready") {
  await redis.connect();  // 可能抛错，无 try/catch
}
const raw = await redis.lrange(JUDGE_QUEUE, 0, -1);`
- **建议**：在 getQueueOverview 中对 getPendingSubmissionIds() 加 try/catch：Redis 不可用时 pending 返回空列表、stats.pending_count 记为 0 并记录日志，与 getSubmissionQueueStatus 的降级策略保持一致，使队列概览页在 degraded 模式下仍返回 200 而非 500。
- **验证**：getPendingSubmissionIds 在 status!=ready 时直接 await redis.connect()（queue.ts:68-73）无 try/catch；getQueueOverview 调用处（:99）亦未捕获，异常沿 Hono onError 返 500；而 getSubmissionQueueStatus 对同一调用做了 try/catch 静默降级（:296-308）。两者行为不一致，degraded 模式下队列概览页 500 真实存在。维持中。

### NOJ-077 队列无 TTL/长度上限且监控端点全量 LRANGE，队列无限增长、监控 O(N) 且登录用户即可访问
- **位置**：`noj-core/src/services/queue.ts:68-88`　**维度**：可靠性
- **描述**：noj:judge:queue 与 noj:judge:results 均为普通 List，LPUSH（producer.ts:47）无 TTL、无 LTRIM 长度上限；judge 下线时队列可无限增长直至 Redis 内存耗尽。此外队列监控并非 LLEN 常量检查：getPendingSubmissionIds 每次执行 lrange(JUDGE_QUEUE, 0, -1)（第73行）把整条队列（含每条任务的完整 JSON，含用户代码与 base64 支持包 URL）一次性加载进内存；该函数被 GET /api/v1/queue（routes/queue.ts:17，仅 authMiddleware，任意登录用户可访问）以及提交列表/详情在每次有未完成提交时反复调用，队列大时既是性能热点也是内存放大点。pending 列表还向所有登录用户暴露他人 username（submitted_by，第111行）。
- **证据**：`const raw = await redis.lrange(JUDGE_QUEUE, 0, -1); // 全量拉取
router.get("/", authMiddleware, async (c) => { const overview = await getQueueOverview(); return c.json(overview); });`
- **建议**：为队列增加 TTL 或长度上限（如 LTRIM 保留上限 + 超时告警）；监控改用 LLEN 获取长度、LRANGE 仅取分页片段；按需收紧 /queue 概览的权限或对 username 做脱敏。
- **验证**：属实：producer LPUSH 无 TTL/LTRIM，queue.ts:73 `lrange(JUDGE_QUEUE,0,-1)` 全量拉取（含代码与 base64 URL），getPendingSubmissionIds 被 /api/v1/queue（routes/queue.ts 仅 authMiddleware，任意登录用户）及提交状态反复调用；pending 项向登录用户暴露他人 username（submitted_by）。队列无上限+全量 LRANGE 为真实可靠性与内存放大点，维持「中」。

### NOJ-083 社区搜索在 WHERE 内现算 tsvector + 多处 ILIKE，无索引全表扫描
- **位置**：`noj-core/src/services/search.ts:209-240`　**维度**：性能
- **描述**：searchCommunity 在 WHERE 子句里每次现算 to_tsvector('simple', title || ' ' || content)，并对 p.title/p.content/p.problem_id/problem.type||number/problem.title 做多路 ILIKE '%q%'。community_posts 表（schema.ts 与 0029 迁移）没有任何 search_vector GENERATED 列，也没有 title/content 的 pg_trgm GIN 索引，导致每次社区搜索都对该表全表扫描且逐行计算 tsvector。COUNT 查询同样全表扫描。
- **证据**：`to_tsvector('simple', coalesce(p.title, '') \|\| ' ' \|\| p.content) @@ websearch_to_tsquery(...) OR p.title ILIKE '%q%' OR p.content ILIKE '%q%' ...`
- **建议**：参照 problems/users（0017 迁移）为 community_posts 增加 search_vector GENERATED 列 + GIN 索引，并为 title/content 增加 pg_trgm GIN 索引；把现算 tsvector 改为引用存储列。
- **验证**：确认 search.ts L212/224/239 在 WHERE 内每次现算 to_tsvector 并对 title/content/problem_id/type||number 做 ILIKE '%q%'；schema.ts 中 community_posts 无 search_vector GENERATED 列与 pg_trgm 索引（仅 users/problems 有，L62/106）。导致全表扫描+逐行现算，性能问题成立，维持中。

### NOJ-062 evaluator.command/network 敏感字段默认授权普通用户，JudgeTask.runtime_config 可被普通用户注入命令
- **位置**：`noj-core/src/services/seed-rbac.ts:55-61`　**维度**：安全
- **描述**：SENSITIVE_FIELD_DEFAULT_PERMISSIONS 将 problem:field_evaluator_command 与 problem:field_evaluator_network 两个敏感字段权限在启动期一次性默认授予 user 角色（ensureSensitiveFieldDefaultPermissions 243-313 行），即默认放行、需管理员手动从角色移除才收紧。因此任何普通用户创建 U 型题时即可在 runtime_config 中设置任意 evaluator.command 字符串并开启 evaluator.network.enabled=true（problem-field-guard.ts 仅做显式字段检查，权限默认命中）。该 runtime_config 原样进入 JudgeTask（submissions-crud.ts:352-360 的 task.runtime_config），由 noj-judge 在 Evaluator 容器内执行、且网络开启。代码自身注释已承认"联网 + 可控 evaluator.command = 联网容器任意命令执行"（problem-bundle.ts:319-322、problems-crud.ts:105-108），与 types/problems.ts:47/69 声明的"仅 admin 可设置"相矛盾。镜像受白名单约束、容器有 cap_drop 等沙箱，故非宿主机命令执行，但构成普通用户在网络隔离的评测环境中执行任意命令并建立出网通道（SSRF/数据外带）。
- **证据**：`const SENSITIVE_FIELD_DEFAULT_PERMISSIONS = [
  { resource: "problem", action: "field_evaluator_command" },
  { resource: "problem", action: "field_evaluator_network" },
];`
- **建议**：敏感字段权限不应默认授予 user 角色：默认只授 admin（或明确的最小出题人角色），普通用户需管理员显式授权才可设置 evaluator.command/network；并将该默认授权策略与 types/problems.ts 中"仅 admin 可设置"的注释对齐，补充回归测试。
- **验证**：事实链全部核实：seed-rbac.ts:55-61/243-313 将 field_evaluator_command/network 一次性默认授予 user 角色；problem-field-guard.ts:35-38 映射→checkPermission 默认放行；problems-crud.ts:109/285 调用该守卫；submissions-crud.ts:352-360 将 runtime_config 原样进 JudgeTask；noj-judge dual/container.rs:171 按 network.enabled 切 bridge 模式。但联网能力是显式规格设计（openspec/specs/network-capability/spec.md:67『不要求 admin 角色』、:73-74），默认授权是 issue #207 的一次性设计（seed-rbac.ts:49-54 注释）。故非误报但『与仅 admin 可设置相矛盾』的根因是 types/problems.ts:47/69 注释陈旧，实际为已声明的设计取舍，残余风险(SSRF/数据外带)受镜像白名单+cap_drop 沙箱约束，故下调至高→中。

### NOJ-065 rejudge_seq 校验在事务外（TOCTOU）+ 结果写回绕过状态机
- **位置**：`noj-core/src/services/submissions-result.ts:41-110`　**维度**：正确性
- **描述**：saveEvaluationResult 先在事务外读取 sub.rejudge_seq（42-52）并比较 incomingSeq < sub.rejudge_seq（61），随后才进入 db.transaction（72）写 status 与 evaluation_results。读-比较与写之间没有行级锁或条件更新，存在 TOCTOU 竞态：若并发 rejudge 在读取之后提交（rejudge_seq 已 +1、已删除 evaluation_results、status 已重置为 pending），这个旧结果仍会以 status=finished + 旧 evaluation_results 写回，覆盖新状态。此外，事务内（77-83）直接 update status 为 finished/error，完全没有使用 VALID_TRANSITIONS（23-28）校验当前状态，结果可为任意状态的提交直接置为终态。重测的『旧结果覆盖新结果』防护因此失效。
- **证据**：`const incomingSeq = result.rejudge_seq ?? 0;
const [sub] = await db.select({ rejudge_seq ... }).from(submissions).where(...); // 事务外读
if (incomingSeq < sub.rejudge_seq) { ... return; } // 事务外比较
await db.transaction(async (tx) => { await tx.update(submissions).set({ status: submissionStatus, judge_finished_at: now }) ... })`
- **建议**：把 rejudge_seq 校验移入事务并对该 submission 行加锁（SELECT ... FOR UPDATE），或改为条件更新：UPDATE submissions SET status=... WHERE id=? AND rejudge_seq<=incomingSeq，并在受影响行数=0 时放弃写回。同时用 VALID_TRANSITIONS 校验当前状态，仅允许 judging（或 pending，兼容崩溃窗口）→ finished/error。
- **验证**：两个子论断均属实：rejudge_seq 读取(42-52)与比较(61)在事务外，写回(72-110)在事务内且未复验，无行级锁/条件更新，确属 TOCTOU；saveEvaluationResult 直接 set status(77-83) 完全未用 VALID_TRANSITIONS(23-28)。但竞态窗口极窄（SELECT 到事务提交之间），正常重测结果到达后自愈，永久性影响需新结果永不到达（judge 崩溃）；状态机校验缺失属防御纵深而非独立攻击面，故下调为中。

### NOJ-068 重复结果与重测结果非幂等：applyNewResult 无条件自增导致统计 double-count
- **位置**：`noj-core/src/services/submissions-result.ts:112-115`　**维度**：正确性
- **描述**：注释声称『仅 net-new 结果，重测不计入避免 double-count』，但代码对每条被接受的结果无条件调用 applyNewResult（113-115），且 rejudge_seq 校验只拒绝 strictly-older（incomingSeq < sub.rejudge_seq），对 equal seq 的重复结果（judge 重试、或重测结果 seq 相等）一律接受并重放副作用。stats-cache.ts 的 applyNewResult（103-117）每次调用都 total++/todayTotal++ 并累加 full_score，既无去重键也无 rejudge_seq>0 判断。结果是：重测结果、judge 重试的重复结果都会重复计入全站/今日统计，且重复触发 refreshRankingsView 与 contest 事件。
- **证据**：`// 更新内存统计缓存（仅 net-new 结果，重测不计入避免 double-count）
if (sub.created_at) { applyNewResult(result.score, sub.created_at); }  // 无条件调用`
- **建议**：在 saveEvaluationResult 内识别是否为首次结果（如依据是否存在旧 evaluation_results 行、或 rejudge_seq>0）再决定是否调用 applyNewResult；或让 applyNewResult 接收 submission_id 做幂等去重（Set/Hash）。
- **验证**：submissions-result.ts:61 仅拒绝 incomingSeq < sub.rejudge_seq（严格更旧），重测结果 seq 相等会被接受；:112-115 无条件调用 applyNewResult，与注释「重测不计入避免 double-count」矛盾。rejudge 复用同一 submission_id 并 rejudge_seq+1（submissions-rejudge.ts:86-98），stats-cache.applyNewResult 无去重键、每次 total++/full_score 累加（stats-cache.ts:103-117），故重测/重复结果 double-count 真实。维持中。

### NOJ-085 每次评测结果写回都触发物化视图全量 REFRESH，无节流
- **位置**：`noj-core/src/services/submissions-result.ts:117-120`　**维度**：性能
- **描述**：saveEvaluationResult 每次成功写回后 fire-and-forget 调用 refreshRankingsView()，内部执行 REFRESH MATERIALIZED VIEW CONCURRENTLY user_rankings（rankings.ts:78-89），对整个 users×submissions×evaluation_results 聚合全量重算。虽然不 await 不阻塞热路径，但高提交吞吐下会频繁触发全量重算，CONCURRENTLY 刷新同一视图会串行排队并占用写锁/CPU，且无 debounce/coalescing。
- **证据**：`refreshRankingsView().catch(() => {});  // rankings.ts: REFRESH MATERIALIZED VIEW CONCURRENTLY user_rankings`
- **建议**：对刷新做节流/合并（如 1-5s 内多次结果只刷一次），或改为增量维护榜单；避免每笔提交结果都全量重算视图。
- **验证**：核实 submissions-result.ts:117-120 fire-and-forget `refreshRankingsView().catch()`；rankings.ts:78-89 每次执行全量 `REFRESH MATERIALIZED VIEW CONCURRENTLY`。无节流/合并属实，高吞吐下频繁全量重算 + CONCURRENTLY 串行排队。真实可扩展性隐患，维持中。

## 低

### NOJ-059 .env.example 缺失多个代码实际读取的环境变量
- **位置**：`noj-core/.env.example:13`　**维度**：环境变量文档
- **描述**：代码读取但 .env.example 完全未文档化的变量包括：CORS_ALLOWED_ORIGINS（app.ts:80）、NOJ_ENV（app.ts:83 等 5 处）、DATABASE_POOL_MAX / DATABASE_CONNECT_TIMEOUT / DATABASE_IDLE_TIMEOUT / DATABASE_MAX_LIFETIME（db/connection.ts:64-74）、BCRYPT_SALT_ROUNDS（lib/password.ts:10）、SUPPORT_PACKAGE_DIR（lib/storage/local.ts:69）、NOJ_BYPASS_JWT_REVOKE（lib/revokedTokens.ts:61）、RATE_LIMIT_SEARCH_ENABLED / WINDOW / MAX_ANON / MAX_AUTHED（settings-registry.ts:277-313，settings-registry 已注册 envFallback）。其中 NOJ_BYPASS_JWT_REVOKE=1 会跳过 JWT 撤销校验，属安全相关开关，更应显式说明。.env.example 中所有已列变量（含注释项）均在 settings-registry 注册、无失效项。
- **证据**：`Deno.env.get("CORS_ALLOWED_ORIGINS")、Deno.env.get("DATABASE_POOL_MAX")、Deno.env.get("NOJ_BYPASS_JWT_REVOKE") 等均无对应 .env.example 条目`
- **建议**：将这些变量（含默认值与说明）补齐到 .env.example，尤其标注 NOJ_BYPASS_JWT_REVOKE 仅供测试、生产禁止设置。
- **验证**：.env.example 通读确认无 CORS_ALLOWED_ORIGINS、NOJ_ENV、DATABASE_POOL_MAX/…、BCRYPT_SALT_ROUNDS、SUPPORT_PACKAGE_DIR、NOJ_BYPASS_JWT_REVOKE、RATE_LIMIT_SEARCH_* 等条目（这些虽在 CLAUDE.md 环境变量表有，但 .env.example 缺）。属实，保留低。

### NOJ-060 .env.example 内嵌已知开发凭据，check-env 占位符黑名单无法拦截
- **位置**：`noj-core/.env.example:31`　**维度**：密钥卫生
- **描述**：提交的模板含真实已知开发凭据：ADMIN_PASS=AdminPass123!（第 31 行）、S3_ACCESS_KEY/S3_SECRET_KEY=minioadmin（第 78-79 行，MinIO 默认凭据）、DATABASE_URL 内嵌 noj:noj（第 13 行）。scripts/check-env.ts 的 PLACEHOLDER_PATTERNS（第 30-40 行）仅拦截 change-this/changeme/example/test/xxx/placeholder 等，无法命中 `AdminPass123!` 或 `minioadmin`，故 `cp .env.example .env` 后直接运行可'通过'检查却携带已知凭据。src/ 内未发现硬编码生产凭据（命中均为字段名、注释或配置键名）。
- **证据**：`ADMIN_PASS=AdminPass123! / S3_ACCESS_KEY=minioadmin / S3_SECRET_KEY=minioadmin`
- **建议**：将模板中的敏感默认值改为占位符（如 change-this-...），并把 minioadmin、AdminPass123! 等已知默认值加入 check-env 黑名单。
- **验证**：确认。.env.example:13 DATABASE_URL 内嵌 noj:noj、:31 ADMIN_PASS=AdminPass123!、:78-79 S3 minioadmin；check-env.ts:30-40 黑名单(change-this/changeme/example/test/xxx/placeholder/your-*/replace-me/TODO)均不命中这些已知默认值，cp 后 check:env 放行。属开发默认凭据、头部已声明仅本地开发，故维持低。

### NOJ-202 .env.example 对象存储密钥为 MinIO 公开默认值
- **位置**：`noj-core/.env.example:78`　**维度**：密钥卫生
- **描述**：S3_ACCESS_KEY/S3_SECRET_KEY 均为 MinIO 众所周知的默认凭据 minioadmin（78-79 行），与 docker-compose.yml 的 MINIO_ROOT_USER/PASSWORD 一致。属开发默认值，但作为生产 s3 模式的示例值存在被直接沿用的风险。
- **证据**：`S3_ACCESS_KEY=minioadmin / S3_SECRET_KEY=minioadmin`
- **建议**：模板改为空值或占位符（S3_ACCESS_KEY= / S3_SECRET_KEY=），并注明生产必须使用独立随机密钥。
- **验证**：.env.example:78-79 为 `S3_ACCESS_KEY=minioadmin`/`S3_SECRET_KEY=minioadmin`，与 docker-compose.yml MinIO 默认凭据一致，属公开默认值，作为示例存在被生产直接沿用风险，维持『低』。

### NOJ-144 noj-core/CLAUDE.md 数据库连接文件名错误
- **位置**：`noj-core/CLAUDE.md:110`　**维度**：文档准确性
- **描述**：目录结构写 db/index.ts 为「数据库连接管理（单例模式）」，但实际文件为 src/db/connection.ts，不存在 index.ts；根 AGENTS.md 则正确写为 connection.ts，两处相互矛盾。
- **证据**：`noj-core/CLAUDE.md:110「├── index.ts # 数据库连接管理」；实际 noj-core/src/db/ 含 connection.ts/migrate.ts/schema-ddl.ts/schema.ts，无 index.ts；根 AGENTS.md:170 写 db/connection.ts。`
- **建议**：改为 db/connection.ts。
- **验证**：noj-core/CLAUDE.md 目录结构写『index.ts # 数据库连接管理』；glob noj-core/src/db/*.ts 实为 connection.ts/migrate.ts/schema-ddl.ts/schema.ts，无 index.ts，根 AGENTS.md 正确写 connection.ts。属实但属单行文件名笔误，下调为低。

### NOJ-056 多处 npm 依赖使用宽泛 ^ 版本范围
- **位置**：`noj-core/deno.json:31`　**维度**：依赖卫生
- **描述**：hono `^4`、jose `^5`、bcryptjs `^2.4.3`、@aws-sdk/client-s3 `^3`、@aws-sdk/s3-request-presigner `^3`、@alicloud/dm20151123 `^1.10.2`、@electric-sql/pglite `^0.5.3`、@std/encoding `^1`、@cliffy/command `^1.2.1` 均为宽泛 caret 范围。当前由提交的 deno.lock 兜底保证可复现，但一旦 lock 被重建（如 CI 首次 `deno install` 不带 lock），会静默升级到范围内最新版，构成供应链漂移面。
- **证据**：`"hono": "npm:hono@^4"、"jose": "npm:jose@^5"、"@aws-sdk/client-s3": "npm:@aws-sdk/client-s3@^3"`
- **建议**：关键运行时依赖改用精确版本（或保留 ^ 但确保 lock 始终随 PR 提交并强制 `--frozen` 校验），并加入 Dependabot/deno audit 定期更新。
- **验证**：核实 deno.json:30-45 hono/jose/bcryptjs/aws-sdk/cliffy 等均为宽泛 ^ 范围；deno.lock 已提交兜底可复现，且发现自述此缓解。维持低。

### NOJ-055 deno.lock 残留过时 drizzle-orm@0.35.2 条目（漂移迹象）
- **位置**：`noj-core/deno.lock:31`　**维度**：依赖卫生
- **描述**：lock 的 specifiers 同时存在 `npm:drizzle-orm@0.35.2`（第 31 行）与 `npm:drizzle-orm@*`→0.45.2（第 30 行）、`npm:postgres@*` 与 `npm:postgres@3.4.5` 并存。0.35.2 是历史降级/升级遗留的孤儿条目，deno.json 仅声明 0.45.2。说明 lock 未经清理，存在版本漂移历史。
- **证据**：`"npm:drizzle-orm@0.35.2": "0.35.2_@electric-sql+pglite@0.5.3_@types+pg@8.20.0_postgres@3.4.5"`
- **建议**：在统一版本后运行一次 `deno cache`（或等价锁重建）清理孤儿 specifier，确保 imports 与 lock 一一对应。
- **验证**：deno.lock:30-32 同时存在 `npm:drizzle-orm@*`→0.45.2、`npm:drizzle-orm@0.35.2`、`npm:drizzle-orm@0.45.2`，0.35.2 为历史遗留孤儿条目，属 lock 未清理的版本漂移迹象，维持『低』。

### NOJ-058 deno.lock remote 段残留 deno.land/x 第三方源（非官方可变源）
- **位置**：`noj-core/deno.lock:1439`　**维度**：依赖卫生
- **描述**：lock 的 remote 段仍引用 `https://deno.land/std@0.132.0/...`（2022 年旧版 std）与 `https://deno.land/x/postgresjs@v3.4.5/...`（第 1706 行）。deno.land/x 是社区第三方注册表，缺乏 jsr/npm 的内容寻址完整性保证（remote 段仅记录哈希而非 integrity），且当前 deno.json 已全部改用 jsr:/npm:、源码无任何 deno.land 导入，这些条目属过期残留。
- **证据**：`"https://deno.land/std@0.132.0/_deno_unstable.ts": "23a1a369..."`
- **建议**：重建 lock 清除 remote 残留；若确需引用，应迁移到 jsr: 或 npm: 等价源。
- **验证**：确认 deno.lock:1439 起存在大量 https://deno.land/std@0.132.0/... 条目（含 2022 旧 std），源码已全用 jsr:/npm:（如 storage 用 jsr:@std/path、npm:@aws-sdk），属过期残留。维持低。

### NOJ-042 未匹配路由 404 未走统一错误结构（缺 code/request_id）
- **位置**：`noj-core/src/app.ts:136-177`　**维度**：正确性
- **描述**：createApp 注册了 onError 但未设置 app.notFound。Hono 默认 notFound 返回纯文本 "404 Not Found"（Content-Type: text/plain），与统一错误响应 {error, code, request_id} 不一致，前端按 JSON 解析会失败。所有 AppError 路径都有 code/request_id，唯独 404 未匹配路由没有。
- **证据**：`app.onError((err, c) => {...}); app.use("/api/v1/*", banlistMiddleware); ... app.route("/api/v1", sse); // 无 app.notFound 注册`
- **建议**：注册 app.notFound((c) => c.json({ error: "接口不存在", code: "NOT_FOUND", request_id: c.get("requestId") ?? crypto.randomUUID() }, 404))，与 onError 结构对齐。
- **验证**：createApp 注册了 onError 但确实未注册 app.notFound（app.ts:134-177），Hono 默认 notFound 返回 text/plain '404 Not Found'，与统一 {error,code,request_id} 结构不一致。事实准确，但仅影响未匹配路由的错误结构一致性，无安全/功能后果，由『中』下调『低』。

### NOJ-028 db/connection.ts 测试种子逻辑三处复制粘贴
- **位置**：`noj-core/src/db/connection.ts:179-213,232-266,296-325`　**维度**：代码质量
- **描述**：root 用户 + 3 条 judge_images + ensureRbacSeeds 的种子代码在 ensurePGliteSchemaForTest 与 resetDbForTest（PGlite 分支与非 PGlite 分支）三处几乎完全重复（共约 90 行）。新增种子项时需三处同步修改，极易漏改导致测试隔离不一致。
- **证据**：`INSERT INTO users (id, username, ...) VALUES ('0', 'root', 'root@noj.local', ...) ON CONFLICT (id) DO NOTHING  // 三处重复`
- **建议**：抽取 seedBaseData(db) 私有函数统一执行 root 用户 + judge_images + RBAC 种子，三处调用同一函数。
- **验证**：确认。connection.ts:178-213(ensurePGliteSchemaForTest)、232-266(resetDbForTest PGlite 分支)、296-325(非 PGlite 分支) 三处 root 用户+3 条 judge_images+ensureRbacSeeds 种子代码几乎逐字重复，新增种子需三处同步，属实。

### NOJ-109 users.role 列已被删除，database-schema/rbac-core 规范仍要求保留
- **位置**：`noj-core/src/db/schema.ts:37-63`　**维度**：规范符合性
- **描述**：database-schema 规范（spec.md L16 `role TEXT NOT NULL DEFAULT 'user'`、L452-460「users.role 列 SHALL 保留不变」）与 rbac-core 规范（L162-170「系统 SHALL 保留 users.role 列」）均要求保留该列。实现中的 users 表定义（id/username/email/password_hash/bio/must_change_password/community_activity_visibility/avatar_url/created_at/updated_at/search_vector）已不含 role 列；seed-rbac.ts L200 与 connection.ts L297 注释明确「users.role 列已废弃删除」。
- **证据**：`规范：database-schema/spec.md L16 与 L452-460；实现：schema.ts users 表 L40-62 无 role 字段，seed-rbac.ts L200「users.role 列已废弃删除」。`
- **建议**：将 database-schema 与 rbac-core 的 users.role 相关 Requirement 同步为「已移除，角色经 user_roles+roles 判定」，消除规范与实现的字段不一致。
- **验证**：确认 schema.ts L36-63 users 表无 role 列，而 database-schema/spec.md L16/L452-460 与 rbac-core/spec.md L162-170 仍要求保留 users.role 列。规范与实现漂移属实，但无运行时影响，属文档/规范层问题，由中下调为低。

### NOJ-112 audit_logs.action CHECK 约束与 admin_id 非空约束已偏离 audit-log 规范
- **位置**：`noj-core/src/db/schema.ts:741-778`　**维度**：规范符合性
- **描述**：audit-log 规范（L21-28）要求 action CHECK 限定为 7 个值，且 admin_id 为 NOT NULL（L12）。实现中 action CHECK 已扩展至 25 个值（新增 problems.runtime_config_changed/imported、ip_ban.*、auth.*、community.*、announcement.*），且 admin_id 取消 NOT NULL（schema.ts L741 无 .notNull()，PR-2 使 auth.* 事件 actor 可空）。属增量扩展与规范未同步。
- **证据**：`规范：audit-log/spec.md L12（admin_id NOT NULL）、L21-28（7 值 CHECK）；实现：schema.ts L741（admin_id 可空）、L750-778（25 值 CHECK），types/audit-log.ts L9-34（AuditAction 25 项）。`
- **建议**：同步 audit-log 规范中的 action 枚举与 admin_id 可空性（区分「管理员操作」与「认证事件」两类 admin_id 语义）。
- **验证**：spec.md:13 admin_id NOT NULL、21-28 限 7 值；schema.ts:741 admin_id 未 .notNull()（注释明言 PR-2 使 auth.* actor 可空），750-778 CHECK 含 25 值。增量扩展与规范未同步属实，保留低。

### NOJ-038 parseJsonBody 对 null 请求体无防护，下游属性访问抛 500
- **位置**：`noj-core/src/lib/request.ts:11-18`　**维度**：正确性
- **描述**：parseJsonBody<T> 仅捕获 c.req.json() 抛出的 JSON 语法错误（空 body 会抛 SyntaxError→400），但请求体为字面量 null 时 JSON.parse 返回 null 而不抛错，函数把 null 以 T 类型返回。随后各路由（如 auth/register、auth/login 的 `if (!body.username)`）对 null 做属性访问会抛 TypeError，被 app.ts onError 兜成 500，而非预期的 400 VALIDATION_ERROR。数组/对象空值尚能走 `!body.x` 分支，唯 null/undefined 会崩溃。
- **证据**：`export async function parseJsonBody<T>(c) { try { return await c.req.json<T>(); } catch { throw new ValidationError("请求体格式错误"); } }`
- **建议**：在 parseJsonBody 内对解析结果做类型守卫：`const v = await c.req.json<T>(); if (v === null || typeof v !== 'object') throw new ValidationError('请求体必须是 JSON 对象'); return v;`，或要求各路由统一先判 `!body`。
- **验证**：事实成立：request.ts:11-18 只 catch 抛错，JSON.parse("null") 返回 null 不抛；auth.ts register(76)/login(152) 对 null 做 body.username/body.login 属性访问抛 TypeError，app.ts onError(125-133) 兜成 500 而非 400。但影响仅为畸形请求返回错误状态码(健壮性问题)，无安全后果、无数据泄露，故由中下调为低。

### NOJ-037 枚举型 string 设置项无取值白名单校验，非法值可写入
- **位置**：`noj-core/src/lib/settings-registry.ts:98-105`　**维度**：可靠性
- **描述**：validateValueType 对 string 类型仅做 typeof 检查，额外校验只覆盖 smtp_from 的 email 格式（system-settings.ts:160-165）。email_provider（mock/aliyun/tencent）、storage_provider（local/s3）等枚举语义的 string 项没有取值白名单：管理员可写入任意字符串，写入即落库并在下次读时生效（如 email_provider 被写成非法值，checkEmailProviderConfig 因不匹配 aliyun/tencent 分支而静默当作 mock，实际发送行为与配置意图不符）。needsRestart 项（storage_provider/s3_*）运行时修改也仅靠 UI 展示提示，无后端拦截或告警。
- **证据**：`case "string": {
  if (typeof value !== "string") {
    return { ok: false, message: `${key} 必须是 string` };
  }
  // 仅 smtp_from 有额外 email 格式校验
  ...
}`
- **建议**：在注册表为枚举型 string 项增加 allowed 取值集合，并在 validateValueType 中校验；对 needsRestart 项在 updateSetting 成功时返回明确「需重启生效」的告警字段，避免配置与行为静默偏离。
- **验证**：核实成立。system-settings.ts validateValueType(155-166)对 string 仅 typeof 检查，额外校验只覆盖 smtp_from email；settings-registry.ts 的 email_provider(98-105)/storage_provider(330-338) 等枚举项无 allowed 白名单，管理员可写入任意字符串并被落库生效(非法 email_provider 被 checkEmailProviderConfig 当 mock 静默)。仅管理员可写、后果为配置与行为静默偏离，维持低。注：finding 标注 file 为 settings-registry.ts，实际校验函数位于 system-settings.ts，文件引用略偏但实质成立。

### NOJ-117 SHA-256 校验链可被绕过/省略：checksum 取自用户可控 URL 且 S3 元数据未读回校验
- **位置**：`noj-core/src/lib/storage/local.ts:156-161`　**维度**：安全
- **描述**：local.ts downloadUrl 与 s3.ts downloadUrl（153-166）在构造 noj-download:// URL 时直接复用 parseStorageUrl 得到的 checksumSha256（即 DB 存储 URL 的 ?checksum_sha256= 查询参数，随 support_package_storage_url 由用户控制），从不重算实际内容的 SHA-256。S3 put() 虽把真实哈希写入对象元数据 checksum-sha256（s3.ts:90-92），但 get/downloadUrl 从未读回或比对。judge 端 verify_checksum（download.rs:100-111）在 expected 为 None 或空串时直接跳过校验。因此攻击者只需在 support_package_storage_url 中省略 checksum_sha256 参数或填入任意值（匹配自己内容即可），即完全绕过文档宣称的『SHA-256 贯穿两个层级』完整性保护；内容寻址缓存（runner.rs:77-97）也失去可信锚点（虽无法跨题投毒，但完整性形同虚设）。
- **证据**：`async downloadUrl(storageUrl, _expiresIn) {
  const data = await this.get(storageUrl);
  const parsed = parseStorageUrl(storageUrl);
  return buildBase64DownloadUrl(this.uint8ArrayToBase64(data), parsed.checksumSha256);
}
// judge: fn verify_checksum { if let Some(expected)=expected { ... } Ok(()) } // None 直接放行`
- **建议**：下载交付层应重算真实内容哈希并与存储元数据比对：local 模式下 downloadUrl 用 sha256Hex(data) 作为 checksum；S3 模式下读回对象元数据 checksum-sha256 作为唯一可信值。judge 端 verify_checksum 在 expected 缺失时应视为校验失败而非跳过，或在 core 侧保证 checksum 恒存在。
- **验证**：确认。local.ts:156-161 与 s3.ts:153-166 downloadUrl 直接复用 parseStorageUrl 得到的 checksumSha256（随 support_package_storage_url 由用户可控，problems-crud.ts:169/302-303 直接接受该字段）而不重算；judge download.rs:100-111 verify_checksum 在 expected 为 None 或空串时直接跳过。完整性校验确可被省略/伪造，但无跨题投毒、存储后端受控，维持低。

### NOJ-098 用户封禁不撤销已签发 JWT，且仅拦截写方法，已登录会话不失效
- **位置**：`noj-core/src/middleware/auth.ts:96-112`　**维度**：安全
- **描述**：checkBanStatus 仅对 POST/PUT/PATCH/DELETE（非 logout 白名单）检查封禁，GET/HEAD/OPTIONS 一律放行；banUser 只写 user_bans 表，未 revokeJti 撤销已签发 JWT。被封用户现有 token 仍有效可继续读取自身数据。lib/revokedTokens.ts:13 注释声称 ban 已接入撤销，但实际未实现。
- **证据**：`async function checkBanStatus(c, userId) {
  if (c.req.method !== "GET" && ... && !BAN_WHITELIST.includes(c.req.path)) {
    const banState = await getUserBanState(userId);
    ...
  }
}`
- **建议**：banUser 时记录并撤销用户活跃会话（jti），或扩大封禁拦截范围；并修正 revokedTokens.ts 的误导性注释。
- **验证**：checkBanStatus 仅拦截非 GET/HEAD/OPTIONS 方法（auth.ts:96-112），被封用户现有 token 的 GET 仍放行；grep services 无 ban 路径调用 revokeJti，revokedTokens.ts:13 注释声称『ban 已接入撤销』实际未实现。事实成立，属已知设计取舍+误导注释，维持『低』。

### NOJ-035 消费者重连退避 retryCount 永不重置，长期运行后崩溃恢复永远等待 30s 上限
- **位置**：`noj-core/src/mq/base-consumer.ts:27-46`　**维度**：可靠性
- **描述**：指数退避实现本身正确：Math.min(1000 * 2^retryCount, 30000)，有 30s 封顶、无重连风暴。但 retryCount 在 startConsumerWithRetry 内声明后只增不减，消费者成功运行后再发生异常退出时不会从 1s 重新开始，而是直接使用已积累的大 retryCount，导致每次恢复都等待满 30s。属可用性退化而非正确性问题。
- **证据**：`const delay = Math.min(
  INITIAL_RETRY_DELAY_MS * Math.pow(2, retryCount),
  MAX_RETRY_DELAY_MS,
);
retryCount++;`
- **建议**：在消费者成功连接并稳定运行一段时间（或成功消费若干条消息）后重置 retryCount 为 0，使偶发崩溃后的恢复无需恒等 30s 上限。
- **验证**：base-consumer.ts:27 retryCount 声明后仅 :46 自增、永不重置；且 runConsumer 仅在初始 connect 失败时返回（:58-64），运行中断线靠内部 brpop 循环 catch 1s 重试。长期运行后恢复恒等 30s 上限属实，属可用性退化，维持低。

### NOJ-039 admin 创建/更新竞赛缺路由校验，title 缺失触发 TypeError→500
- **位置**：`noj-core/src/routes/admin.ts:307-320`　**维度**：正确性
- **描述**：POST /admin/contests 与 PUT /admin/contests/:id 直接 parseJsonBody<CreateContestInput> 后透传给服务层，路由层零校验。服务层 createContest 第一行 `if (!input.title.trim())`，当 title 缺失或为非字符串（数字/null）时 `.trim()` 抛 TypeError，被全局 onError 转 500；同理 start_time/end_time/problems 缺失也会在下游（validateTimes/normalizeProblems）出现类型错误。应返回 400 而非 500。
- **证据**：`router.post("/contests", async (c) => { const body = await parseJsonBody<CreateContestInput>(c); const data = await createContest(body, c.get("userId")); ... }); // services/contests.ts:221 `if (!input.title.trim())``
- **建议**：在路由层用 isValidContestType/必填字段检查（title/start_time/end_time/type/problems 存在且 title 为 string）再调用服务层；服务层改用 `typeof input.title !== 'string' || !input.title.trim()` 防御式写法。
- **验证**：属实：admin.ts:307-320 零校验透传，contests.ts:221 `input.title.trim()` 在 title 缺失/非字符串时抛 TypeError→全局 onError 转 500。但该端点在 requireAdmin 之后（仅管理员可触发），后果仅状态码 500 而非 400，无数据丢失或越权，属契约/健壮性问题，由「中」下调「低」。

### NOJ-040 公告分页用 meta 键、公告详情无 data 包裹，响应形状与其他资源不一致
- **位置**：`noj-core/src/routes/announcements.ts:31-79`　**维度**：正确性
- **描述**：listPublicAnnouncements 返回 {data, meta}（分页元数据键名为 meta），而全站其他分页端点统一用 {data, pagination}（PaginationMeta 字段 page/per_page/total/total_pages）。公告详情 getPublicAnnouncement 经 c.json(detail) 直接返回裸对象 {id,title,content,...}，无 data 包裹，与 problems/:id、submissions/:id、users/:id/profile 等 {data: {...}} 约定不一致。admin-announcements.ts 列表同样返回 {data, meta}，但同资源创建返回 {data: item}，同一资源内列表/创建结构也不统一。
- **证据**：`router.get("/", async (c) => { const result = await listPublicAnnouncements(page, perPage); return c.json(result); }); // 返回 {data, meta}
router.get("/:id", async (c) => { return c.json(detail); }); // 无 data 包裹`
- **建议**：将公告列表/详情统一为 {data, pagination} / {data: detail}，或在服务层返回前与 buildPaginationMeta 的键名（pagination）对齐，并统一详情加 data 包裹。
- **验证**：announcements 列表返回 {data, meta}（meta 为 PaginationMeta），详情 c.json(detail) 无 data 包裹，与其他资源的 {data, pagination}/{data:...} 约定确实不一致（service announcements.ts:85-94、149 已确认）。属契约/风格一致性问题，无功能或安全影响，从下调为低。

### NOJ-023 社区路由 cursor 分页的 limit 用 Number() 解析，无 NaN/上限校验
- **位置**：`noj-core/src/routes/community.ts:167,179,403,414,566`　**维度**：代码质量
- **描述**：多处用 `Number(c.req.query("limit") ?? 20)` 解析 limit（listPosts/listBookmarks/listFeed/listNotifications/listPendingComments），Number("abc") 返回 NaN 且无上限钳制，与 parsePagination 的"校验 + clamp 到 [1,100]"语义不一致。NaN 传入服务层 SQL LIMIT 可能触发数据库错误（返回 500）而非可预期的 400 校验错误。
- **证据**：`limit: Number(c.req.query("limit") ?? 20),`
- **建议**：抽取统一的 cursor-limit 解析（校验正整数 + 上限钳制），或在服务层入口对 limit 做 Number.isInteger 校验并 clamp。
- **验证**：核实 community.ts:167/179 等 `Number(c.req.query('limit') ?? 20)` 无 NaN/上限校验，与 parsePagination 的 clamp 语义不一致。真实代码质量问题，维持低。

### NOJ-041 题目列表分页结构（顶层 total/page/limit）与其余资源（嵌套 pagination）不一致
- **位置**：`noj-core/src/routes/problems.ts:121-126`　**维度**：正确性
- **描述**：GET /problems 返回 {data, total, page, limit}（分页元数据平铺在顶层），query 参数用 limit；而 submissions、admin/users、rankings、contests、conversations 等统一用 {data, pagination:{page,per_page,total,total_pages}}，query 参数用 per_page。admin.ts GET /problems 同样返回顶层 {data,total,page,limit}。前端 useApi/分页组件需为题目列表单独适配两种结构，属于响应形状与分页字段名双不统一。
- **证据**：`return c.json({ data: result.items, total: result.total, page: result.page, limit: result.limit });`
- **建议**：统一走 buildPaginationMeta 返回 {data, pagination:{page,per_page,total,total_pages}}，或在契约层明确标记 /problems 为 legacy 形状并让前端兼容层集中处理。
- **验证**：确认 problems.ts L121-126 返回平铺 {data,total,page,limit} 且用 limit 参数，与其他资源 parsePagination(per_page)+嵌套 pagination 结构不一致（属契约/命名双不统一）。前端已适配、无功能断裂，属一致性问题，由中下调为低。

### NOJ-044 内联 404 响应绕过统一错误结构（缺 code/request_id）
- **位置**：`noj-core/src/routes/problems.ts:345-377`　**维度**：正确性
- **描述**：支持包不存在（/support-package）与初始代码模板不存在（/template）两处直接用 c.json({error}, 404) 返回，未抛 NotFoundError，导致响应只有 {error} 字段，缺少 code 与 request_id，与全局 onError 的统一错误结构不一致。状态码本身（404）语义正确。
- **证据**：`if (!zipBytes) { return c.json({ error: "该题目尚无支持包" }, 404); } ... if (!tpl) { return c.json({ error: "该题目没有初始代码模板" }, 404); }`
- **建议**：改为 throw new NotFoundError("该题目尚无支持包") / throw new NotFoundError("该题目没有初始代码模板")，由 onError 统一输出。
- **验证**：属实：problems.ts:346 与 376 两处直接 c.json({error},404)，未抛 NotFoundError，响应缺 code/request_id，与全局 onError 结构不一致；状态码语义正确。维持「低」。

### NOJ-043 /submissions/:id/status 未传 viewerUserId，绕过服务层 owner 校验（越权查询）
- **位置**：`noj-core/src/routes/submissions.ts:213-224`　**维度**：正确性
- **描述**：路由调用 getSubmissionQueueStatus(id) 未传 viewerUserId/viewerRole。服务层（services/queue.ts:283-285）权限判断为 `if (viewerUserId !== undefined && viewerRole !== "admin") { if (rows[0].user_id !== viewerUserId) return null; }`——viewerUserId 为 undefined 时整段校验被跳过，任意已登录用户可查询任意提交的 contest_id、status、judge_started_at/finished_at、排队位置。服务层 docstring 明确写"生产路由不应走到此分支"，但路由注释又声称"任意已登录用户均可查看"，二者矛盾；对比 getSubmission 内是正确传入 viewerId 的。
- **证据**：`router.get("/:id/status", authMiddleware, async (c) => { const id = c.req.param("id"); const result = await getSubmissionQueueStatus(id); if (!result) throw new NotFoundError("提交不存在"); return c.json(result); });`
- **建议**：传入 c.var.userId 与 role：`getSubmissionQueueStatus(id, c.var.userId, c.var.userRole)`，或在路由层对非 owner 且非 admin 返回 403/404。
- **验证**：核实 routes/submissions.ts:213-224 未传 viewerUserId；queue.ts:283-285 在 undefined 时整段跳过，任意登录用户可查任意提交状态。但路由注释明确声明『任意已登录用户均可查看』，泄露面仅 contest_id/status/时间戳/排队位置（无 code/output），UUID 难枚举，属已声明的低敏信息暴露，中→低。

### NOJ-107 deleteRole 未做『最后一个可登录 admin』保护，可经删除自定义 admin 角色间接降级最后管理员
- **位置**：`noj-core/src/services/admin-roles.ts:283-317`　**维度**：安全
- **描述**：last-admin 保护仅在 updateUserRoles（行 402-414）与 banUser（users.ts 行 554-562）实现，deleteRole 只检查 is_system 与子角色继承，随后直接 DELETE 角色并依赖 CASCADE 清理 user_roles。若某管理员的 admin 权限来源于自定义（非 is_system）角色（admin 可通过 updateUserRoles/createRole 制造此布局），删除该角色会连带剥离其 admin:full_access 且不触发任何剩余管理员计数检查，从而绕过『禁止降级最后一个可登录 admin』约束。属特定角色布局下的边角绕过。
- **证据**：`export async function deleteRole(id: string): Promise<void> {
  // 仅检查 is_system 与子角色，无 getAdminUserIds() 剩余管理员计数
  if (role.is_system) throw new ForbiddenError("系统角色不可删除");
  ...
  await db.delete(roles).where(eq(roles.id, id)); // CASCADE 清理 user_roles
}`
- **建议**：在 deleteRole 前，若该角色（含继承链）授予 admin:full_access，则复用 getAdminUserIds() 校验删除后仍有至少一个可登录 admin，否则拒绝删除。
- **验证**：确认 deleteRole(admin-roles.ts:283-317) 仅查 is_system 与子角色继承后直接 DELETE，无 getAdminUserIds 剩余管理员计数检查；而 updateUserRoles(407)、banUser(users.ts:555)、auth.ts 等均有该保护。特定自定义角色布局下可绕过最后管理员保护属实，需管理员级操作、属边角绕过。维持低。

### NOJ-003 登录用户枚举时序侧信道（用户不存在跳过 bcrypt）
- **位置**：`noj-core/src/services/auth.ts:228-257`　**维度**：安全
- **描述**：响应文案统一为『用户名或密码错误』，但『用户不存在』分支（line 228-239）直接 throw，不执行 bcrypt；『密码错误』分支（line 245-257）执行 comparePassword（cost 12 约 250ms）。两者响应时间存在显著差异，攻击者可据此枚举用户名/邮箱是否存在。IP/账号限流（10/30s、5/30s）只能部分缓解，无法消除。
- **证据**：`if (existing.length === 0) { await logAuthEvent(...); throw new UnauthorizedError("用户名或密码错误"); }
...
const valid = await comparePassword(input.password, user.password_hash);`
- **建议**：用户不存在时也执行一次等价的 bcrypt.compare（对固定假哈希），消除时序差。
- **验证**：时序侧信道属实（auth.ts:228-239 用户不存在直接 throw 不做 bcrypt，245-257 密码错误走 comparePassword ~250ms），但下调为低：一是 register 端点 registerUser(130-143) 已用不同文案明确返回『用户名已存在/邮箱已被注册』，用户枚举已可通过更廉价通道完成，此时序信道冗余；二是 IP/账号限流（10/30s、5/30s）进一步压缩采样吞吐。

### NOJ-110 JWT 未携带 is_admin claim 且 role 由角色名硬编码推导，与 rbac-core「不依赖角色名称」相悖
- **位置**：`noj-core/src/services/auth.ts:304-323`　**维度**：规范符合性
- **描述**：rbac-core 规范（L63-65）要求 JWT 含 is_admin 布尔 claim（由 user_roles+roles.is_admin 推导）、requireAdmin/requirePermission 走 c.var.isAdmin fast path，并明确「不依赖角色名称」（L63）；cookie-auth 规范（L73）要求 session role 取 is_admin=true/is_default=true 角色名。实现中 JWT 只有 sub/role/must_change_password/jti（lib/jwt.ts L35-44 无 is_admin），登录时 role 用硬编码名 `name==='admin'`/`name==='user'` 推导（auth.ts L311-313），而非 is_admin/is_default 标志；且服务层仍残留 `viewerRole === "admin"` 名称化兜底判断（objective-submissions.ts L237/L298、submissions-crud.ts L473、objective-questions.ts L70/L83 等）。
- **证据**：`规范：rbac-core/spec.md L59-65（is_admin 标记/JWT claim/不依赖名称）；实现：auth.ts L311-313 硬编码名查找、L318 注释「不携带 is_admin claim」，permissions.ts L13「JWT 不携带 is_admin claim」。`
- **建议**：按规范在登录时从 roles.is_admin/is_default 推导并在 JWT 注入 is_admin claim，或修订规范明确「以 admin:full_access 权限替代 is_admin claim」，并清理服务层残留的角色名兜底判断。
- **验证**：实现确认与规范相悖：rbac-core/spec.md L63/L65 要求 JWT 含 is_admin claim 且不依赖角色名；auth.ts:311-313 用 `r.name==='admin'/'user'` 硬编码推导、L318 注释明确不携带 is_admin；objective-submissions.ts:237/298 存在 `viewerRole==='admin'` 兜底。事实准确，但实际鉴权走 checkPermission/isUserAdmin 实时查询（功能上更安全），名称硬编码仅用于 JWT role 展示/审计与 CLI 兜底，无功能缺陷，属规范漂移，由『中』下调『低』。

### NOJ-002 密码与用户名/邮箱的相似性检查仅精确相等，不检查包含/子串
- **位置**：`noj-core/src/services/auth.ts:74-80`　**维度**：安全
- **描述**：validatePasswordStrength 仅判断 password 与 username（忽略大小写）以及邮箱 @ 前缀『完全相等』，不检测密码是否包含用户名/邮箱前缀或其变形（如 'MyUsername123!' 可绕过）。
- **证据**：`if (password.toLowerCase() === username.toLowerCase()) { throw ... }
if (emailPrefix && password.toLowerCase() === emailPrefix) { throw ... }`
- **建议**：增加包含判断（如 password.toLowerCase().includes(username.toLowerCase())）或使用 Levenshtein/常用字典相似度阈值。
- **验证**：确认。auth.ts:74-80 仅判断密码与用户名/邮箱前缀忽略大小写『完全相等』，不检测包含/子串/变形，'MyUsername123!' 可绕过，属实（密码策略缺口，低危）。

### NOJ-009 注册 TOCTOU：check-then-insert 无唯一约束冲突处理
- **位置**：`noj-core/src/services/auth.ts:124-159`　**维度**：安全
- **描述**：registerUser 先 SELECT 检查 username/email 是否已存在，再 INSERT，INSERT 未用 onConflictDoNothing 且未捕获唯一约束冲突（23505）。并发注册同名/同邮箱时，DB 唯一约束兜底保证数据不重复，但竞争失败的请求抛未处理 PG 错误，返回 500 而非 409，且两次 SELECT 属竞态冗余。
- **证据**：`const existingUsername = await db.select().from(users).where(eq(users.username, input.username))...
...
await db.insert(users).values({ id, username, email, password_hash, ... });`
- **建议**：INSERT 后捕获 unique violation 转 ConflictError，或使用 onConflictDoNothing 并检查 affected rows；username/email 唯一约束已在 schema.ts:40-41。
- **验证**：真阳性：http_download（download.rs:66-72）不校验 scheme、未设 redirect 策略，reqwest 默认跟随最多 10 次含 https→http 降级/跨主机。但 URL 由可信 noj-core 生成的 presigned，checksum（verify_checksum）部分兜底篡改，SSRF 需 admin/MQ 级控制 url，属纵深防御缺口而非可直接利用。下调至低。

### NOJ-010 注册无邮箱验证流程
- **位置**：`noj-core/src/services/auth.ts:114-198`　**维度**：安全
- **描述**：registerUser 直接 INSERT 用户并返回，无任何邮箱验证（无验证链接/验证码/email_verified 状态）。schema.ts 中 users 表无 email_verified 列。用户可用任意（含他人）邮箱注册，结合注册端点无速率限制，可批量创建垃圾账号或占用他人邮箱。
- **证据**：`await db.insert(users).values({ id, username: input.username, email: input.email, password_hash: passwordHash, ... });`
- **建议**：引入邮箱验证状态字段与验证流程，或在产品层明确接受该风险并加注册限流。
- **验证**：真阳性：守卫 fetchUser() 后未再复查 isLoggedIn 即放行（middleware/auth.ts:51-61），fetchUser 失败内部 logout 清空 user 后导航仍被放行；useAuth.ts 在 SSR/客户端同步置 loading=false（57/66 行），useAuthReady 的 5s 超时为死代码。但为前端守卫，后端 authMiddleware 仍强制鉴权、无数据泄露（仅缺 /login 重定向）。下调至低。

### NOJ-024 服务层事务参数滥用 any（tx?: any / db: any）
- **位置**：`noj-core/src/services/categories.ts:285`　**维度**：代码质量
- **描述**：多个服务函数以 any 声明事务/连接参数，绕过类型检查：categories.ts:285 `tx?: any`、contests.ts:155 `db: any`、rankings.ts:143/185 `db: any`、system-settings.ts:401 `tx?: any`。虽带 deno-lint-ignore 与注释（postgres.js 与 PGlite 事务共享接口），但 any 使传入错误类型无法在编译期发现，且同类参数在不同文件重复声明，未统一为共享类型别名。
- **证据**：`// deno-lint-ignore no-explicit-any
tx?: any,`
- **建议**：定义共享事务类型别名（如 `type DbLike = ReturnType<typeof getDb>` 或 Drizzle PgTransaction 联合类型），集中到 db/connection.ts 导出，替换各处的 any。
- **验证**：确认 categories.ts:284-285 带 deno-lint-ignore 的 tx?: any 属实，属类型安全削弱。维持低。

### NOJ-013 社区点赞/收藏/关注 toggle 非原子，并发双击触发主键冲突 500
- **位置**：`noj-core/src/services/community.ts:1006-1027`　**维度**：正确性
- **描述**：toggleRelation 采用『先 SELECT 查存在，再 INSERT/DELETE』的非原子实现，无 onConflictDoNothing 也未捕获 23505。两个并发请求同时通过 SELECT（都判为不存在）后同时 INSERT，命中 (post_id,user_id) 主键唯一约束，其中一个请求抛未处理的 23505 → 全局 onError 返回 500。togglePostLike、toggleBookmark 复用该函数；toggleCommentLike(1071-1101)、toggleFollow(1109-1131) 为同样的 SELECT-then-INSERT 模式，均存在相同竞态。
- **证据**：`const existing = await db.select().from(table)...limit(1); if (existing[0]) { delete; return false; } await db.insert(table).values({...}); return true;`
- **建议**：改用 INSERT ... ON CONFLICT DO NOTHING / DO UPDATE，或 DELETE ... WHERE 后根据 returning 行数判断；至少捕获 23505 并按幂等语义处理，使并发双击得到稳定结果而非 500。
- **验证**：真阳性。createSubmission 入队后直接 db.update set status='judging'（submissions-crud.ts:387）绕过会在 pending→judging 时设 judge_started_at 的 updateSubmissionStatus；mq 目录仅 startResultConsumerWithRetry 一个结果消费者、无 started 事件消费者，注释误导。judge_started_at 恒 null，queue.ts:162 排序退化为无序。维持低。

### NOJ-014 举报未阻止举报自己，且重复举报检查无唯一约束兜底
- **位置**：`noj-core/src/services/community.ts:1369-1424`　**维度**：正确性
- **描述**：createReport 未校验 reporter_id 是否等于被举报内容（帖子/评论）的作者，用户可举报自己的内容制造噪音、消耗审核资源。重复举报判断（1394-1405）是 SELECT 后再 INSERT，communityReports 表没有 (reporter_id, post_id/comment_id, status) 唯一约束，并发重复举报可产生多条 pending 记录。
- **证据**：`const existing = await db.select({id: communityReports.id})...eq(status,'pending')...limit(1); if (existing[0]) throw new ConflictError('已举报该内容');`
- **建议**：在创建举报前校验目标作者与举报者不同（如产品允许自举报则明确放行）；并给 communityReports 增加部分唯一索引或在 INSERT 上使用 ON CONFLICT DO NOTHING 兜底并发重复。
- **验证**：真阳性。rpc.md:196 称单个输出缓冲约 4 MiB，但收集输出上限 MAX_OUTPUT_BYTES=1MiB（dual/mod.rs:37），4MiB 是协议行切分缓冲 MAX_BUFFER_BYTES（protocol.rs:58），文档混淆两者。维持低。

### NOJ-088 listComments 返回帖子全部评论，无 LIMIT/分页，每条含相关子查询
- **位置**：`noj-core/src/services/community.ts:878-914`　**维度**：性能
- **描述**：listComments 先 getPost 校验（额外一次含 5 个相关子查询的重查询），随后无 limit 返回该帖全部评论，每条评论再带一个 likes 相关子查询（count over community_comment_likes）。热门帖评论量大时一次性拉全量数据并做 N 次子查询。
- **证据**：`.from(communityComments).innerJoin(users,...).where(and(...conditions)).orderBy(communityComments.created_at);  // 无 .limit()`
- **建议**：为评论列表加分页/游标（created_at 复合游标）；likes 计数改为 GROUP BY comment_id 一次聚合；去掉冗余的 getPost 前置校验。
- **验证**：community.ts:878-914 listComments 先 getPost 额外重查询，随后无 .limit() 返回该帖全部评论，每条带 likes 相关子查询（909 行），热门帖存在一次性拉全量 + N 次子查询的性能问题，维持低。

### NOJ-015 竞赛排名 show_ranking_live 配置未生效（IOI 进行中始终公开完整排名）
- **位置**：`noj-core/src/services/contest-ranking.ts:303-327`　**维度**：正确性
- **描述**：getContestRanking 仅对 type==='oi' 在 running 期间做『仅参赛者可见自身』限制，对 type==='ioi' 无条件走 getIoiRanking 返回完整排名，完全未读取 contest.config.show_ranking_live。即使运营者为 ioi 竞赛配置 show_ranking_live=false 期望隐藏实时排名，该配置也不会生效，进行中排名仍对所有人（含匿名）公开。
- **证据**：`if (type !== 'icpc') { return getIoiRanking(contestId); } —— 未引用 config.show_ranking_live。`
- **建议**：在 getContestRanking 中读取 config.show_ranking_live，对 ioi 且 show_ranking_live=false 的进行中竞赛施加与 oi 相同的仅参赛者可见/仅自身排名限制。
- **验证**：真阳性。Cargo.toml 全文件无 [profile.release] 段，release 构建走默认 panic=unwind/strip=none/lto=false。属构建硬化建议，事实属实。维持低。

### NOJ-016 竞赛排名 SQL 缺少开始时间下界，调整 start_time 后赛前提交仍计入
- **位置**：`noj-core/src/services/contest-ranking.ts:60-71`　**维度**：正确性
- **描述**：ICPC（60-71）与 IOI（204-224）的 evaluated_submissions 仅约束 s.created_at <= c.end_time，未约束 s.created_at >= c.start_time。正常提交路径由 routes/contests.ts 的『仅 running 期间可提交』保证不会出现赛前提交，但 updateContest 允许事后任意修改 start_time：若管理员将 start_time 后移，先前窗口内已产生的提交在排名中仍被计为已解决（solve_time 被 GREATEST(0,..) 钳为 0）。
- **证据**：`WHERE s.contest_id = ${contestId} AND s.created_at <= c.end_time ...（无 >= c.start_time）`
- **建议**：在排名查询补上 s.created_at >= c.start_time（及客观题分支同样处理），或禁止在已有提交后修改 start_time。
- **验证**：真阳性。logout.post.ts:33-38 deleteCookie 仅传 path:'/'，未匹配 [...slug].ts:90-94 的 secure:isProductionEnv()/sameSite:'lax'。属性不一致属实；实际删除仍按 name+domain+path 匹配（Secure 非身份字段），故为脆弱写法、影响有限。维持低。

### NOJ-017 私信标记已读未校验消息归属于该会话
- **位置**：`noj-core/src/services/messages.ts:416-439`　**维度**：正确性
- **描述**：markConversationRead 仅校验用户是会话参与者，未校验 last_read_message_id 属于该会话。参与者可传入另一会话（或未来）的消息 id 作为已读位置，使 getUnreadCountByConversation 依据该消息的 created_at 计算未读数，导致自身未读数被错误清零或放大（属自伤性数据污染，非跨用户越权）。
- **证据**：`await assertParticipant(userId, conversationId); ... .insert(conversationReads).values({ user_id, conversation_id, last_read_message_id: lastReadMessageId, ... }) —— 未验证消息归属。`
- **建议**：在写入前校验该 last_read_message_id 存在于 messages 且 conversation_id 匹配，否则 400/404。
- **验证**：真阳性。useProblemFilters.ts:22 hasActiveFilters 只判 keyword/difficulty/categoryId，遗漏 problemType（也遗漏 problemNumber）；仅按类型筛选且无结果时空态不显示『清除筛选』按钮、文案误导。维持低。

### NOJ-105 GET /api/v1/conversations/:id/unread-count 未校验会话参与者，可越权获取任意会话消息数
- **位置**：`noj-core/src/services/messages.ts:468-522`　**维度**：安全
- **描述**：getUnreadCountByConversation 直接按 conversationId 统计消息数，未调用 assertParticipant 校验当前用户是否属于该会话（而同文件的 listMessages/sendMessage/markConversationRead/deleteMessage 均做了校验）。路由 /:id/unread-count 仅依赖此函数，任何登录用户可猜测/枚举 conversation UUID，获取他人会话的消息总数（无内容）。泄露面有限（仅计数，且 UUID 难枚举），但属缺失归属校验的越权。
- **证据**：`export async function getUnreadCountByConversation(userId, conversationId) {
  // 缺少 await assertParticipant(userId, conversationId)
  const [readState] = await getDb().select({...}).from(conversationReads).where(and(eq(conversationReads.user_id,userId), eq(conversationReads.conversation_id,conversationId)));`
- **建议**：在 getUnreadCountByConversation 入口处调用 assertParticipant(userId, conversationId)（或对非参与者返回 0/404），与其余会话接口保持一致。
- **验证**：核实 messages.ts:468-522 getUnreadCountByConversation 未调用 assertParticipant（对比 :156/339/421/543 均有）；routes/conversations.ts:133-136 直接调用。可枚举 UUID 获取他人会话消息数（仅计数、无内容），越权属实但泄露面极小，维持低。

### NOJ-012 客观题套卷竞赛答案泄露：练习模式提交返回标准答案，绕过竞赛防泄题
- **位置**：`noj-core/src/services/objective-submissions.ts:189-191`　**维度**：正确性
- **描述**：submitObjectivePaper 在练习模式（contest_id 为 null）下通过 withExplanation 将每题的标准答案 expected 与解析一并返回；而竞赛模式才用 stripExpected 裁剪。当同一套卷被用于进行中的竞赛时，参赛者只需不带 contest_id 提交同一 paper_id（练习模式），即可从响应 details 中读到全部题目的标准答案，随后以满分提交竞赛卷，绕过服务端即时判定的防泄题设计。练习提交路径（submitObjectivePaper 入口）只做 getPaperOrThrow + assertObjectivePaper，无任何『该套卷正被某个进行中竞赛使用』的拦截。
- **证据**：`details: contestMode ? stripExpected(judgement.details) : withExplanation(judgement.details, questions) —— withExplanation 展开 ...(details[q.id] ?? {...}) 保留 expected；且练习模式分支不做任何竞赛归属校验。`
- **建议**：在练习提交前检查该套卷是否正被任一进行中（running/pending）的竞赛引用（contest_problems.contest_id → contests.status），若在竞赛窗口内则禁止练习模式提交或对竞赛卷做同等的答案裁剪；或按 paper 单独配置『是否在练习模式回显答案』。
- **验证**：真阳性。validateValueType（system-settings.ts:155-167）对 string 仅 typeof + smtp_from email 校验，email_provider/storage_provider 等枚举项无取值白名单；email.ts:38-43 对未知 provider 静默回退 mock，配置与行为可偏离。维持低。

### NOJ-004 forgot-password 无速率限制且存在邮箱枚举时序差
- **位置**：`noj-core/src/services/passwordReset.ts:41-83`　**维度**：安全
- **描述**：routes/auth.ts:364 的 /forgot-password 端点未挂任何速率限制中间件（对比 login 有三层限流）。邮箱不存在时（line 41-49）立即返回；邮箱存在时（line 52-83）生成令牌 + 写 DB + 发送邮件，耗时与邮件投递均可被攻击者观察，形成无限制的邮箱枚举面。
- **证据**：`if (userRows.length === 0) { await logAuthEvent(...); return; }  // 立即返回
... // 存在：generateResetToken + insert + sendPasswordResetEmail`
- **建议**：对 /forgot-password 增加 IP/邮箱维度速率限制；并对不存在路径做等耗时填充。
- **验证**：真阳性。parseJsonBody 仅 catch 语法错误，字面量 null 不抛错直接返回，路由（如 submissions.ts:101 `body.problem_id`）空引用抛 TypeError→500 而非 400。但仅影响错误状态码、无安全/数据影响，下调至低。

### NOJ-006 密码重置成功后不吊销既有 JWT 会话
- **位置**：`noj-core/src/services/passwordReset.ts:141-167`　**维度**：安全
- **描述**：resetPassword 事务内仅更新 users.password_hash，未调用 revokeJti（对比 /change-password 与 /logout 均会吊销）。账号被入侵后，受害者通过重置密码改密，攻击者已持有的旧 JWT 仍有效至自然过期（最长 24h），可继续冒充访问。
- **证据**：`await db.transaction(async (tx) => { ... await tx.update(users).set({ password_hash: newHash, updated_at: nowIso }).where(eq(users.id, user.id)); });`
- **建议**：重置成功后吊销该用户所有活跃 jti（可引入 per-user token 版本号或 jti 列表），使旧会话立即失效。
- **验证**：代码行为属实：banlistMiddleware:39-42 对 getClientIp 返回 'unknown' 直接 return next()（fail-open），且注释明确这是『让 401/403 正常错误路径不被堵死』的刻意设计；rate-limit-env.ts:157-163 显示生产环境 TRUSTED_PROXIES 为空时 main.ts 已 Deno.exit(1)。真实可利用性低（需代理配置错误或核心端口直连暴露），下调至低。

### NOJ-050 公开题目详情/列表暴露 runtime_config 与 support_package_storage_url 内部字段
- **位置**：`noj-core/src/services/problems-list.ts:48-67`　**维度**：安全
- **描述**：toProblemResponse 将 support_package_storage_url 与 runtime_config 原样返回，而 GET /api/v1/problems/:id（public）与 GET /api/v1/problems（public）都直接复用该 DTO。runtime_config 含 evaluator/solution 的 Docker 镜像名、评测命令、时间/内存限额；support_package_storage_url 在 S3 模式下暴露对象键（内部 bucket 路径）。匿名用户即可读取这些内部部署细节，配合 /api/v1/judge-images 公开接口可拼出完整评测环境画像，降低沙箱逃逸/基础设施探测门槛。
- **证据**：`support_package_storage_url: row.support_package_storage_url, has_support_package: row.support_package_storage_url !== null, runtime_config: row.runtime_config as RuntimeConfig,`
- **建议**：公开视图仅返回 has_support_package 布尔，support_package_storage_url 仅 owner/admin 可见；runtime_config 仅 owner/admin 可见，普通用户返回 null 或仅返回 time/memory 限额等非敏感字段。
- **验证**：problems-list.ts:48-67 toProblemResponse 原样返回 support_package_storage_url 与 runtime_config，且 GET /problems 与 /problems/:id 均为公开无鉴权，匿名可读内部评测镜像/命令/S3 对象键。属信息泄露、降低探测门槛，无直接利用，维持低。

### NOJ-063 LIKE 查询未转义通配符（%/_/\）
- **位置**：`noj-core/src/services/problems-list.ts:128-139`　**维度**：安全
- **描述**：listProblems/listAllProblems 的关键字筛选直接构造 `%${query.keyword}%` 传入 ilike，未像 search.ts 那样先经 escapeLikePattern 转义 `%`/`_`/`\`。用户输入含 % 或 _ 时会产生非预期通配匹配（如输入 '50%' 匹配任意含 50 的标题），虽已参数化、无 SQL 注入，但属于通配符注入/搜索语义失控。同类问题：users.ts:318 的 searchUsers、submissions-crud.ts:131/139/149-151 的 problemSearch/userSearch/submissionId 同样未转义。
- **证据**：`const kw = `%${query.keyword}%`;
conditions.push(
  sql`(${ilike(problems.title, kw)} OR ${ilike(problems.description, kw)} ... )`,
);`
- **建议**：复用 search.ts 的 escapeLikePattern 统一转义，并配合 ESCAPE '\' 子句；或改用参数化 + 明确文档说明关键字为子串语义。
- **验证**：problems-list.ts:128-129 直接构造 %${keyword}% 传入 ilike，未转义 %/_/\；而 search.ts:27 有 escapeLikePattern 并在 :75/207/272 使用。参数化无 SQL 注入，但通配符注入/搜索语义失控真实，维持低。

### NOJ-090 题目列表关键字对 description 无索引 ILIKE，触发全表扫描
- **位置**：`noj-core/src/services/problems-list.ts:128-139`　**维度**：性能
- **描述**：listProblems 的关键字筛选 OR 了 ilike(title)（有 trgm 索引）与 ilike(description)、ilike(id)、ilike(CAST(number AS TEXT))、ilike(type||number)（均无索引）。description 是大文本字段且无 pg_trgm 索引，含 '%kw%' 的 OR 分支会迫使 problems 全表扫描（尤其无难度/分类过滤时）。problems 表当前较小，但随题库增长会劣化。
- **证据**：`sql`(${ilike(problems.title, kw)} OR ${ilike(problems.description, kw)} OR ${ilike(problems.id, kw)} ...)``
- **建议**：为 description 增加 pg_trgm GIN 索引，或限定关键字仅搜索 title/display_id；对 difficulty/type 组合可考虑复合索引。
- **验证**：确认 problems-list.ts L128-139 keyword 条件 OR 了 description/id/CAST(number)/type||number 的 ILIKE '%kw%'（description 大字段无 trgm 索引，仅 title 有），可致全表扫描，随题库增长劣化，维持低。

### NOJ-051 队列解析失败时日志打印原始队列条目内容（含未脱敏的 code/download_url 前缀）
- **位置**：`noj-core/src/services/queue.ts:82-84`　**维度**：安全
- **描述**：getPendingSubmissionIds 遍历 Redis 队列条目，JSON.parse 失败时 logger.error 打印 item.slice(0, 200)。队列条目是 JudgeTask（含 code=用户源代码、download_url=支持包 base64）。虽然仅在解析失败的边缘场景触发、且只截前 200 字符（大概率落在 submission_id/runtime_config 段），但字段名 'content' 不在 logging.ts 的 SENSITIVE_KEYS 中，生产环境也不会被脱敏，异常条目若被截断位置靠后仍可能泄露用户代码或 download_url 前缀。
- **证据**：`logger.error("队列中存在无法解析的条目，已跳过", { content: item.slice(0, 200), });`
- **建议**：不要打印原始条目内容；改为只记录条目的长度、字节数或 SHA-256 摘要，或将字段名改为命中脱敏规则的 key。
- **验证**：确认 queue.ts L82-84 JSON.parse 失败时 logger.error 打印 item.slice(0,200)，key 为 content，不在 logging 脱敏清单；仅解析失败边缘场景且截 200 字符，真实但风险有限，维持低。

### NOJ-086 题目搜索 display_id 拼接表达式 ILIKE 无索引，绕过 GIN/trgm
- **位置**：`noj-core/src/services/search.ts:94-98`　**维度**：性能
- **描述**：searchProblems 的 WHERE 用 (p.type || p.number::text) ILIKE '%q%' 兜底匹配 'P1001' 这类 display_id。这是运行时拼接表达式，problems 表只有 search_vector GIN 与 title 的 trgm GIN，没有该表达式的索引，也没有单独的 display_id 列/表达式索引，导致该分支无法走索引（在 OR 中引入全表扫描分支）。
- **证据**：`OR (p.type \|\| p.number::text) ILIKE ${likeQ} ESCAPE '\\'`
- **建议**：增加表达式索引 CREATE INDEX ... ON problems USING gin ((type || number::text) gin_trgm_ops)；或存储/生成 display_id 列并建 trgm 索引。
- **验证**：属实：search.ts:97 `(p.type || p.number::text) ILIKE ${likeQ}` 为运行时拼接表达式，problems 表无对应表达式索引（仅 search_vector GIN 与 title trgm GIN），该 OR 分支无法走索引。但 search_vector GENERATED 列已含 type+number（weight B）可覆盖多数 display_id 检索，ILIKE 为兜底。真实性能缺口，维持「低」。

### NOJ-070 judge_started_at 从未被设置（正常提交路径绕过 updateSubmissionStatus）
- **位置**：`noj-core/src/services/submissions-crud.ts:386-389`　**维度**：正确性
- **描述**：createSubmission 入队后直接用 db.update 把 status 置为 judging（387-389），绕过了会在 pending→judging 时设置 judge_started_at 的 updateSubmissionStatus（submissions-result.ts 190-192）。注释（386）声称 judge_started_at 由 noj-judge 的『started 事件』设置，但 noj-core 中不存在任何 started 事件消费者（仅有 startResultConsumerWithRetry 一个结果消费者，main.ts 186）。因此正常提交的 judge_started_at 恒为 null：queue.ts 的 judging 列表按 judge_started_at ASC 排序（162）退化为无意义排序，getSubmission 也始终返回 null 时间戳。
- **证据**：`// 注意：此处不设置 judge_started_at，它由 noj-judge 开始执行时通过 started 事件设置
await db.update(submissions).set({ status: "judging" }).where(eq(submissions.id, id));`
- **建议**：要么补齐 started 事件消费者，要么在此处改为调用 updateSubmissionStatus(id, "judging") 以统一设置 judge_started_at，并删除误导性注释。
- **验证**：核实成立。submissions-crud.ts:386-389 正常提交入队后直接 db.update 置 judging，绕过 updateSubmissionStatus(submissions-result.ts:190-192 才会设 judge_started_at)；注释声称由 noj-judge「started 事件」设置，但 grep 全仓 noj-core 无任何 started 事件消费者(仅结果消费者)。故正常提交 judge_started_at 恒 null，queue.ts:162 按 judge_started_at ASC 排序退化为无意义。维持低。

### NOJ-026 巨型文件：users.ts 单文件 909 行，用户档案与头像存储混杂
- **位置**：`noj-core/src/services/users.ts:1-909`　**维度**：代码质量
- **描述**：该文件同时承担用户档案聚合/搜索（getUserProfileAggregate/searchUsers）、档案更新（updateUserProfile/adminUpdateUserProfile）、封禁管理（banUser/unbanUser/getUserBanHistory）与头像对象存储（updateUserAvatar/clearUserAvatar/getUserAvatarBytes + sameStorageObject 工具）四类职责。头像存储（777-909 行）与用户档案 CRUD 是独立的存储层关注点，混在一起降低内聚。
- **证据**：`export async function getUserProfileAggregate(...); export async function banUser(...); export async function updateUserAvatar(...);`
- **建议**：拆出 users-avatars.ts（头像上传/清除/读取，依赖 storage provider）与 users-bans.ts（封禁/解封/历史），users.ts 只保留档案聚合与更新。
- **验证**：users.ts 确为 909 行，混合 getUserProfileAggregate(80)/searchUsers(292)/banUser(530)/unbanUser(603)/updateUserAvatar(818) 等四类职责。属实，保留低。

## 信息

### NOJ-206 noj-core/.env（未跟踪）含测试值，无真实秘密
- **位置**：`noj-core/.env:2`　**维度**：密钥卫生
- **描述**：本地 noj-core/.env 与 .env.example 的差异项为：JWT_SECRET 为带 'test' 字样的 32 字符测试串、NOJ_ENV=test、STORAGE_PROVIDER=s3、S3 密钥为 minioadmin。均为测试/开发值，未发现真实生产秘密。该文件已被 .gitignore 正确忽略、不在 git 跟踪范围内，不构成仓库泄露。
- **证据**：`JWT_SECRET=test***rs!（已掩码）；S3_ACCESS_KEY/S3_SECRET_KEY=minioadmin`
- **建议**：无需处理；若曾误提交，请确认 git 历史中无该文件（当前基线未跟踪）。
- **验证**：实测 noj-core/.env 仅含测试值（JWT_SECRET 为 test 字样 32 字符、NOJ_ENV=test、S3 密钥 minioadmin），已被 .gitignore 忽略、非 git 跟踪，无真实生产秘密，不构成泄露，维持信息（无需处理）。

### NOJ-145 noj-core/CLAUDE.md services 文件计数过时
- **位置**：`noj-core/CLAUDE.md:108`　**维度**：文档准确性
- **描述**：目录结构称 services 为「34 个文件」，实际 src/services/ 现有 41 个文件（新增 announcements、objective-*、contest-*、notifications 等）。
- **证据**：`noj-core/CLAUDE.md:108「34 个文件」；ls noj-core/src/services/ 实际 41 个 .ts 文件。`
- **建议**：删除具体数字或更新为当前值，避免维护性陈述失真。
- **验证**：noj-core/CLAUDE.md:108 称 services「34 个文件」，实际 src/services/ 有 41 个 .ts 文件（新增 objective-*/contest-*/notifications/announcements 等）。计数过时真实，维持信息。

### NOJ-151 noj-core 存在两份分歧的 AGENTS.md 与 CLAUDE.md
- **位置**：`noj-core/CLAUDE.md:1`　**维度**：文档准确性
- **描述**：noj-core 同时保留 AGENTS.md 与 CLAUDE.md 两个独立文件（非同源），内容已分歧（如 CLAUDE.md 的开发命令含 test:parallel/test:smoke，AGENTS.md 不含；二者规模 612 行 vs 590 行），而 noj-ui/noj-judge 采用 CLAUDE.md → AGENTS.md 软链约定，形成 noj-core 的两个竞争性事实来源。
- **证据**：`diff noj-core/AGENTS.md noj-core/CLAUDE.md 不同；wc -l 612 vs 590；noj-ui/CLAUDE.md、noj-judge/CLAUDE.md 均为 → AGENTS.md 软链。`
- **建议**：统一 noj-core 文档策略：删除其一并建立软链或明确主文档，消除分歧。
- **验证**：实测 noj-core 同时存在 AGENTS.md(590 行) 与 CLAUDE.md(612 行) 两个独立普通文件（非软链），内容已分歧，形成竞争性事实来源，而 noj-ui/noj-judge 采用 CLAUDE.md→AGENTS.md 软链约定，维持信息。

### NOJ-057 开发期传递依赖 esbuild@0.18.20 过时且经已弃用加载器引入
- **位置**：`noj-core/deno.lock:1032`　**维度**：依赖卫生
- **描述**：esbuild@0.18.20（2023 年旧版）经已标记 deprecated 的 @esbuild-kit/core-utils / @esbuild-kit/esm-loader（第 452/460 行）由 drizzle-kit@0.31.10 传递引入，仅用于 `deno task db:generate`（构建期，非运行时）。该版本处于 CVE-2025-25291（esbuild dev-server 请求伪造，影响 <0.25.0）范围，但该 CVE 仅在 dev-server 场景可触达，drizzle-kit 仅用其 transform API，实际不可达。另 lock 中 uuid@9.0.1（第 1411 行，腾讯云 SDK 传递）亦标记 deprecated。凭经验判断，建议 deno audit 确认。
- **证据**：`"esbuild@0.18.20": { ... "scripts": true, "bin": true }，依赖链 drizzle-kit→@esbuild-kit/esm-loader→@esbuild-kit/core-utils→esbuild@0.18.20`
- **建议**：升级 drizzle-kit 以摆脱已弃用的 @esbuild-kit 链（新版改用 esbuild 0.25+/tsx），并复核 CVE 可达性。
- **验证**：deno.lock:1032 存在 esbuild@0.18.20，经 drizzle-kit→@esbuild-kit 链传递引入，仅构建期使用；所述 CVE 仅 dev-server 可触达、transform API 不可达，属依赖卫生观察，维持『信息』。

### NOJ-046 开发环境 CORS origin:* 与 credentials:true 组合浏览器会拒绝
- **位置**：`noj-core/src/app.ts:85-96`　**维度**：正确性
- **描述**：开发环境 origin:"*" 且 credentials:true 同时生效时，Hono 会返回 Access-Control-Allow-Origin:* 与 Access-Control-Allow-Credentials:true，浏览器按规范拒绝该组合（带凭据的跨域响应不允许通配 Origin）。当前 noj-ui 走 Nitro 同源代理不受影响，但第三方跨域调用携带 Cookie 时会失败；此外 allowHeaders 未包含 Cookie。属开发模式已知限制。
- **证据**：`origin: isProd ? (allowedOrigins ?? []) : "*", credentials: true, allowHeaders: ["Content-Type", "Authorization"], maxAge: SECONDS_PER_DAY`
- **建议**：开发模式若要真正支持凭据，可改为回显请求 Origin（origin 传函数）或关闭 credentials；生产白名单逻辑已正确。
- **验证**：属实：app.ts:85-96 开发环境 origin:'*' 且 credentials:true，浏览器会拒绝通配 Origin+凭据组合；noj-ui 走 Nitro 同源代理不受影响。维持「信息」。

### NOJ-052 /api/v1/judge-images 无鉴权公开评测镜像白名单（内部部署信息）
- **位置**：`noj-core/src/app.ts:165-168`　**维度**：安全
- **描述**：GET /api/v1/judge-images 未挂任何鉴权（为公开列表，注册在 SSE 的 authMiddleware 之前），向匿名用户返回评测镜像白名单全量条目（image 名、mode、kind、description）。镜像名如 noj-judge-python / noj-evaluator-python / noj-solution-python 属内部部署信息，与 findings 中的 runtime_config 泄露叠加可还原评测容器环境。若该列表仅前端展示用，可考虑限制为登录用户或裁剪 image 字段。
- **证据**：`app.get("/api/v1/judge-images", async (c) => { const items = await listJudgeImages(); return c.json({ data: items }); });`
- **建议**：确认该端点是否需要匿名公开；如需公开，仅返回 id/image/description 等必要字段并隐藏 kind/mode 等内部标记，或改为登录可见。
- **验证**：确认 app.ts L165-168 GET /api/v1/judge-images 未挂鉴权、注册于 SSE authMiddleware 之前，匿名可读评测镜像白名单全量（image/mode/kind/description），属内部部署信息暴露，维持信息。

### NOJ-027 巨型文件：schema.ts 单文件 1321 行（38 张表定义集中一处）
- **位置**：`noj-core/src/db/schema.ts:1-1321`　**维度**：代码质量
- **描述**：38 张表定义全部集中在单个 schema.ts，虽然 schema 文件天然偏大，但社区 17 张表、竞赛 4 张表、RBAC 4 张表与其他核心表混排，使查找某张表定义与索引需要在 1300 行内跳转。schema-ddl.ts(603 行) 亦有同样倾向（DDL 字符串与索引集中）。
- **证据**：`38 张表 + 索引定义集中在 src/db/schema.ts（wc -l = 1321）`
- **建议**：按域拆分为 db/schema/core.ts、db/schema/community.ts、db/schema/contests.ts 等，由 db/schema.ts 汇总 re-export，保持既有 `import * as schema` 兼容。
- **验证**：schema.ts 确为 1321 行、38 张表集中一处，主观组织结构建议，保留信息。

### NOJ-119 zip 条目路径校验两侧不一致：core 漏检反斜杠穿越
- **位置**：`noj-core/src/lib/bundle-parser.ts:44-54`　**维度**：安全
- **描述**：core 端 assertSafeEntryPath 仅按 name.split("/") 分段检测 .. 段与 / 开头，未把 \ 视作路径分隔符；而 judge 端 extract_zip_entries（container.rs:50-52）按 ['/','\\'] 分段检测 ..。因此形如 ..\\evil 的条目可通过 core 的导入校验并被 zipSync 原样重打包存储，直到 judge 端才被拦截。当前 core 不落盘解压、judge 侧更严格，尚无可直接利用的路径穿越；但两处校验语义不一致，若未来 core 侧引入落盘解压或弱化 judge 校验将立即变为可穿越。
- **证据**：`function assertSafeEntryPath(name) {
  if (name.startsWith("/")) throw ...;
  const segments = name.split("/");
  for (const seg of segments) { if (seg === "..") throw ...; }
}
// judge: original_name.split(['/', '\\']).any(\|p\| p == "..")`
- **建议**：统一 core 与 judge 的路径安全校验：core 端同样按 / 与 \ 分段并拒绝 .. 段，且对空段、以 ./ 开头等做一致处理，形成单一共享规则。
- **验证**：确认。bundle-parser.ts:44-54 assertSafeEntryPath 仅按 name.split("/") 检测 .. 与 / 开头，不把 \ 视作分隔符；judge container.rs:50 用 split(['/','\\']).any(=="..")。`..\\evil` 可过 core 导入校验、直到 judge 端才拦截；core 不落盘解压故当前无可利用穿越，属校验语义不一致的隐患。

### NOJ-036 env-snapshot 注释宣称 NOJ_ENV=test 时跳过快照，但实现未做该判断
- **位置**：`noj-core/src/lib/env-snapshot.ts:130-149`　**维度**：可靠性
- **描述**：文件头部（9-10 行）与 snapshotEnv 的 JSDoc（130-136 行）均声明「NOJ_ENV === 'test' 时跳过快照，返回空对象」，但函数体（137-149 行）只判断 _snapshotted，从不检查 NOJ_ENV，测试环境下仍会读取 Deno.env 并填充快照。当前行为未造成明显故障（测试通常不依赖快照为空），但文档与实现不一致，后续依赖「test 返回空对象」语义的代码可能被误导。
- **证据**：`export function snapshotEnv(): Record<string, string \| undefined> {
  if (_snapshotted) {
    return envSnapshot;
  }
  const snap: Record<string, string \| undefined> = {};
  for (const def of ENV_ONLY_DEFINITIONS) {
    snap[def.key] = Deno.env.get(def.key);
  }`
- **建议**：在 snapshotEnv 中按注释实现 NOJ_ENV==='test' 跳过逻辑，或删除过时注释，保持文档与实现一致。
- **验证**：env-snapshot.ts 头部/JSDoc（:9-10,:130-136）声明 NOJ_ENV==='test' 时跳过快照返回空对象，但 snapshotEnv 函数体（:137-149）仅判断 _snapshotted、从不检查 NOJ_ENV。文档与实现不一致真实，维持信息。

### NOJ-020 ForbiddenError 默认错误码回退为 INTERNAL_ERROR，与 403 状态码不匹配
- **位置**：`noj-core/src/lib/errors.ts:33,102-111`　**维度**：代码质量
- **描述**：AppError 构造函数中 code 未显式传入时回退为 "INTERNAL_ERROR"。ForbiddenError 是唯一把 code 透传（可不传）的子类，导致大量 `throw new ForbiddenError("权限不足")`（如 lib/permissions.ts:117/131/148、services/problems-crud.ts:253 等）返回 HTTP 403 但响应体 code 却是 INTERNAL_ERROR。前端若按 code 区分 5xx 与 4xx 会误判为服务器故障，破坏错误处理契约（CLAUDE.md 明确要求统一 AppError 体系带机器可读 code）。
- **证据**：`this.code = code ?? "INTERNAL_ERROR";  // AppError 构造函数
// ForbiddenError: super(message, 403, code, meta); code 为 undefined 时不传`
- **建议**：为 ForbiddenError 提供默认 code="FORBIDDEN"（与 ConflictError/ValidationError 等子类一致），或让 AppError 按 statusCode 自动派生默认 code，避免 403/INTERNAL_ERROR 的错配。
- **验证**：真阳性。README.md:212 称『71 个测试文件』，实际 noj-core/tests 下 94 个 .ts 文件（glob 计数确认），计数过时。维持信息。

### NOJ-101 内存退避与通用限流器为进程内实现，多实例部署下不一致
- **位置**：`noj-core/src/lib/loginThrottle.ts:116-117`　**维度**：安全
- **描述**：失败退避 inMemoryBackoff 与通用 rateLimit（middleware/rate-limit.ts:29 trackedRequests）均为进程内 Map。多实例部署时各实例各自计数，同一攻击者负载均衡到不同实例可获得 N 倍额度。失败计数与锁定已在 Redis（跨进程一致），此缺口仅影响退避延迟与读端点通用限流，代码注释已声明该取舍。
- **证据**：`const inMemoryBackoff = new Map<string, number>();`
- **建议**：对需要强一致的退避/通用限流改用 Redis 计数；否则在文档明确多实例语义。
- **验证**：确认 loginThrottle.ts L117 inMemoryBackoff 为进程内 Map，通用限流亦为进程内；多实例下各计各数。失败计数/锁定已在 Redis（跨进程），此缺口仅影响退避延迟与读端点限流，且代码注释已声明取舍，维持信息。

### NOJ-100 登录/搜索限流为固定窗口，窗口边界存在双倍突刺（已声明可接受）
- **位置**：`noj-core/src/lib/rate-limit.ts:9-10,66-69`　**维度**：安全
- **描述**：checkRateLimit 用 INCR + PEXPIRE 实现固定窗口，窗口切换瞬间理论上可在 2 倍时间窗内通过 2 倍请求，代码注释已声明可接受，非缺陷。首次 INCR 与 PEXPIRE 为两次独立调用，存在极小概率 TTL 重置竞态，影响可忽略。
- **证据**：`// 固定窗口的边界突刺（窗口切换可双倍）问题在限流场景下可接受`
- **建议**：如需严格边界控制可改滑动窗口/令牌桶（Redis Lua 原子化）；否则维持现状并在文档标注。
- **验证**：rate-limit.ts:9-10 注释明确『固定窗口边界突刺…在限流场景下可接受』，66-69 首次 INCR 后单独 PEXPIRE 存在极小竞态，影响可忽略，属已声明可接受的设计取舍，非缺陷，维持信息。

### NOJ-118 base64 交付层大小上限不一致：local 模式大包内联后超出 MQ 16MB 上限
- **位置**：`noj-core/src/lib/storage/local.ts:156-161`　**维度**：安全
- **描述**：支持包上传允许到 128MB（support-package.ts:18 MAX_SUPPORT_PACKAGE_SIZE），judge 端 base64 解码上限也是 128MB（download.rs:14），但 local 模式 downloadUrl 将整个包 base64 内联进 download_url，经 JudgeTask JSON 序列化后受 producer.ts:17 的 16MB MAX_MESSAGE_BYTES 硬限制（41-45 超限抛错）。128MB 包 base64 后约 170MB，必然超限导致提交被标记 error；且每次提交都全量读取 + base64 编码大包，构成对 core 内存/CPU 的放大消耗。base64 侧核心构造处无任何大小复检。
- **证据**：`// support-package.ts:18
const MAX_SUPPORT_PACKAGE_SIZE = 128 * 1024 * 1024;
// producer.ts:17,41-45
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
if (messageBytes > MAX_MESSAGE_BYTES) throw new Error(...);
// local.ts:159 直接 base64 内联整个 data`
- **建议**：在 downloadUrl（local 模式）中校验 base64 后大小，超过 MQ 上限时提前报错并给出明确提示；或统一交付层上限与 MQ 上限（如将 local 模式支持包上限对齐到约 12MB），避免静默提交失败与资源放大。
- **验证**：support-package.ts:18 128MB、download.rs:14 128MB、producer.ts:17/41-45 16MB、local.ts:156-161 base64 全量内联 download_url。128MB 包 base64≈170MB 必超 16MB MQ 上限致提交 error。属实；但 local 模式为 dev 专用（生产走 S3 presigned URL），故仅信息级。

### NOJ-078 CLAUDE.md 与 connection.ts 对共享连接的配置描述不一致（文档漂移）
- **位置**：`noj-core/src/mq/connection.ts:136-144`　**维度**：可靠性
- **描述**：CLAUDE.md『Redis MQ 约定』称 getRedis() 共享连接为 `enableOfflineQueue: false，重试 5 次后停止`；实际代码为 maxRetriesPerRequest: 20、enableOfflineQueue: true，且 retryStrategy 返回 Math.min(times*200, 2000) 从不返回 null（即永不停止重连）。实际行为与文档不符，易误导后续维护者对生产者重连语义的判断。
- **证据**：`_redis = new IORedis(redisUrl, {
  maxRetriesPerRequest: 20,
  enableOfflineQueue: true,
  retryStrategy(times) { return Math.min(times * 200, 2000); },
  lazyConnect: true,
});`
- **建议**：同步修正 CLAUDE.md 中关于 getRedis 连接配置的描述，或在代码注释中明确实际语义，避免文档与实现长期不一致。
- **验证**：确认。mq/connection.ts:136-144 getRedis 实际为 maxRetriesPerRequest:20、enableOfflineQueue:true、retryStrategy 返回 Math.min(times*200,2000) 从不返回 null（永不停止）；而 CLAUDE.md/AGENTS.md 称『enableOfflineQueue:false，重试 5 次后停止』，文档与实现不一致，属实。

### NOJ-080 结果消费者与 HTTP 服务同进程，串行消费并与 HTTP 竞争事件循环和 DB 连接池
- **位置**：`noj-core/src/mq/consumer.ts:19-61`　**维度**：可靠性
- **描述**：startResultConsumerWithRetry 在 main.ts:186 于 HTTP 服务前启动且不 await，消费循环（单 BRPOP、串行 handleMessage）与 Deno.serve 共享同一事件循环与 DB 连接池（DATABASE_POOL_MAX=10）。handleMessage→saveEvaluationResult 每条结果执行多次串行 DB 往返（选 submission、事务 update+insert、first_accepted 查询等，submissions-result.ts:42-143）。单条坏消息虽不会阻塞队列（JSON 解析失败 continue、DB 错误被吞），但结果高峰期串行消费会拉长结果落库延迟并与 API 请求竞争连接池；若未来引入同步阻塞代码将直接冻结 HTTP。属架构性观察而非当前缺陷。
- **证据**：`startResultConsumerWithRetry(); // main.ts:186
...
while (true) { const result = await redis.brpop(...); await opts.handleMessage(message); }`
- **建议**：评估将结果消费者拆为独立进程/worker，或对 saveEvaluationResult 的热路径 DB 往返做批量化/连接池隔离；保持 handleMessage 全程异步、禁止同步阻塞。
- **验证**：main.ts:186 startResultConsumerWithRetry() 不 await，消费循环单 BRPOP 串行 handleMessage，与 Deno.serve 共享事件循环与 DB 连接池（DATABASE_POOL_MAX=10）。架构性观察属实，单条坏消息不阻塞队列，属当前无实际故障，维持信息。

### NOJ-021 分页解析逻辑重复且行为不一致（parsePagination 已抽取但未全面落地）
- **位置**：`noj-core/src/routes/admin.ts:87-91,152-156,182-187,465-469,557-561`　**维度**：代码质量
- **描述**：lib/pagination.ts 已提供 parsePagination()（PR-6 抽取，非法 page 抛 ValidationError 400），但 routes/admin.ts 仍有 5 处手写相同样板（/users、/submissions、/blacklist、/audit-logs 四段完全相同的 5 行 + /problems 用 limit 字段名），routes/problems.ts:86-96 也有一处。且行为不一致：parsePagination 对非法 page 抛 400，而手写版 `if (isNaN(page)||page<1) page=1` 静默回退到 1，同样的输入在不同端点得到不同语义；字段名也不统一（per_page vs limit）。parsePagination 在 admin.ts 仅用于 /contests（第 283、352 行），说明抽取工作半途而废。
- **证据**：`let page = parseInt(c.req.query("page") ?? "1", 10);
let perPage = parseInt(c.req.query("per_page") ?? "20", 10);
if (isNaN(page) \|\| page < 1) page = 1;
if (isNaN(perPage) \|\| perPage < 1) perPage = 20;
if (perPage > 100) perPage = 100;`
- **建议**：将所有手写分页统一替换为 parsePagination(c) + buildPaginationMeta()，消除字段名（page/limit/per_page）与校验语义（静默回退 vs 抛错）的不一致。
- **验证**：真阳性。extract_zip_entries（sandbox/container.rs:44-67）仅判 is_dir，不识别 unix_mode S_IFLNK/硬链接；但注入层 inject_file_to_container 以固定 0o644 普通文件写 tar（dual/mod.rs:97-99），符号链接被扁平化为普通文件、当前不可利用，属『碰巧安全』的防御缺口。维持信息。

### NOJ-047 注册密码长度预检 8 位与 AGENTS.md「最小 12 字符」文档不符
- **位置**：`noj-core/src/routes/auth.ts:96-99`　**维度**：正确性
- **描述**：路由快速预检 `body.password.length < 8`，服务层 MIN_PASSWORD_LENGTH 亦为 8（auth.ts:40 有注释说明为降低注册摩擦而偏离 OWASP 12 字符建议）。而根 AGENTS.md §11.2 与 noj-core/CLAUDE.md 均声明「密码最小 12 字符」。属文档与实现漂移（代码有注释记录该决策），非路由逻辑错误，但契约对外披露的密码策略与实际不一致。
- **证据**：`if (body.password.length < 8) { throw new ValidationError("密码长度不能少于 8 位"); }`
- **建议**：统一文档与实现：要么将 MIN_PASSWORD_LENGTH 提升到 12，要么更新 AGENTS.md/CLAUDE.md 中的密码策略描述。
- **验证**：routes/auth.ts:97-98 预检 body.password.length < 8（『密码长度不能少于 8 位』），与根 AGENTS.md §11.2 及 CLAUDE.md『最小 12 字符』不符；代码注释已声明为降低注册摩擦偏离 OWASP 12 字符，属文档-实现漂移，维持信息。

### NOJ-114 problem-management 规范仍以 judge_image/judge_command 为必填，实现已改用 runtime_config
- **位置**：`noj-core/src/routes/problems.ts:186-197`　**维度**：规范符合性
- **描述**：problem-management 规范 L33-35 与 L165-193 仍以 judge_image/judge_command 作为必填字段与镜像下拉来源。实现中创建校验要求 title/description/runtime_config（routes/problems.ts L186-197），镜像改为 judge_images 白名单 + runtime_config.evaluator/solution.image。属双容器改造后的规范未同步。
- **证据**：`规范：problem-management/spec.md L33-35、L165-193；实现：routes/problems.ts L190-197（缺 description/runtime_config 报 400），problems-crud.ts L88-101（runtime_config 镜像白名单校验）。`
- **建议**：同步 problem-management 规范，将 judge_image/judge_command 必填描述替换为 runtime_config 必填 + 镜像白名单校验。
- **验证**：确认实现 routes/problems.ts:186-197 要求 title/description/runtime_config，镜像改走 judge_images 白名单+runtime_config；规范 judge_image/judge_command 必填描述未同步，属实。维持信息。

### NOJ-045 GET /submissions/:id 实际公开可访问，与文档「登录」不符且匿名可见 score/time/memory
- **位置**：`noj-core/src/routes/submissions.ts:196-206`　**维度**：正确性
- **描述**：路由使用 optionalAuthMiddleware（匿名放行），而 CLAUDE.md 路由表标注该端点为「登录」。getSubmission 对非 owner/非 admin 仍返回 status、score、time_ms、memory_kb、language、file_name 等字段（仅 code/output/details 置 null，见 submissions-crud.ts:496-505）。score/time/memory 对匿名公开可能泄露竞赛提交成绩（含 contest_id 的提交），与「基础数据公开」的设计注释和文档存在出入，建议确认是否应约束为登录可见。
- **证据**：`router.get("/:id", optionalAuthMiddleware, async (c) => { const result = await getSubmission(id, c.var.userId, undefined, c); return c.json({ data: result }); });`
- **建议**：若需与文档一致，改为 authMiddleware 并将 score/time_ms/memory_kb 纳入 canSeeDetails 门控；否则更新 CLAUDE.md 路由表明确该端点为公开。
- **验证**：核实成立。submissions.ts:196-206 用 optionalAuthMiddleware(匿名放行)，与 CLAUDE.md 路由表「登录」不符；submissions-crud.ts:496-505 对非 owner/非 admin 仍返回 status/score/time_ms/memory_kb/language/file_name(仅 code/output/details 置 null)。属文档与行为出入+匿名可见提交成绩，finding 已自评为信息，维持信息。

### NOJ-019 签到以 UTC 日期切分，时区边界与本地感知不一致
- **位置**：`noj-core/src/services/checkin.ts:113-114`　**维度**：正确性
- **描述**：checkIn 用 todayUtc()（UTC YYYY-MM-DD）作为签到日期键，日界按 UTC 午夜切换。对 UTC+8 等东时区用户，『今天』要到本地上午 8:00 才更新，跨日签到/连续天数（streak）的计算边界与用户本地直觉不符。代码注释已声明『统一使用 UTC 简化时区处理』，属设计取舍而非缺陷；同日并发与重复签到已由 ON CONFLICT DO NOTHING + check_ins_user_date_unique 唯一约束正确兜底。
- **证据**：`const today = todayUtc(); const yesterday = yesterdayUtc(); ... .onConflictDoNothing({ target: [checkIns.user_id, checkIns.checkin_date] })`
- **建议**：如需本地化签到日界，可在用户维度引入时区偏移或配置项，并将日期键按目标时区计算；否则保持现状并明确产品预期。
- **验证**：真阳性。stats-cache.ts 用进程内存（模块级 let）懒加载全表 count(*) LEFT JOIN、永不失效、跨实例不共享，applyNewResult 增量与 COUNT 语义存在漂移风险。维持信息。

### NOJ-089 帖子列表/详情用逐行相关子查询统计点赞与评论数
- **位置**：`noj-core/src/services/community.ts:526-545`　**维度**：性能
- **描述**：listPosts/listBookmarks/getPost 通过每行标量子查询 (select count(*) from community_post_likes/community_comments where post_id=...) 统计点赞/评论数。这些子查询能借助复合主键 (post_id,user_id)/(comment_id,user_id) 的 post_id/comment_id 前缀列走索引，非缺失索引问题，但列表每页仍产生 2N 次索引查找，可进一步批量化。
- **证据**：`likes: sql`(select count(*) from community_post_likes where post_id = ${communityPosts.id})``
- **建议**：改用 LEFT JOIN LATERAL 或按 post_id GROUP BY 的聚合一次取回计数，减少每行子查询。
- **验证**：属实：community.ts:533-538 listPosts 每行标量子查询统计 likes/comments，能走复合主键前缀列索引，属 2N 次索引查找的批量化优化点，非缺索引。维持「信息」。

### NOJ-018 客观题套卷在竞赛题目列表的 user_status 不统计客观题提交
- **位置**：`noj-core/src/services/contests.ts:549-568`　**维度**：正确性
- **描述**：getContestProblems 的 user_status 计算仅 JOIN submissions + evaluation_results，未统计 objective_submissions。客观题套卷（is_objective）提交走 objective_submissions 表，因此参赛者即便已在竞赛中满分答对客观题，题目列表仍显示 untouched（排名查询则单独 UNION 客观题，二者口径不一致）。
- **证据**：`CASE WHEN EXISTS (SELECT 1 FROM submissions s JOIN evaluation_results er ... WHERE s.contest_id = cp.contest_id AND s.problem_id = cp.problem_id AND s.user_id = ... AND er.status='Accepted') THEN 'solved' ...`
- **建议**：在 user_status 计算中并入 objective_submissions（满分卷视为 solved、有提交视为 attempted），与竞赛排名口径保持一致。
- **验证**：真阳性。submissions.ts:196 GET /:id 用 optionalAuthMiddleware 匿名放行；getSubmission（submissions-crud.ts:496-505）对非 owner/admin 仍返回 status/score/time_ms/memory_kb（仅 code/output/details 置 null）。与 CLAUDE.md『登录』标注不符。维持信息。

### NOJ-022 硬编码 "admin" 字符串比较散布多个文件，RBAC 迁移未完成
- **位置**：`noj-core/src/services/objective-questions.ts:70,83`　**维度**：代码质量
- **描述**：CLAUDE.md 明确声明项目以 RBAC 替代硬编码 userRole === "admin"，但服务层仍有大量硬编码字符串比较：objective-questions.ts:70/83、objective-submissions.ts:237/298、queue.ts:283、support-package.ts:65/161、problems-crud.ts:131/145/244/252/395/403、submissions-crud.ts:473、problem-bundle.ts:109、problem-field-guard.ts:93。这些判断依赖已废弃的 users.role/JWT role claim，角色变更后不实时生效，且与新增的 assertPermission/checkPermission 形成两套并行鉴权语义，同一类权限判断在不同函数中走不同路径，属复制粘贴型重复逻辑。
- **证据**：`if (userRole === "admin") return true;   // objective-questions.ts:70
: viewerRole === "admin";                  // objective-submissions.ts:237`
- **建议**：统一迁移到 lib/permissions.ts 的 checkPermission/assertPermission（或 isUserAdmin），由请求级缓存实时查询权限集，彻底移除 userRole/viewerRole 字符串比较的 fallback。
- **验证**：真阳性。EditorToolbar.vue:83 单行 flex 无 flex-wrap/overflow-x-auto，容纳返回/标题/语言选择(min-w-[110px])/主题/侧栏/设置/提交等 8+ 控件，无 sm 断点隐藏，窄屏溢出。维持信息。

### NOJ-072 客观题即时判定与异步评测是完全割裂的两套表/状态模型
- **位置**：`noj-core/src/services/objective-submissions.ts:116-194`　**维度**：正确性
- **描述**：客观题提交走 submitObjectivePaper，直接写入独立的 objective_submissions 表（status 恒为 finished，170/163），不经过 submissions 表、不进入 Redis 队列、不经过结果消费者与状态机。与编程题的 submissions/evaluation_results + pending→judging→finished 状态机完全割裂：列表/统计/榜单需分别 join 两套表，任何只查 submissions 的聚合（如 dashboard 的 pending 统计）都会漏掉客观题提交。同时客观题提交的 answers 载荷无大小上限（validateAnswersPayload 只校验非空数组，types/objective.ts 195-211）、无频率限制，绕过了编程题 MAX_CODE_LENGTH 与（应存在的）提交限频。
- **证据**：`const row = { ..., status: "finished", score: judgement.score, ... };
await db.insert(objectiveSubmissions).values(row); // 直接落库，无队列/状态机`
- **建议**：明确客观题与编程题的双轨设计契约并文档化；为客观题 answers 增加条目数/字节上限；为客观题提交端点加频率限制；如需统一统计口径，考虑在同一聚合层显式 UNION 两套提交来源。
- **验证**：objective-submissions.ts:116-194 submitObjectivePaper 直接 insert objectiveSubmissions(status:'finished',163)，不经 submissions 表/Redis 队列/状态机，双轨模型属实；answers 无大小上限（validateAnswersPayload 仅非空数组）也属实。保留信息。

### NOJ-087 统计缓存为进程内存全表 COUNT，多实例各算一遍且不失效
- **位置**：`noj-core/src/services/stats-cache.ts:25-64`　**维度**：性能
- **描述**：ensureTotal/ensureToday 在首次命中时对 submissions LEFT JOIN evaluation_results 做 count(*) 全表扫描（today 分支还带 created_at>=today 过滤），结果仅存于进程内存、永不失效、跨实例不共享。多实例部署时每节点各自全表扫描一次；total 缓存语义与 applyNewResult（结果到达时自增）对齐的是结果数而非提交数，存在失效时机不一致风险。
- **证据**：`count(*) from submissions leftJoin evaluationResults ... if (total !== null) return;`
- **建议**：改用 Redis 计数器（INCR）作为跨实例共享缓存，或在结果写回路径统一维护；today 统计按日期翻转时可接受每日一次全表扫描。
- **验证**：核实成立。stats-cache.ts 用模块级内存计数(16-21)，ensureTotal/ensureToday(25-64)首次命中做 submissions LEFT JOIN evaluation_results 全表 count(*)，结果仅存进程内存、永不失效(仅测试重置)、跨实例不共享；applyNewResult(103)自增的是结果数而非提交数，与 total 语义存在不一致窗口。多实例各扫一遍+不失效的性能/一致性观察，维持信息。

### NOJ-064 提交 file_name 字段无任何校验
- **位置**：`noj-core/src/services/submissions-crud.ts:303`　**维度**：安全
- **描述**：createSubmission 中 `const fileName = input.file_name || LANGUAGE_EXT_MAP[input.language] || "main.txt"`，input.file_name 来自请求体（routes/submissions.ts:124），未做长度、字符集、路径分隔符（/、\、..）校验，直接写入 DB 并进入 JudgeTask.file_name 转发给 noj-judge。当前 core 侧不将其用于文件路径（judge 端以硬编码 main.py 注入用户代码），故在 core 内不构成注入，但属于未校验的用户可控字符串，若前端/评测端误用该字段拼接路径或命令则可能升级。
- **证据**：`const fileName = input.file_name \|\| LANGUAGE_EXT_MAP[input.language] \|\| "main.txt";`
- **建议**：对 file_name 增加白名单校验（长度上限、仅允许字母数字与点号、拒绝路径分隔符与 ..），或直接忽略客户端传入的 file_name、一律由服务端按 language 映射生成。
- **验证**：核实 submissions-crud.ts:303 `input.file_name || LANGUAGE_EXT_MAP[...]` 未做长度/字符集/路径分隔符校验；当前 judge 端以硬编码 main.py 注入、core 不用于路径拼接，故仅未校验的可控字符串，维持信息。

### NOJ-071 提交时仅复验镜像、不复验 runtime_config 其余字段（command/limits/network）
- **位置**：`noj-core/src/services/submissions-crud.ts:342-350`　**维度**：正确性
- **描述**：createSubmission 读取 problem.runtime_config 后只调用 validateJudgeImageWithKind 校验 evaluator/solution 镜像白名单与 kind（343-350），不复验 evaluator.command、time_limit_ms、memory_limit_mb、network.enabled 等字段。这些字段仅在题目创建/更新时经 validateRuntimeConfig + enforceResourceLimits 校验（problems-crud.ts 88-115）。若 DB 中 runtime_config 被直接篡改、或经未校验路径写入（如历史数据/seed），提交链路不会兜底，异常 command/超限资源值会原样进入 JudgeTask。
- **证据**：`await validateJudgeImageWithKind(runtimeConfig.evaluator.image, "evaluator");
await validateJudgeImageWithKind(runtimeConfig.solution.image, "solution");
// 未调用 validateRuntimeConfig / enforceResourceLimits`
- **建议**：在 createSubmission 中补一次 validateRuntimeConfig(runtimeConfig)（纯函数、成本低），作为提交路径的防御性 final gate。
- **验证**：确认 submissions-crud.ts:342-350 仅调 validateJudgeImageWithKind 复验镜像，未复验 command/time/memory/network 等；这些字段在题目创建/更新时已由 validateRuntimeConfig+enforceResourceLimits 校验，提交路径缺防御性 final gate。维持信息。

### NOJ-111 RBAC 预置权限/默认权限数量与 rbac-core 规范不符（22→约44，user 角色 9→18）
- **位置**：`noj-core/src/types/index.ts:144-261`　**维度**：规范符合性
- **描述**：rbac-core 规范（L180-196）声明系统预置 22 个权限、user 角色默认 9 个权限。实现 PERMISSION_DEFS 已扩展至约 44 个（新增 admin:full_access、problem:field_evaluator_command/network、contest×3、community×8、community_moderation×4、community_board:manage、announcement:manage 等），seed-rbac.ts 的 USER_DEFAULT_PERMISSIONS（L28-47）含 18 项。属增量扩展导致的规范未同步，非功能缺陷。
- **证据**：`规范：rbac-core/spec.md L180-196；实现：types/index.ts L144-261（PERMISSION_DEFS），seed-rbac.ts L28-47（18 项 user 默认权限）。`
- **建议**：将新增资源域（community/contest/announcement 等）权限增量同步回 rbac-core 规范，修正「22 个/9 条」的过期数字。
- **验证**：PERMISSION_DEFS 实际约 42 项（types/index.ts:144-261），seed-rbac.ts:28-47 的 USER_DEFAULT_PERMISSIONS 18 项，均超 rbac-core 规范声明的 22/9，属增量扩展未同步规范的过期数字，维持『信息』。

### NOJ-113 JudgeTask 无 mode 字段且单容器回退路径已移除，与 judge-worker 规范不一致
- **位置**：`noj-core/src/types/index.ts:44-61`　**维度**：规范符合性
- **描述**：judge-worker 规范 L200 以 `JudgeTask.mode === 'dual'` 作为双容器判定，L380-404 仍描述「runtime_config 缺失时走单容器回退（judge_image/judge_command）」。实现中 JudgeTask 无 mode 字段（双容器为唯一模式），且 AGENTS.md/CLAUDE.md 明确单容器路径已移除、顶层 judge_image/judge_command 字段已删除。属规范漂移。
- **证据**：`规范：judge-worker/spec.md L200、L380-404；实现：types/index.ts L44-61（JudgeTask 无 mode），AGENTS.md L93-97（单容器字段移除）。`
- **建议**：更新 judge-worker 规范，删除 mode 字段与单容器回退描述，明确「所有评测统一双容器、runtime_config 必填」。
- **验证**：核实 types/index.ts:44-61 JudgeTask 无 mode 字段；openspec/specs/judge-worker/spec.md:200 `mode === 'dual'`、:399-404 单容器回退描述与实现（统一双容器、judge_image/judge_command 已删）不符，规范漂移属实，维持信息。

### NOJ-029 types/objective.ts 校验函数抛裸 Error 而非 AppError，契约脆弱
- **位置**：`noj-core/src/types/objective.ts:140-208`　**维度**：代码质量
- **描述**：validateAnswerForType/validateOptions/validateAnswersPayload 直接 `throw new Error(...)`（非 AppError 体系），依赖所有调用方手动 try/catch 包裹成 BadRequestError（objective-questions.ts:182/196/320/331、objective-submissions.ts:129 已包裹，但该契约靠约定维持）。一旦未来新增调用点遗漏包裹，裸 Error 会穿透全局 onError 变成 500 + 通用 "服务器内部错误"，丢失业务语义。docstring 也自述 @throws {Error}，说明校验层错误类型与 HTTP 层 AppError 未打通。
- **证据**：`throw new Error("答案必须是非空数组");  // types/objective.ts:145`
- **建议**：让这些校验函数直接抛 ValidationError，或改为返回 Result 类型（失败返回错误消息而非 throw），消除调用方手工包裹的脆弱契约。
- **验证**：确认。objective.ts:145/149/156/160/163/172/181/185/201/206/208 直接 throw new Error(...)，docstring 亦自述 @throws {Error}；调用方需手动 try/catch 包成 BadRequestError，契约靠约定维持，属真实代码质量/契约脆弱问题。
