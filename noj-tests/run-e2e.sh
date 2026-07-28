#!/bin/sh
cd "$(dirname "$0")" || exit 1
NOJ_RUN_E2E=1 E2E_BASE_URL=http://localhost:8099 deno task test
