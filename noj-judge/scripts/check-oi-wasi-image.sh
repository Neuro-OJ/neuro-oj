#!/usr/bin/env bash
# 验收真实生产 runtime 层：SDK 依赖与非 root/只读/禁网配置必须兼容。
set -euo pipefail
cd "$(dirname "$0")/.."
docker build --target wasi-runtime -t noj-oi-wasi-runtime-check -f Dockerfile .
docker run --rm -i --user 10001:10001 --cap-drop ALL --network none \
  --read-only --tmpfs /tmp --security-opt no-new-privileges:true \
  --entrypoint /bin/sh noj-oi-wasi-runtime-check -s <<'SCRIPT'
set -eu
cd /tmp
printf '%s\n' '#include <iostream>' 'int main(){std::cout<<42<<std::endl;}' > main.cpp
"$JUDGE_WASI_CXX" --target="$JUDGE_WASI_TARGET" --sysroot="$JUDGE_WASI_SYSROOT" \
  -std=c++11 -fno-exceptions -Wl,--threads=1 main.cpp -o main.wasm
test -s main.wasm
printf '%s\n' '生产 runtime SDK：非 root、只读根目录、禁网条件下 C++ 编译通过'
SCRIPT
