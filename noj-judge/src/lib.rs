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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_merge_output_stdout_only() {
        assert_eq!(merge_output("hello", ""), "hello");
    }

    #[test]
    fn test_merge_output_with_stderr() {
        let result = merge_output("stdout line", "stderr line");
        assert_eq!(result, "stdout line\n--- STDERR ---\nstderr line");
    }

    #[test]
    fn test_merge_output_both_empty() {
        assert_eq!(merge_output("", ""), "");
    }

    #[test]
    fn test_merge_output_stderr_only() {
        let result = merge_output("", "error log");
        assert_eq!(result, "\n--- STDERR ---\nerror log");
    }

    #[test]
    fn test_merge_output_multiline() {
        let result = merge_output("line1\nline2", "err1\nerr2");
        assert_eq!(result, "line1\nline2\n--- STDERR ---\nerr1\nerr2");
    }
}
