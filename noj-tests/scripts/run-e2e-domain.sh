#!/usr/bin/env bash
set -euo pipefail

domain="$1"
cd "$(dirname "$0")/.."
deno test -A --env-file=../env.e2e.template "e2e/$domain/"
