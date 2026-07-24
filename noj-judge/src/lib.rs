//! noj-judge 库入口（用于集成测试）。
//!
//! 将仅二进制 crate 中的模块暴露给集成测试。

pub mod config;
pub mod dual;
pub mod judge;
pub mod pool;
pub mod sandbox;
pub mod types;

/// 将 stdout 和 stderr 合并为单一输出字符串，中间以分隔符连接。
///
/// stderr 为空时直接返回 stdout，避免添加不必要的分隔符。
pub fn merge_output(stdout: &str, stderr: &str) -> String {
    if stderr.is_empty() {
        stdout.to_string()
    } else {
        format!("{}\n--- STDERR ---\n{}", stdout, stderr)
    }
}
