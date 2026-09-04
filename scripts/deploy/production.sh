#!/usr/bin/env bash
#
# noj-cli 的生产运维内部驱动（兼容现有 .env.prod 部署）。
#
# 该入口只负责命令路由；配置校验、备份、健康检查和 Docker Compose
# 生命周期逻辑统一由 scripts/deploy/deploy.sh 实现。

set -Eeuo pipefail

SOURCE_FILE="${BASH_SOURCE[0]}"
while [[ -L "$SOURCE_FILE" ]]; do
  SOURCE_DIR="$(cd -P "$(dirname "$SOURCE_FILE")" && pwd)"
  SOURCE_FILE="$(readlink "$SOURCE_FILE")"
  [[ "$SOURCE_FILE" == /* ]] || SOURCE_FILE="$SOURCE_DIR/$SOURCE_FILE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE_FILE")/../.." && pwd)"
DEPLOY_SCRIPT="$SCRIPT_DIR/scripts/deploy/deploy.sh"

usage() {
  cat <<'EOF'
Neuro OJ 生产运维命令

用法：
  noj-cli <命令> [选项]

常用命令：
  install                 首次初始化配置并部署
  check                   检查 Linux、Docker、Compose、磁盘和端口
  start                   启动生产服务
  stop                    停止服务（保留数据卷）
  restart                 重启服务（先停止，再启动）
  uninstall [--yes]      删除容器、网络和本地镜像（保留数据卷）
  uninstall --all        完全删除 NOJ 及全部数据（不可恢复）
  update                  按 .env.prod 中的 NOJ_VERSION 升级
  update --latest         升级到最新稳定 Release（不含 RC/预发布）
  status                  查看服务状态
  logs [service]          查看服务日志（支持 --follow）
  backup                  创建完整生产备份
  verify                  校验生产镜像和配置
  config check            只检查生产配置，不改变服务状态

示例：
  noj-cli install
  noj-cli update
  noj-cli update --latest
  noj-cli status
  noj-cli logs core --follow
  noj-cli backup --passphrase-file /etc/noj/backup-passphrase
  noj-cli config check
  noj-cli uninstall
  noj-cli uninstall --all

说明：
  update 会先同步对应版本的部署文件和 noj-cli 命令，再执行带备份的服务升级；默认版本来自 .env.prod。
  update --latest 会查询最新稳定 Release；当前已是最新版本时不重启服务、不创建升级备份。
  首次 install 或 upgrade 会自动准备 /etc/noj/backup-passphrase；也可通过 --passphrase-file 指定已有口令文件。
  uninstall 会要求输入 UNINSTALL 确认；自动化环境请使用 uninstall --yes。它不会删除数据卷、配置、备份或部署目录。
  uninstall --all 会要求输入 DELETE ALL 确认；自动化环境请使用 uninstall --all --yes。它会删除当前安装目录和全部数据，且不可恢复。
  install 成功后会自动注册 PATH 命令；优先使用 /usr/local/bin，权限不足时使用 ~/.local/bin。
  deploy.sh 仍可用于高级选项；noj 会把支持的选项原样传递给它。
  生产配置默认是 .env.prod，Compose 文件默认是 docker-compose.prod.yml。
EOF
}

fail() {
  printf '✗ %s\n' "$*" >&2
  exit 2
}

ok() { printf '✓ %s\n' "$*"; }
warn() { printf '! %s\n' "$*" >&2; }

link_command() {
  local bin_dir="$1" command_path="$1/noj-cli" target="$SCRIPT_DIR/bin/noj-cli" existing
  if [[ -L "$command_path" ]]; then
    existing="$(readlink "$command_path" 2>/dev/null || true)"
    [[ "$existing" == "$target" ]] && return 0
    return 2
  fi
  [[ ! -e "$command_path" ]] || return 2
  mkdir -p "$bin_dir" 2>/dev/null || return 1
  ln -s "$target" "$command_path" 2>/dev/null || return 1
}

add_user_path() {
  local user_home="${HOME:-}" profile path_line
  [[ -n "$user_home" ]] || return 1
  profile="$user_home/.profile"
  path_line='export PATH="$HOME/.local/bin:$PATH"'
  touch "$profile" 2>/dev/null || return 1
  if ! grep -Fqx -- "$path_line" "$profile" 2>/dev/null; then
    printf '\n# Neuro OJ command\n%s\n' "$path_line" >>"$profile" || return 1
  fi
}

register_command() {
  [[ -x "$SCRIPT_DIR/bin/noj-cli" ]] || {
    warn "当前为源码运行模式，未注册 PATH；安装版 CLI 位于 bin/noj-cli"
    return 0
  }
  local global_bin="${NOJ_BIN_DIR:-/usr/local/bin}" user_bin user_home link_status
  if link_command "$global_bin"; then
    ok "已注册全局命令：$global_bin/noj-cli"
    return 0
  else
    link_status=$?
    if ((link_status == 2)); then
      warn "未覆盖已有命令：$global_bin/noj-cli"
      return 0
    fi
  fi

  user_home="${HOME:-}"
  user_bin="$user_home/.local/bin"
  if [[ -n "$user_home" ]] && link_command "$user_bin"; then
    if add_user_path; then
      ok "已注册用户命令：$user_bin/noj-cli；重新登录后可直接执行 noj-cli"
    else
      warn "已创建用户命令：$user_bin/noj-cli，但无法自动更新 PATH，请手动将其加入 PATH"
    fi
    return 0
  else
    link_status=$?
    if ((link_status == 2)); then
      warn "未覆盖已有命令：$user_bin/noj-cli"
      return 0
    fi
  fi
  warn "无法注册 noj-cli 到 PATH；部署已完成，可直接运行 $SCRIPT_DIR/bin/noj-cli"
}

symlink_points_to_current_install() {
  local command_path="$1" target target_dir target_name resolved
  [[ -L "$command_path" ]] || return 1
  target="$(readlink "$command_path" 2>/dev/null || true)"
  [[ -n "$target" ]] || return 1
  if [[ "$target" == /* ]]; then
    resolved="$target"
  else
    target_dir="$(cd -P "$(dirname "$command_path")" && cd -P "$(dirname "$target")" && pwd)"
    target_name="$(basename "$target")"
    resolved="$target_dir/$target_name"
  fi
  [[ "$resolved" == "$SCRIPT_DIR/bin/noj-cli" || "$resolved" == "$SCRIPT_DIR/noj" ]]
}

unregister_command() {
  local command_path removed=0
  local -a command_paths=()
  [[ -n "${NOJ_BIN_DIR:-}" ]] && command_paths+=("$NOJ_BIN_DIR/noj-cli")
  [[ -n "${NOJ_BIN_DIR:-}" ]] && command_paths+=("$NOJ_BIN_DIR/noj")
  command_paths+=("/usr/local/bin/noj-cli")
  command_paths+=("/usr/local/bin/noj")
  [[ -n "${HOME:-}" ]] && command_paths+=("$HOME/.local/bin/noj-cli")
  [[ -n "${HOME:-}" ]] && command_paths+=("$HOME/.local/bin/noj")
  for command_path in "${command_paths[@]}"; do
    [[ -L "$command_path" ]] || continue
    symlink_points_to_current_install "$command_path" || continue
    rm -f -- "$command_path" || fail "无法移除 PATH 命令软链接：$command_path"
    ok "已移除 PATH 命令：$command_path"
    removed=1
  done
  ((removed)) || warn "未找到指向当前安装目录的 PATH 命令软链接"
}

validate_install_directory() {
  [[ -d "$SCRIPT_DIR" && ! -L "$SCRIPT_DIR" ]] ||
    fail "当前安装目录不存在或不是普通目录：$SCRIPT_DIR"
  [[ -f "$SCRIPT_DIR/bin/noj-cli" && -f "$DEPLOY_SCRIPT" && -f "$SCRIPT_DIR/docker-compose.prod.yml" ]] ||
    fail "当前目录不是完整的 NOJ 安装目录，拒绝完全删除：$SCRIPT_DIR"
  [[ ! -e "$SCRIPT_DIR/.git" && ! -e "$SCRIPT_DIR/.jj" ]] ||
    fail "检测到 Git 工作区，拒绝删除源码目录；请在生产安装目录执行 uninstall --all"
  [[ "$SCRIPT_DIR" != / && "$SCRIPT_DIR" != "." && "$SCRIPT_DIR" != ".." && "$SCRIPT_DIR" != "${HOME:-}" ]] ||
    fail "拒绝删除危险安装路径：$SCRIPT_DIR"
}

remove_install_directory() {
  validate_install_directory
  rm -rf -- "$SCRIPT_DIR" || fail "无法删除 NOJ 安装目录：$SCRIPT_DIR"
  ok "已删除 NOJ 安装目录：$SCRIPT_DIR"
}

require_deploy_script() {
  [[ -f "$DEPLOY_SCRIPT" ]] ||
    fail "未找到生产部署脚本：${DEPLOY_SCRIPT}；请在 NOJ 安装目录中执行 noj-cli"
  [[ -r "$DEPLOY_SCRIPT" ]] || fail "生产部署脚本不可读：$DEPLOY_SCRIPT"
}

run_deploy() {
  require_deploy_script
  bash "$DEPLOY_SCRIPT" "$@"
}

run_bootstrap_check() {
  local bootstrap="$SCRIPT_DIR/scripts/deploy/install.sh"
  [[ -f "$bootstrap" ]] || fail "未找到环境检查脚本：$bootstrap"
  bash "$bootstrap" check "$@"
}

run_files_sync() {
  local bootstrap status
  bootstrap="$(mktemp "${TMPDIR:-/tmp}/noj-update-bootstrap.XXXXXX")" ||
    fail "无法创建更新 bootstrap 临时文件"
  if ! cp -- "$SCRIPT_DIR/scripts/deploy/install.sh" "$bootstrap"; then
    rm -f -- "$bootstrap"
    fail "无法准备更新 bootstrap 临时文件"
  fi
  chmod 700 "$bootstrap"
  set +e
  NOJ_BOOTSTRAP_BIN_DIR="${NOJ_BIN_DIR:-/usr/local/bin}" \
    bash "$bootstrap" "$@"
  status=$?
  set -e
  rm -f -- "$bootstrap"
  return "$status"
}

configured_version() {
  local env_file="${1:-$SCRIPT_DIR/.env.prod}" version
  [[ -f "$env_file" ]] || fail "未找到生产配置：$env_file"
  version="$(awk '
    index($0, "NOJ_VERSION=") == 1 { print substr($0, 13); exit }
  ' "$env_file")"
  case "$version" in
    "\""*"\""|"'"*"'") version="${version:1:${#version}-2}" ;;
  esac
  [[ -n "$version" ]] || fail "生产配置缺少 NOJ_VERSION：$env_file"
  printf '%s\n' "$version"
}

json_field() {
  local key="$1"
  awk -v key="$key" '
    {
      pattern = "\\\"" key "\\\"[[:space:]]*:[[:space:]]*"
      if (match($0, pattern)) {
        value = substr($0, RSTART + RLENGTH)
        sub(/[,}].*$/, "", value)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
        gsub(/^\"|\"$/, "", value)
        print value
        exit
      }
    }
  '
}

validate_release_tag() {
  local version="$1"
  [[ "$version" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
    fail "GitHub Release 不是稳定版本标签：${version}；请使用固定版本升级 RC/预发布版本"
}

latest_release_version() {
  local repository metadata_url metadata tag draft prerelease
  repository="${NOJ_UPDATE_REPOSITORY:-https://github.com/Neuro-OJ/neuro-oj}"
  repository="${repository%/}"
  if [[ -n "${NOJ_UPDATE_API_URL:-}" ]]; then
    metadata_url="$NOJ_UPDATE_API_URL"
  else
    [[ "$repository" =~ ^https://github\.com/([^/]+/[^/]+)$ ]] ||
      fail "无法自动获取最新版本；请使用 NOJ_UPDATE_API_URL 或固定版本升级"
    metadata_url="https://api.github.com/repos/${BASH_REMATCH[1]}/releases/latest"
  fi
  [[ "$metadata_url" == https://* ]] ||
    fail "最新版本 API 地址必须使用 HTTPS"

  printf '正在获取最新稳定 Release\n' >&2
  if command -v curl >/dev/null 2>&1; then
    metadata="$(curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
      --retry 3 --connect-timeout 15 --header 'Accept: application/vnd.github+json' \
      --header 'User-Agent: neuro-oj-updater' "$metadata_url")" ||
      fail "无法获取最新稳定 Release，请检查网络，或使用固定版本重试"
  elif command -v wget >/dev/null 2>&1; then
    metadata="$(wget --https-only --tries=3 --timeout=20 --quiet \
      --header='Accept: application/vnd.github+json' --header='User-Agent: neuro-oj-updater' \
      -O - "$metadata_url")" ||
      fail "无法获取最新稳定 Release，请检查网络，或使用固定版本重试"
  else
    fail "需要 curl 或 wget 才能查询最新稳定 Release"
  fi

  tag="$(json_field tag_name <<<"$metadata")"
  draft="$(json_field draft <<<"$metadata")"
  prerelease="$(json_field prerelease <<<"$metadata")"
  [[ -n "$tag" && "$draft" == false && "$prerelease" == false ]] ||
    fail "GitHub 返回的最新 Release 无效或仍是预发布版本"
  validate_release_tag "$tag"
  printf '%s\n' "$tag"
}

write_config_version() {
  local env_file="$1" version="$2" temp_file
  temp_file="$(mktemp "${env_file}.version.XXXXXX")" ||
    fail "无法创建版本配置暂存文件"
  if ! awk -v version="$version" '
    BEGIN { found = 0 }
    index($0, "NOJ_VERSION=") == 1 {
      print "NOJ_VERSION=" version
      found = 1
      next
    }
    { print }
    END { if (!found) print "NOJ_VERSION=" version }
  ' "$env_file" >"$temp_file"; then
    rm -f -- "$temp_file"
    fail "写入版本配置暂存文件失败"
  fi
  chmod 600 "$temp_file"
  mv -- "$temp_file" "$env_file" || fail "写入版本配置暂存文件失败"
}

update() {
  local latest=0 version current env_file="$SCRIPT_DIR/.env.prod"
  local sync_dry_run=0 stage_file="" status
  local -a original_args=("$@")
  local -a sync_args=()
  local -a deploy_args=()
  require_deploy_script

  while (($# > 0)); do
    case "$1" in
      --latest)
        latest=1
        ;;
      --env-file)
        (($# >= 2)) || fail "--env-file 需要一个文件路径"
        env_file="$2"
        shift
        ;;
      --env-file=*)
        env_file="${1#*=}"
        ;;
      *)
        deploy_args+=("$1")
        ;;
    esac
    shift
  done

  if (( !latest )); then
    version="$(configured_version "$env_file")"
    sync_args=(--ref "$version" --dir "$SCRIPT_DIR" --files-only)
    for arg in "${original_args[@]}"; do
      [[ "$arg" == "--dry-run" ]] && sync_dry_run=1
    done
    ((sync_dry_run)) && sync_args+=(--dry-run)
    printf '同步生产部署文件：%s\n' "$version"
    run_files_sync "${sync_args[@]}"
    run_deploy upgrade "${original_args[@]}"
    return 0
  fi

  current="$(configured_version "$env_file")"
  version="$(latest_release_version)"
  printf '当前生产版本：%s\n' "$current"
  printf '最新稳定版本：%s\n' "$version"
  if [[ "$version" == "$current" ]]; then
    ok "当前已经是最新稳定 Release，无需升级"
    return 0
  fi

  [[ -f "$SCRIPT_DIR/scripts/deploy/install.sh" ]] ||
    fail "未找到部署文件更新脚本：$SCRIPT_DIR/scripts/deploy/install.sh"

  stage_file="$(mktemp "${env_file}.latest.XXXXXX")" ||
    fail "无法创建版本配置暂存文件"
  if ! cp -- "$env_file" "$stage_file"; then
    rm -f -- "$stage_file"
    fail "无法复制生产配置到暂存文件"
  fi
  write_config_version "$stage_file" "$version"

  for arg in "${original_args[@]}"; do
    [[ "$arg" == "--dry-run" ]] && sync_dry_run=1
  done
  sync_args=(--ref "$version" --dir "$SCRIPT_DIR" --files-only)
  ((sync_dry_run)) && sync_args+=(--dry-run)
  printf '同步生产部署文件：%s\n' "$version"
  if run_files_sync "${sync_args[@]}"; then
    :
  else
    status=$?
    rm -f -- "$stage_file"
    return "$status"
  fi

  deploy_args+=(--env-file "$stage_file")
  if run_deploy upgrade "${deploy_args[@]}"; then
    if ((sync_dry_run)); then
      rm -f -- "$stage_file"
      ok "[dry-run] 将升级到最新稳定 Release：$version"
      return 0
    fi
    chmod 600 "$stage_file"
    mv -- "$stage_file" "$env_file" || fail "升级成功但无法提交生产版本配置"
    ok "已升级到最新稳定 Release：$version"
  else
    status=$?
    rm -f -- "$stage_file"
    return "$status"
  fi
}

restart() {
  require_deploy_script
  bash "$DEPLOY_SCRIPT" stop "$@"
  bash "$DEPLOY_SCRIPT" start "$@"
}

run_backup_command() {
  local env_file="$SCRIPT_DIR/.env.prod" configured="${NOJ_BACKUP_PASSPHRASE_FILE:-}" value
  local -a args=("$@")
  while (($# > 0)); do
    case "$1" in
      --env-file)
        (($# >= 2)) || fail "--env-file 需要一个文件路径"
        env_file="$2"; shift ;;
      --env-file=*) env_file="${1#*=}" ;;
    esac
    shift
  done
  # 仅解析口令文件路径，不执行 .env，也不读取或输出口令内容。
  if [[ -z "$configured" && -f "$env_file" ]]; then
    value="$(awk -v key='NOJ_BACKUP_PASSPHRASE_FILE=' 'index($0, key) == 1 { print substr($0, length(key) + 1); exit }' "$env_file")"
    case "$value" in
      \"*\"|\'*\') value="${value:1:${#value}-2}" ;;
    esac
    configured="$value"
  fi
  NOJ_BACKUP_PASSPHRASE_FILE="$configured" bash "$SCRIPT_DIR/scripts/deploy/backup.sh" "${args[@]}"
}

main() {
  local command="${1:-}"
  if [[ -z "$command" || "$command" == "-h" || "$command" == "--help" || "$command" == "help" ]]; then
    usage
    [[ -n "$command" ]] || return 2
    return 0
  fi
  shift

  case "$command" in
    check)
      run_bootstrap_check "$@"
      ;;
    install|start|stop|status|logs|verify)
      run_deploy "$command" "$@"
      if [[ "$command" == install && " $* " != *" --dry-run "* ]]; then
        register_command
      fi
      ;;
    backup)
      case "${1:-}" in
        create)
          shift
          run_deploy backup "$@"
          ;;
        verify|restore|drill)
          run_backup_command "$@"
          ;;
        *) run_deploy backup "$@" ;;
      esac
      ;;
    uninstall)
      local arg dry_run=0
      local remove_all=0
      for arg in "$@"; do
        [[ "$arg" == --dry-run ]] && dry_run=1
        [[ "$arg" == --all ]] && remove_all=1
      done
      # 必须在删除容器和数据卷之前验证完全卸载的目标。
      if ((remove_all && !dry_run)); then validate_install_directory; fi
      run_deploy uninstall "$@"
      if (( !dry_run )); then
        unregister_command
        if ((remove_all)); then
          remove_install_directory
        fi
      fi
      ;;
    update|upgrade)
      update "$@"
      ;;
    restart)
      restart "$@"
      ;;
    config)
      [[ "${1:-}" == "check" ]] || {
        usage >&2
        fail "config 目前只支持 check"
      }
      shift
      run_deploy config-check "$@"
      ;;
    *)
      usage >&2
      fail "未知命令：$command"
      ;;
  esac
}

main "$@"
