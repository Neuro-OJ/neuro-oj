#!/bin/sh
cd /home/xyber-nova/Github/neuro-oj/noj-tests && \
NOJ_RUN_E2E=1 E2E_BASE_URL=http://localhost:8099 deno test -A e2e/e2e.test.ts
