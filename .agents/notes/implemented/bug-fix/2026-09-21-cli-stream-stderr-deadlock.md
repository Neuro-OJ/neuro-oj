# Agent Note: noj-cli 实时日志（stream）因未消费 stderr 而挂死

Status: implemented

## Problem

`noj-cli/src/runtime/command.ts` 的 `realRunner().stream()` 把子进程的
`stdout` 与 `stderr` 都设为 `"piped"`，但只读取 `stdout`：

```ts
const p = new Deno.Command(cmd, { ..., stdout: "piped", stderr: "piped" });
const child = p.spawn();
const reader = child.stdout.getReader();
for (;;) { const { done, value } = await reader.read(); ... }
return (await child.status).code;   // stderr 从未被读取
```

当子进程向 stderr 写入超过内核管道缓冲（Linux 约 64 KiB）后，它会阻塞在
`write(2)` 上，stdout 随之不再产生新数据，`reader.read()` 与
`child.status` 永远不返回——CLI **静默挂死**，无任何提示。

实际可达路径（两个调用点都走这里）：

- `noj-cli logs --follow` → `prod/lifecycle.ts:1069`
  `runner.stream("docker", args, ...)`，args 为
  `compose --env-file … -f … logs --tail=200 --follow [services]`；
- `noj-cli judge logs --follow` → `prod/judge/actions.ts:613`。

`docker compose logs --follow` 在多服务、容器重启/配置告警时会向 stderr
输出；`--follow` 又意味着进程长期运行，累积 64 KiB stderr 是常态。

实测（修复前，真实子进程复现）：

```ts
// 子进程：先向 stderr 写 256 KiB，再向 stdout 打印 'done'
await runner.stream("sh", ["-c", script], onLine)
// → 10s 超时（-1），子进程永不退出
```

同文件的 `run()`（`p.output()` 同时收两路）与 `spawn()`（无重定向时用
`inherit`）都是正确的，唯独 `stream()` 两路都 piped 却只读一路。

## Decision

在 `stream()` 中为 stderr 增加**并发的排空循环**，与 stdout 同样逐行解码并
交给同一个 `onLine` 回调；在返回退出码前 `await` 排空完成：

- 子进程不再因 stderr 缓冲写满而阻塞；
- stderr 内容（docker compose 的告警）不再被静默丢弃——这与 `logs` 命令
  "把日志给用户看"的语义一致，也让 `--follow` 的故障可见；
- 保持接口签名不变（不新增 `onErrLine`），避免改动 `CommandRunner` 契约与
  所有 fake 实现。

回归用例（`noj-cli/src/runtime/command_test.ts`）：
「realRunner.stream: 子进程大量 stderr 输出不会死锁」——子进程写 256 KiB
stderr 后打印一行，断言 `stream` 在 10s 内返回 0 且 stdout 行被回调
（修复前超时 -1）。

## Alternatives considered

1. **把 stderr 改为 `"inherit"`（直接透传到 CLI 的 stderr）**：可行且更简单，
   但会让 stderr 绕过调用方的 `onLine` 格式化：`logs` 命令的着色/`--json`
   输出契约与 `judge logs` 的 `log(line)` 都会漏掉 stderr。排空并回调与现有
   stdout 处理对称，行为更可预期。
2. **`stderr: "null"`（丢弃）**：能解死锁，但会**静默吞掉** docker compose
   的告警——正是 `logs` 场景用户最需要看到的信息，属用新缺陷换旧缺陷。
3. **只把 stderr 读进一个无界缓冲区不回调**：内存无界增长（`--follow` 长期
   运行），且信息仍不可见。

## Consequences

- `noj-cli logs --follow` / `judge logs --follow` 不再挂死；stderr 内容与
  stdout 一样逐行输出。
- `CommandRunner.stream` 的签名与 fake 实现不受影响（既有测试全绿：
  `deno task test` 731 passed）。
- 该缺陷与判分/评测流程无关，不改动任何 CLI 命令的参数与退出码契约。
