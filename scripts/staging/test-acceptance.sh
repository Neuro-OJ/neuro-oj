#!/usr/bin/env bash
# staging 验收编排脚本的无 Docker 回归测试。
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

FAKE_DOCKER="$TEST_DIR/fake-docker"
ENV_FILE="$TEST_DIR/.env.prod"
COMPOSE_FILE="$TEST_DIR/docker-compose.prod.yml"
ARTIFACT_DIR="$TEST_DIR/artifacts"
LOG_FILE="$TEST_DIR/docker.log"

cat > "$FAKE_DOCKER" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >> "${NOJ_STAGING_TEST_LOG:?}"
if [[ "${1:-}" == "info" || "${1:-}" == "compose" && "${2:-}" == "version" ]]; then
  exit 0
fi
if [[ "${1:-}" == "compose" && "$*" == *" ps "* ]]; then
  printf 'NAME SERVICE STATUS\n'
  exit 0
fi
if [[ "${1:-}" == "compose" && "$*" == *" logs "* ]]; then
  printf 'simulated compose log\n'
  exit 0
fi
if [[ "${1:-}" == "compose" && "${NOJ_STAGING_TEST_FAIL:-}" == "compose-up" && "$*" == *" up "* ]]; then
  exit 23
fi
exit 0
EOF
chmod +x "$FAKE_DOCKER"

cat > "$ENV_FILE" <<'EOF'
NOJ_VERSION=v0.1.0
POSTGRES_PASSWORD=test-password
REDIS_PASSWORD=test-password
JWT_SECRET=12345678901234567890123456789012
TFA_ENCRYPTION_KEY=12345678901234567890123456789012
NOJ_LLM_SERVICE_TOKEN=test-token
NOJ_LLM_STORE_KEY=test-store-key
APP_URL=http://localhost:8080
CORS_ALLOWED_ORIGINS=http://localhost:8080
TRUSTED_PROXIES=127.0.0.1
STORAGE_PROVIDER=local
S3_ACCESS_KEY=test-access
S3_SECRET_KEY=test-secret
S3_BUCKET=test-bucket
EMAIL_PROVIDER=mock
ADMIN_EMAIL=admin@example.com
ADMIN_PASS=test-password
JUDGE_DOCKER_SOCKET=/tmp/docker.sock
JUDGE_DOCKER_SOCKET_GID=0
EOF
chmod 600 "$ENV_FILE"

cat > "$COMPOSE_FILE" <<'EOF'
services:
  test:
    image: alpine:3.20
EOF

run_acceptance() {
  NOJ_STAGING_TEST_LOG="$LOG_FILE" \
    STAGING_DOCKER_BIN="$FAKE_DOCKER" \
    STAGING_ALLOW_DIRTY=1 \
    STAGING_ALLOW_ANY_CLEAN_REF=1 \
    STAGING_IMAGE_TAG=v0.1.0 \
    STAGING_ARTIFACT_DIR="$ARTIFACT_DIR" \
    "$ROOT_DIR/scripts/staging/acceptance.sh" "$@" \
    --env-file "$ENV_FILE" \
    --compose-file "$COMPOSE_FILE" \
    --artifact-dir "$ARTIFACT_DIR"
}

run_acceptance --help >/dev/null
run_acceptance check
grep -q 'compose' "$LOG_FILE"

if NOJ_STAGING_TEST_FAIL=compose-up run_acceptance up; then
  printf '预期 compose up 失败，但命令成功\n' >&2
  exit 1
fi
[[ -s "$ARTIFACT_DIR/compose-logs.txt" ]]
[[ -s "$ARTIFACT_DIR/compose-ps.txt" ]]
[[ -s "$ARTIFACT_DIR/metadata.txt" ]]

printf 'staging acceptance script no-Docker tests passed\n'
