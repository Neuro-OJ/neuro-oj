/** 独立 Worker 的 OI 环境默认值；配置文件与 Compose 渲染使用同一份定义。 */
export const OI_ENV_DEFAULTS: Readonly<Record<string, string>> = {
  JUDGE_OI_IMAGE: "noj-oi-cpp",
  JUDGE_GO_JUDGE_URL: "",
  JUDGE_GO_JUDGE_TOKEN: "",
  JUDGE_GO_JUDGE_RESOURCE_CAPACITY: "2",
  JUDGE_GO_JUDGE_RESOURCE_TTL_MS: "660000",
  JUDGE_GO_JUDGE_RESOURCE_WAIT_MS: "300000",
  JUDGE_GO_JUDGE_RESOURCE_KEY: "noj:judge:oi:go-judge",
  JUDGE_WASI_CC: "/opt/wasi-sdk/bin/clang",
  JUDGE_WASI_CXX: "/opt/wasi-sdk/bin/clang++",
  JUDGE_WASI_TARGET: "wasm32-wasip1",
  JUDGE_WASI_SYSROOT: "/opt/wasi-sdk/share/wasi-sysroot",
  JUDGE_WASI_TESTLIB_INCLUDE: "",
};
