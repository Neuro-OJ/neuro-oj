#!/usr/bin/env bash
#
# R2 弃用闸门（T24）。
#
# 本文件由 `deploy.sh` 与 `restore-drill.sh` **source**，不单独执行。
#
# ## 为什么需要它
#
# T24 把生产运维的全部能力迁入了 `noj-cli`（纯 TS，R1）。但**直接删除**这两个
# 脚本会让仍按旧文档操作的运维者在**执行到一半**时才发现命令不存在——破坏性命令
# （`uninstall`、`restore`）尤其危险。因此过渡期保留它们，但每次执行都明确告知
# "你正在用已废弃的入口"，并要求显式确认。
#
# spec 在这里有一处**内部冲突**（已与用户确认按 §7 P10 + §8 R2 处理）：
# - §3.3 删除清单与 §10「不保留任何 bash 实现路径」→ 应删除这两个脚本；
# - §7 P10 与 §8 R2 → 应保留并加闸门。
# 采用**保留 + 闸门**：删除是不可逆的，而闸门可以在下一个版本再收紧为删除。
#
# ## 行为契约（逐条对应 §8 R2 验收）
#
# 1. 启动打印弃用警告（含**替代命令**，否则用户不知道该改用什么）；
# 2. **要求输入 `y`**（仅 `y`/`Y` 通过）；非 `y` → 以退出码 **0** 退出且
#    **无任何副作用**（用户主动取消不是错误）；
# 3. `NOJ_ACCEPT_DEPRECATED=1` 可跳过（供过渡期自动化脚本）；
# 4. **非 TTY 不挂起**：无 TTY 且未设 `NOJ_ACCEPT_DEPRECATED` → **明确报错退出**
#    （退出码 2，用法错误），而不是阻塞在 `read` 上等一个永远不会到来的输入。
#
# ## 为什么非 TTY 是"报错"而不是"自动放行"
#
# 自动放行会让 CI/定时任务在无人察觉的情况下继续使用废弃入口——那正是弃用闸门要
# 阻止的事情。明确报错把决定权交回给调用方：要么设 `NOJ_ACCEPT_DEPRECATED=1`
# 表达"我知道自己在用废弃入口"，要么改用 `noj-cli`。
#
# ## 拒绝路径零副作用的实现
#
# 闸门必须在脚本做**任何事**之前调用（含参数解析、目录创建、docker 调用）。
# 两个调用点都紧跟在变量定义之后、`parse_args` 之前——见各自脚本的注释。

# 已通过闸门的标记（避免同一进程内重复询问）。
NOJ_DEPRECATION_ACCEPTED=0

# 打印弃用警告。参数：脚本名、替代命令清单（每行一条，缩进由本函数负责）。
print_deprecation_warning() {
  local script="$1"
  shift
  printf '\n' >&2
  printf '⚠  %s 已废弃（deprecated）\n' "$script" >&2
  printf '   生产运维已迁移到纯 TS 的 noj-cli；本脚本仅为过渡期保留，\n' >&2
  printf '   将在后续版本删除。请改用：\n' >&2
  local line
  for line in "$@"; do
    printf '     - %s\n' "$line" >&2
  done
  printf '\n' >&2
}

# 读取一行确认（优先走 TTY，与 deploy.sh 的 read_prompt 同一策略）。
# 参数：提示语。成功时把输入写入 NOJ_DEPRECATION_ANSWER。
read_deprecation_answer() {
  local prompt="$1" tty_path="${NOJ_DEPLOY_TTY_PATH:-/dev/tty}"
  if [[ -r "$tty_path" && -w "$tty_path" ]] && (exec 3<>"$tty_path") 2>/dev/null; then
    printf '%s' "$prompt" >"$tty_path"
    IFS= read -r NOJ_DEPRECATION_ANSWER <"$tty_path" || NOJ_DEPRECATION_ANSWER=""
    printf '\n' >"$tty_path"
    return 0
  fi
  if [[ -t 0 ]]; then
    IFS= read -r -p "$prompt" NOJ_DEPRECATION_ANSWER || NOJ_DEPRECATION_ANSWER=""
    printf '\n' >&2
    return 0
  fi
  # 无可用输入通道：由调用方按"非 TTY"处理。
  return 1
}

# 判断是否处于可交互环境（有 TTY 可用）。
has_deprecation_tty() {
  local tty_path="${NOJ_DEPLOY_TTY_PATH:-/dev/tty}"
  [[ -r "$tty_path" && -w "$tty_path" ]] && (exec 3<>"$tty_path") 2>/dev/null && return 0
  [[ -t 0 ]]
}

#
# 闸门入口。参数：脚本名、替代命令…（至少一条）。
#
# 通过时返回 0；用户取消时以退出码 0 结束进程；非 TTY 且未显式接受时以退出码 2
# 结束进程（**不是** return——必须确保调用方无法继续执行任何动作）。
#
require_deprecation_acceptance() {
  [[ "$NOJ_DEPRECATION_ACCEPTED" == "1" ]] && return 0
  local script="$1"
  shift

  # 3. 显式接受（供过渡期自动化脚本）
  if [[ "${NOJ_ACCEPT_DEPRECATED:-0}" == "1" ]]; then
    printf '! %s：已通过 NOJ_ACCEPT_DEPRECATED=1 跳过弃用确认\n' "$script" >&2
    NOJ_DEPRECATION_ACCEPTED=1
    return 0
  fi

  print_deprecation_warning "$script" "$@"

  # 4. 非 TTY 且未显式接受 → 明确报错，**绝不挂起**
  if ! has_deprecation_tty; then
    printf '✗ %s：检测到非交互环境，无法确认弃用提示。\n' "$script" >&2
    printf '   自动化环境请显式设置 NOJ_ACCEPT_DEPRECATED=1（表示已知晓且接受），\n' >&2
    printf '   或改用 noj-cli。\n' >&2
    exit 2
  fi

  # 2. 要求输入 y；非 y → 无副作用退出（退出码 0：用户主动取消不是错误）
  if ! read_deprecation_answer "继续执行已废弃的 $script？输入 y 确认 [y/N]: "; then
    printf '✗ %s：无法读取确认输入。\n' "$script" >&2
    exit 2
  fi
  case "$NOJ_DEPRECATION_ANSWER" in
    y|Y)
      NOJ_DEPRECATION_ACCEPTED=1
      return 0
      ;;
    *)
      printf '已取消：未执行任何操作（%s）\n' "$script" >&2
      exit 0
      ;;
  esac
}
