# Agent Note: `.nojbackup` 单文件容器与 prod-raw 二进制采集

Status: implemented

## Problem

生产备份此前有两种互不相同的形态，各自缺一半：

1. **目录形态**（`scripts/deploy/backup.sh:224-294`）：产出
   `snapshot-<ts>/` 目录，其中**只有 `env.prod.gpg` 是加密的**，
   `postgres.dump`、`redis.rdb`、`minio/` 全是明文。后果有二：搬迁会漏文件；
   "加密备份"名不副实——任何能读该目录的人都拿得到全库转储（#515 P2）。
2. **单文件形态**（`maintain/backup.ts`，JSON 双模态时代产物）：产出
   `snapshot-<ts>.nojbackup`，但 payload 走 `CommandRunner.run()` 的
   **stdout 字符串**采集，二进制因此必须先 base64
   （`maintain/backup_driver.ts:114` 的注释记录了这条教训）。
   base64 让损坏"可检测"，却没有消除损坏的原因——采集方式本身是错的。

同时 `restore-drill.sh`（真实恢复演练，609 行）只认**目录**形态，而 `#515` 要求
单文件可搬迁。两者不可调和，除非统一容器形态。

## Decision

新增 `noj-cli/src/prod/backup/`，把形态收敛为**唯一**一种
（spec `2026-09-19-noj-cli-production-unification-design.md` §3.1）：

```text
snapshot-<ts>.nojbackup
└─ gpg(AES256)                 ← 整包加密
   └─ tar.zst
      ├─ manifest.json         payload_layout 恒为 "prod-raw"
      ├─ postgres.dump         pg_dump -Fc 原始二进制
      ├─ redis.rdb             redis-cli --rdb 原始二进制
      ├─ env.prod.gpg / minio/ / migration-status.txt
      └─ sha256sums.txt / SUCCESS
```

1. **整包加密**（`container.ts`）：gpg 作用于 `tar.zst` 整体，而不是逐个文件。
   `env.prod` 仍在包内单独加密一次（纵深防御：即使有人拿到口令解开了整包，
   `.env.prod` 在包里也是密文——与 bash 逐字一致）。
2. **二进制走文件重定向**（`driver.ts`，本任务最高风险项）。落点是既有
   `runtime/command.ts` 的 `SpawnOpts.stdoutFile`：`realRunner().spawn()` 用
   `child.stdout.pipeTo(file.writable)` 搬运**字节**，不经 `TextDecoder`。
   约束写进**类型**：`RawDriver` 的三个原语（`captureToFile` / `feedFromFile` /
   `feedToFile`）参数里没有"内容字符串"这个位置——想误用字符串路径必须先改签名。
   `runner` 缺 `spawn` 时明确抛错，绝不退化为 `run()`。
3. **`pg_restore --list` 进成功路径**：`postgres.dump` 落盘后立即用
   `pg_restore --list < dump` 校验结构（bash `:250-252` 亦然）。这是二进制**静默
   损坏的唯一可检出信号**，只在 verify 时跑就太晚了——损坏的快照会被当成好备份。
4. **纯 TS 增量 SHA-256**（`sha256.ts`）：`crypto.subtle.digest` 是一次性 API，
   而 `util/hash.ts:fileSha256Hex` 用 `Deno.readFile` 整读文件；数百 MB 的
   `postgres.dump` 会吃满内存。三个方案的取舍见该模块 JSDoc，选零依赖的纯 TS
   增量实现（1 MiB 分块，内存有界）。
5. **两轮打包**（`container.ts`）：manifest 要记录 `tar.zst` 的摘要，而 manifest
   自身又要进包，故"打包取摘要 → 写 manifest → 重新打包"。`manifest.sha256`
   记的是**未含 manifest** 时的 tar 摘要——那是校验方解包后能复算的对象。
6. **失败零残留**：staging 与 `${staging}.tar.zst`（staging **同级**，只删目录会
   漏掉）在 `finally` 清理，加密临时产物同样清理。半成品绝不会被 `list`/`prune`
   当成快照。
7. **shell 注入面**：路径一律经 POSIX 位置参数传递
   （`sh -c <script> <$0> <$1>…`，脚本内先存变量再 `shift`，于是 `"$@"` 恰好是
   调用方给的 args），绝不拼进脚本文本。命令名虽来自代码常量但可被环境覆盖
   （`NOJ_DEPLOY_DOCKER_BIN`），故做安全字符集白名单。

## Alternatives considered

- **让容器层调用 `sha256sum`**：把纯计算绑到外部二进制上，且 `openssl dgst` 的
  输出格式还需再解析。R1 要求 CLI 在仅有 docker/curl/openssl 的环境可用——
  多一个不必要的外部面，换来的是自己实现 200 行的节省，不划算。
- **用 Deno FFI 调 OpenSSL**：需要 `--allow-ffi`，且跨平台符号差异大；
  `deno compile` 产物的可移植性会下降。
- **继续用 base64 + `run()` 字符串采集**：这正是被替代的旧路径。base64 把
  "静默损坏"变成"可检测的损坏"，但备份的失败模式本就该是"不损坏"。
- **只在 verify 时跑 `pg_restore --list`**：会在 create 与 verify 之间留下一段
  "已产出但未验证"的窗口，而这期间用户可能已经删掉了唯一的旧备份。
- **manifest.sha256 记录最终 `.nojbackup` 密文的摘要**：整包加密后每次运行的
  密文都不同（GPG 的随机 IV/salt），密文摘要无法用于比较或复现；tar 摘要只要有
  相同的输入文件与压缩级别就稳定。
- **保留目录形态并让 drill 直接消费目录**：与 #515「单文件 + 可搬迁」直接冲突，
  且目录形态无法整包加密（逐文件加密会让 sha256sums 失去唯一锚点）。

## Consequences

- **二进制完整性有可断言的证据**：`container_test.ts` 注入 strict runner，令 payload
  采集一旦走 `run()` 的字符串路径**即抛错**——于是"是否走了字符串"成为硬约束而非
  靠 review；并断言落盘 byte-for-byte 等于含 NUL/0xFF 的原载荷。`driver_test.ts`
  进一步用**真实进程**（`realRunner` + `sh`/`cat`，不依赖 docker）端到端验证：
  含 NUL/0xFF 的字节逐字节落盘且长度相等（排除 UTF-8 归一化）；路径含空格/引号/`$`
  仍安全；目标命令只收到原始 argv；非 0 退出码如实回传。
- **反向证据**：同一载荷经 UTF-8 字符串往返后摘要必然不同——证明 sha256sums 与
  `pg_restore --list` 确实能抓住旧路径会引入的静默损坏。
- **`payload_layout` 恒为 `"prod-raw"`**：没有分派分支，T18 的 verify/restore 与
  T19 的 drill 都只需断言这一个值。
- **`maintain/backup.ts` 与 prod 侧并存**：那是 JSON 模态的备份路径，T23 才收敛。
  两者互不 import；`prod/backup/` 不依赖 `config/types.ts` 的 `DeployConfig`，
  因此不会把双模态的概念带进 prod 域。
- **容器文件名的可解析性**：`snapshot-<YYYYMMDD-HHMMSS>.nojbackup` 落在
  `maintain/backup_index.ts:parseBackupName` 的既有解析下，故 T18 的 `list`/`prune`
  无需感知容器内部结构。
- **`Sha256` 的吞吐低于原生实现**：备份是 IO 密集而非 CPU 密集，实测 3 MiB 文件
  在毫秒级完成；若未来出现 CPU 瓶颈，可在 driver 层替换为 `sha256sum` 而不改容器逻辑。
- **尚无命令面**（`backup create` 等）：T17 交付的是容器与驱动的能力层，
  `create` / `verify` / `restore` 的 CLI 接线归 T18，drill 归 T19。
