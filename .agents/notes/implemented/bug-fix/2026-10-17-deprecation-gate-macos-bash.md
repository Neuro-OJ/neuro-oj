# Agent Note: macOS bash 3.2 下弃用闸门测试假红

Status: implemented

## Problem

`scripts/deploy/test-deprecation-gate.sh` 在 macOS 上必然失败（Issue #660），
本地门禁假红，`bash scripts/deploy/test-deprecation-gate.sh` 退出码
1。两个独立原因：

1. **变量名歧义**：第 94 行 `"实得 $pty_status）"` 中 `$pty_status`
   紧跟全角右括号 `）`。macOS 自带 bash 3.2 的标识符扫描把 `）`
   的首字节并入变量名，在 `set -u` 下报
   `pty_status<乱码>: unbound variable`。同类写法还有第 55、69 行
   （`$status）`、`$status2）`），以及被 `deploy.sh`/`restore-drill.sh` source
   的 `deprecation-gate.sh` 第 112
   行（`"继续执行已废弃的 $script？输入 y 确认"`）。 后者在 `set -Eeuo pipefail`
   下同样炸掉，导致 PTY 用例永远走不到断言。
2. **`script` 参数不兼容**：第 88 行用 `script -qec`，那是 util-linux 的形式。
   BSD/macOS 的 `script` 只接受
   `script [-aeFkpqr] [-t time] [file [command ...]]`， 遇到 `-c` 直接
   `illegal option -- c`，命令根本没执行。

该脚本在 `scripts/gate-list.ts` 的 `REPO_GATES` 中，被 CI（root-gates →
`scripts/check-ci.ts`）与 `noj-cli/deno.json` 的 `test:production` 调用，
所以假红会直接阻断本地全量门禁。

修复过程中还发现 BSD `script` 的第二个坑：若 stdin 在启动瞬间就处于 EOF （例如
`printf 'y\n' | script ...`），它会先往 PTY 写一个 `^D`，使第一次 `read`
立刻返回空行，答案被吞掉。此时用例会"通过得莫名其妙"（`n` 恰好也是 非
y）或"失败得莫名其妙"（`y` 被当成取消）。

## Decision

- 把所有「`$变量` 紧跟全角字符」的写法改为 `${变量}`：测试脚本 3 处、
  `deprecation-gate.sh` 1 处、`deploy.sh` 2 处（`$parent；`、`$ENV_FILE；`）。
  纯字符串拼接改动，不涉及行为。
- 用 `detect_script_mode()` **探测**而非假设：对 `util-linux`（`-qec`）与
  `bsd`（尾随命令）两种形式各跑一次探测命令
  `IFS= read -r a; printf "NOJ_PTY_PROBE:%s\n" "$a"; exit 7`，要求同时满足
  「标记被打印」「管道送入的 `y` 被 `read` 读到」「退出码 7 被透传」。
  退出码透传是后续断言 `pty_status == 0` 的前提；stdin 投递是 BSD 那个 `^D` 坑的
  守门条件。三者缺一即判定该形式不可用。
- BSD 形式送入 stdin 时采用「数据先到 + 管道保持 1 秒」的写法
  （`{ printf '%s\n' "$2"; sleep 1; }`），避免 `script` 启动即见 EOF 而注入
  `^D`。
- 探测全部失败或系统没有 `script` 时**显式 SKIP**：打印 `! SKIP：…` 到
  stderr，结尾汇总改为
  `弃用闸门测试通过（PTY 用例已显式跳过，PTY 交互路径未被覆盖）`，退出码 0。
  跳过必须可见，不能静默当作通过。
- 四个用例的语义与断言不变：非 TTY 退出码 2、restore-drill 同样受闸门保护、
  `NOJ_ACCEPT_DEPRECATED=1` 跳过、输入 `n` 退出码 0。

## Alternatives considered

- **只加 `${pty_status}` 就收工**：macOS 上仍然会因为 `script -qec` 不兼容而红，
  且 `deprecation-gate.sh` 的 `$script？` 会让 PTY 用例继续假红。
- **在 macOS 上直接跳过 PTY 用例**：最省事，但把两个最有价值的用例（闸门放行 /
  用户取消）在开发者主力平台上永久挖空。探测机制已经能自证形式可用，保留真跑更好。
- **改用 `expect` 或 Python `pty` 模块**：能绕开 `script` 的参数差异，但给一个
  bash 门禁引入新依赖（`expect` 并非所有环境自带），且要额外维护一套引号嵌套的
  命令串，收益不抵复杂度。
- **按平台硬编码（`uname` 分支）**：macOS 与 Linux 之外的 BSD 行为未知，
  硬编码等于把「假设」换个位置；探测是自证的，平台判断不是。
- **让 `script` 缺失时静默 exit 0**：会让门禁在缺少工具时假绿，正是本 Issue 的
  反面（假信号）。

## Consequences

- macOS（bash 3.2.57）本机 `bash scripts/deploy/test-deprecation-gate.sh` 现在 5
  个断言全绿、退出码 0，连跑 5 次稳定；PTY 用例走 `bsd` 形式。
- Linux CI 走 `util-linux`
  形式，调用方式与修复前一致（`printf … | script -qec …`），
  仅多一次探测调用（约 10ms），断言与输出语义不变。
- BSD 形式每个 PTY 用例多 1 秒（`sleep 1` 保住管道），本机总耗时从约 1 秒增至约
  5 秒； Linux 侧无此开销。
- 探测失败时用例被显式跳过，门禁仍为绿但会打印 SKIP 与「PTY 交互路径未被覆盖」，
  reviewer 可从输出区分"真跑通"与"跳过"。
- 未覆盖：非 macOS 的其他 BSD 平台未实测，其 `script` 若 stdin 投递行为不同，
  探测会落到 SKIP 而不是假红；Windows/Git Bash 未考虑。
